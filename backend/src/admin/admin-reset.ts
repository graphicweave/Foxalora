import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Database } from '../database/schema';
import { TenantDb } from '../database/tenant-db';
import { hashAdminPassword } from '../setup/admin-password';
import { endAdminSessions } from './admin-session.service';
import { base32Encode } from './totp';

/** A new random password such as "K7QM2-XD9PB-A4TRW-6NZEH": 100 bits, easy to read out and type. */
export function newAdminPassword(): string {
  return base32Encode(randomBytes(13)).slice(0, 20).match(/.{5}/g)!.join('-');
}

/**
 * Operator password reset (forgotten administrator password). Sets a new random password, ends the
 * administrator's open sessions and writes an audit entry. The password is returned once for the
 * operator to hand over; it is never logged or audited. Two-step verification stays as it is.
 */
export async function resetAdminPassword(db: Kysely<Database>, redis: Redis | null, email: string, actor: string) {
  const normalized = email.trim().toLowerCase();
  const found = await sql<{ id: string; tenant_id: string }>`SELECT id, tenant_id FROM admin_login_lookup(${normalized})`.execute(db);
  const admin = found.rows[0];
  if (!admin) throw new Error(`no administrator ${normalized} in an active tenant`);
  const password = newAdminPassword();
  const passwordHash = await hashAdminPassword(password);
  const tenantDb = new TenantDb(db);
  await tenantDb.run({ tenantId: admin.tenant_id }, async (trx) => {
    await trx.updateTable('admin_users').set({ password_hash: passwordHash, updated_at: new Date() }).where('id', '=', admin.id).execute();
    await new AuditService(tenantDb).insert(trx, admin.tenant_id, 'admin.password_reset', actor, { admin: normalized });
  });
  const sessionsEnded = redis ? await endAdminSessions(redis, admin.id) : null;
  return { password, sessionsEnded };
}
