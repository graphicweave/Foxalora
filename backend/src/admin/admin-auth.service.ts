import { ConflictException, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { DB, VALKEY } from '../common/tokens';
import { envelopeDecrypt, envelopeEncrypt } from '../crypto/envelope';
import { Keyring } from '../crypto/keyring';
import type { Database } from '../database/schema';
import { TenantDb } from '../database/tenant-db';
import { hashAdminPassword, verifyAdminPassword } from '../setup/admin-password';
import type { AdminSession } from './admin-session.service';
import { hashBackupCode, newBackupCodes, newTotpSecret, otpauthUrl, STEP_SECONDS, verifyTotp } from './totp';

const MAX_CODE_FAILURES = 5;
const CODE_FAILURE_WINDOW_S = 15 * 60;
const totpContext = (adminId: string) => `admin_users.totp_secret:${adminId}`;

export class CodeRejected extends Error {}

/**
 * Administrator sign-in (FOX-081) with required two-step verification (FOX-134).
 * The TOTP secret is stored envelope-encrypted with FOXALORA_MASTER_KEYS, bound to the admin row.
 */
@Injectable()
export class AdminAuthService {
  private readonly log = new Logger('AdminAuth');
  private ring: Keyring | null = null;
  // Same cost as a real check, so an unknown email takes as long as a wrong password.
  private readonly dummyHash = hashAdminPassword('timing-equaliser-not-a-real-password');

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(VALKEY) private readonly redis: Redis,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  private masterRing(): Keyring {
    if (!this.ring) {
      try {
        this.ring = Keyring.parse(process.env.FOXALORA_MASTER_KEYS, 'FOXALORA_MASTER_KEYS');
      } catch {
        this.log.error('FOXALORA_MASTER_KEYS is not set: two-step verification cannot be used. Re-run deploy/install.sh.');
        throw new ServiceUnavailableException('The admin console is not configured on this server.');
      }
    }
    return this.ring;
  }

  /** Checks email and password. Unknown email and wrong password take the same time and give the same answer. */
  async checkPassword(email: string, password: string): Promise<{ adminId: string; tenantId: string } | null> {
    const r = await sql<{ id: string; tenant_id: string; password_hash: string }>`SELECT * FROM admin_login_lookup(${email})`.execute(this.db);
    const row = r.rows[0];
    const ok = await verifyAdminPassword(password, row?.password_hash ?? (await this.dummyHash));
    return row && ok ? { adminId: row.id, tenantId: row.tenant_id } : null;
  }

  async account(tenantId: string, adminId: string) {
    return this.tenantDb.run({ tenantId }, (trx) =>
      trx.selectFrom('admin_users').select(['id', 'email', 'role', 'totp_secret', 'totp_enabled_at', 'backup_codes']).where('id', '=', adminId).executeTakeFirst());
  }

  /** Starts (or restarts) enrollment: a new secret, stored encrypted, active only after the first code. */
  async startEnrollment(s: AdminSession, issuer: string) {
    const ring = this.masterRing();
    const acct = await this.account(s.tenantId, s.adminId);
    if (!acct) throw new ConflictException('account not found');
    if (acct.totp_enabled_at) throw new ConflictException('two-step verification is already set up');
    const secret = newTotpSecret();
    const token = envelopeEncrypt(ring, secret, totpContext(s.adminId));
    await this.tenantDb.run({ tenantId: s.tenantId }, (trx) =>
      trx.updateTable('admin_users').set({ totp_secret: JSON.stringify(token), updated_at: new Date() }).where('id', '=', s.adminId).execute());
    const url = otpauthUrl(issuer, s.email, secret);
    const qr = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { secret, otpauthUrl: url, qrSvg: `data:image/svg+xml;base64,${Buffer.from(qr).toString('base64')}` };
  }

  /**
   * Checks a 6-digit code (or, once set up, a backup code). Completes enrollment on the first
   * correct code and returns the backup codes then (shown once). Throws CodeRejected otherwise.
   */
  async verifyCode(s: AdminSession, code: string, ip: string): Promise<{ backupCodes?: string[] }> {
    const ring = this.masterRing();
    const failKey = `fx:af:${s.adminId}`;
    const failures = Number((await this.redis.get(failKey)) ?? 0);
    if (failures >= MAX_CODE_FAILURES) throw new HttpException('Too many wrong codes. Try again in 15 minutes.', 429);

    const acct = await this.account(s.tenantId, s.adminId);
    const tokenRaw = acct?.totp_secret;
    const token = typeof tokenRaw === 'string' ? tokenRaw : null;
    if (!acct || !token) throw new CodeRejected('enrollment not started');
    const secret = envelopeDecrypt(ring, token, totpContext(s.adminId));
    const clean = code.trim().replace(/\s/g, '');

    const reject = async (reason: string): Promise<never> => {
      await this.redis.multi().incr(failKey).expire(failKey, CODE_FAILURE_WINDOW_S).exec();
      await this.audit.record(s.tenantId, 'admin.code_failed', `admin:${s.email}`, { ip, reason });
      throw new CodeRejected(reason);
    };

    if (/^\d{6}$/.test(clean)) {
      const step = verifyTotp(secret, clean);
      if (step === null) return reject('wrong code');
      // Each code works once: a code seen by someone else cannot be replayed within its window.
      const fresh = await this.redis.set(`fx:au:${s.adminId}:${step}`, '1', 'EX', STEP_SECONDS * 4, 'NX');
      if (fresh !== 'OK') return reject('code already used');
    } else if (acct.totp_enabled_at && /^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/.test(clean)) {
      const h = hashBackupCode(clean);
      const left = (acct.backup_codes ?? []).filter((c) => c !== h);
      if (left.length === (acct.backup_codes ?? []).length) return reject('wrong backup code');
      await this.tenantDb.run({ tenantId: s.tenantId }, async (trx) => {
        await trx.updateTable('admin_users').set({ backup_codes: JSON.stringify(left), updated_at: new Date() }).where('id', '=', s.adminId).execute();
        await this.audit.insert(trx, s.tenantId, 'admin.backup_code_used', `admin:${s.email}`, { ip, remaining: left.length });
      });
    } else {
      return reject('invalid code format');
    }

    await this.redis.del(failKey);
    if (acct.totp_enabled_at) return {};
    const backupCodes = newBackupCodes();
    await this.tenantDb.run({ tenantId: s.tenantId }, async (trx) => {
      await trx.updateTable('admin_users')
        .set({ totp_enabled_at: new Date(), backup_codes: JSON.stringify(backupCodes.map(hashBackupCode)), updated_at: new Date() })
        .where('id', '=', s.adminId).execute();
      await this.audit.insert(trx, s.tenantId, 'admin.two_step_enabled', `admin:${s.email}`, { ip });
    });
    return { backupCodes };
  }

  async markSignedIn(s: AdminSession) {
    await this.tenantDb.run({ tenantId: s.tenantId }, (trx) =>
      trx.updateTable('admin_users').set({ last_login_at: new Date() }).where('id', '=', s.adminId).execute());
  }
}
