import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, stepAt } from '../src/admin/totp';
import { MailService } from '../src/mail/mail.service';
import { hashAdminPassword } from '../src/setup/admin-password';
import { createTestDatabase, hasPg, type TestDatabase } from './helpers/pg';

const VALKEY = process.env.FOXALORA_TEST_VALKEY_URL ?? '';
const PW_A = `Admin-A-${randomBytes(6).toString('hex')}`;
const PW_B = `Admin-B-${randomBytes(6).toString('hex')}`;
const MAILBOX_PW = `mb-${randomBytes(6).toString('hex')}`;

class FakeMail {
  async verifyLogin({ password }: { password: string }) {
    if (password !== MAILBOX_PW) throw Object.assign(new Error('auth failed'), { code: 'EAUTH' });
  }
}

interface Res { status: number; json: any; text: string; headers: Headers }

/** Admin console (E12): FOX-081 separate admin auth, FOX-134 two-step, FOX-006/007 registry, FOX-085 audit. */
describe.skipIf(!hasPg || !VALKEY)('admin console over HTTP', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let base = '';
  let redis: Redis;
  const ids: Record<string, string> = {};

  const call = async (method: string, path: string, opts: { cookie?: string; body?: unknown; csrf?: boolean } = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.csrf === false ? {} : { 'X-Requested-With': 'foxalora' }),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* csv or empty */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const adminCookie = (r: Res) => {
    const v = /fx_admin=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
    return v ? `fx_admin=${v}` : '';
  };
  const codeFor = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), stepAt(Date.now()) + offsetSteps);

  /** Signs in fully; enrolls two-step on first use. Returns the full-stage cookie. */
  const secrets: Record<string, string> = {};
  const backup: Record<string, string[]> = {};
  async function signIn(email: string, password: string, codeOffset = 0): Promise<string> {
    const login = await call('POST', '/admin/auth/login', { body: { email, password } });
    expect(login.status).toBe(200);
    const pending = adminCookie(login);
    if (login.json.next === 'enroll') {
      const e = await call('POST', '/admin/auth/enroll', { cookie: pending });
      expect(e.status).toBe(200);
      secrets[email] = e.json.secret;
    }
    const v = await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: codeFor(secrets[email], codeOffset) } });
    expect(v.status).toBe(200);
    if (v.json.backupCodes) backup[email] = v.json.backupCodes;
    return adminCookie(v);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const [name, domain, email, pw] of [['A', 'a.example', 'admin@a.example', PW_A], ['B', 'b.example', 'admin@b.example', PW_B]]) {
      const tn = await t.owner.insertInto('tenants').values({ name }).returning('id').executeTakeFirstOrThrow();
      const s = await t.owner.insertInto('mail_servers').values({
        tenant_id: tn.id, name: 'main', imap_host: `mail.${domain}`, imap_port: 993, imap_tls: 'tls',
        smtp_host: `mail.${domain}`, smtp_port: 465, smtp_tls: 'tls', allow_private: false,
      }).returning('id').executeTakeFirstOrThrow();
      await t.owner.insertInto('domain_mappings').values({ tenant_id: tn.id, domain, mail_server_id: s.id }).execute();
      await t.owner.insertInto('admin_users').values({ tenant_id: tn.id, email, password_hash: await hashAdminPassword(pw), role: 'owner' }).execute();
      ids[`tenant${name}`] = tn.id;
      ids[`server${name}`] = s.id;
    }
    const valkeyUrl = new URL(VALKEY);
    valkeyUrl.pathname = '/15';
    Object.assign(process.env, {
      DATABASE_URL: t.appUrl,
      VALKEY_URL: valkeyUrl.toString(),
      FOXALORA_VAULT_KEYS: `e2e:${randomBytes(32).toString('base64')}`,
      FOXALORA_MASTER_KEYS: `m1:${randomBytes(32).toString('base64')}`,
      LOGIN_MIN_FAILURE_MS: '0',
    });
    redis = new Redis(valkeyUrl.toString());
    await redis.flushdb();
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/http');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailService).useValue(new FakeMail()).compile();
    app = mod.createNestApplication({ bodyParser: false, logger: false });
    Logger.overrideLogger(false);
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await app?.close();
    await redis?.flushdb();
    redis?.disconnect();
    await t?.drop();
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const a = await call('POST', '/admin/auth/login', { body: { email: 'nobody@a.example', password: 'x'.repeat(12) } });
    const b = await call('POST', '/admin/auth/login', { body: { email: 'admin@a.example', password: 'wrong-password-1' } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json.error.message).toBe(b.json.error.message);
  });

  it('requires two-step verification before anything else works', async () => {
    const login = await call('POST', '/admin/auth/login', { body: { email: 'admin@a.example', password: PW_A } });
    expect(login.json.next).toBe('enroll');
    const pending = adminCookie(login);
    expect((await call('GET', '/admin/servers', { cookie: pending })).status).toBe(401);
    expect((await call('GET', '/admin/auth/me', { cookie: pending })).json.stage).toBe('password');

    const e = await call('POST', '/admin/auth/enroll', { cookie: pending });
    expect(e.json.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.json.qrSvg).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(e.json.otpauthUrl).toContain('otpauth://totp/');
    const stored = await t.owner.selectFrom('admin_users').select(['totp_secret', 'totp_enabled_at']).where('email', '=', 'admin@a.example').executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.totp_secret)).not.toContain(e.json.secret); // encrypted at rest
    expect(stored.totp_enabled_at).toBeNull(); // not active until a code is confirmed

    expect((await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: '000000' } })).status).toBe(401);
    const v = await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: codeFor(e.json.secret) } });
    expect(v.status).toBe(200);
    expect(v.json.backupCodes).toHaveLength(10);
    const full = adminCookie(v);
    expect(full).not.toBe(pending); // new session id after the second factor
    expect((await call('GET', '/admin/servers', { cookie: pending })).status).toBe(401);
    expect((await call('GET', '/admin/servers', { cookie: full })).status).toBe(200);
    secrets['admin@a.example'] = e.json.secret;
    backup['admin@a.example'] = v.json.backupCodes;
  });

  it('refuses a code that was already used, and accepts each backup code once', async () => {
    const login = await call('POST', '/admin/auth/login', { body: { email: 'admin@a.example', password: PW_A } });
    expect(login.json.next).toBe('code');
    const pending = adminCookie(login);
    // The code just used for enrollment is still inside its time window, but works only once.
    expect((await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: codeFor(secrets['admin@a.example']) } })).status).toBe(401);
    const used = backup['admin@a.example'][0];
    expect((await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: used.toLowerCase() } })).status).toBe(200);

    const again = adminCookie(await call('POST', '/admin/auth/login', { body: { email: 'admin@a.example', password: PW_A } }));
    expect((await call('POST', '/admin/auth/verify', { cookie: again, body: { code: used } })).status).toBe(401);
  });

  it('limits wrong codes', async () => {
    await redis.del(...(await redis.keys('fx:af:*')).concat('fx:none'));
    const pending = adminCookie(await call('POST', '/admin/auth/login', { body: { email: 'admin@a.example', password: PW_A } }));
    for (let i = 0; i < 5; i++) expect((await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: '111111' } })).status).toBe(401);
    expect((await call('POST', '/admin/auth/verify', { cookie: pending, body: { code: codeFor(secrets['admin@a.example'], 1) } })).status).toBe(429);
    await redis.del(...(await redis.keys('fx:af:*')).concat('fx:none'));
  });

  it('keeps admin and mailbox sessions apart, and needs the CSRF header', async () => {
    const mailbox = await call('POST', '/auth/login', { body: { email: 'user@a.example', password: MAILBOX_PW } });
    expect(mailbox.status).toBe(200);
    const sid = /fx_sid=([^;]+)/.exec(mailbox.headers.get('set-cookie') ?? '')?.[1];
    expect((await call('GET', '/admin/servers', { cookie: `fx_admin=${sid}` })).status).toBe(401);
    expect((await call('GET', '/admin/servers', { cookie: `fx_sid=${sid}` })).status).toBe(401);

    const admin = await signIn('admin@a.example', PW_A, 1);
    const asMailbox = admin.replace('fx_admin=', 'fx_sid=');
    expect((await call('GET', '/messages', { cookie: asMailbox })).status).toBe(401);
    expect((await call('POST', '/admin/domains', { cookie: admin, body: { domain: 'x.a.example', serverId: ids.serverA }, csrf: false })).status).toBe(403);
  });

  it('manages servers and domains, and audits every change', async () => {
    await redis.del(...(await redis.keys('fx:au:*')).concat('fx:none'));
    const admin = await signIn('admin@a.example', PW_A, -1);
    const created = await call('POST', '/admin/servers', { cookie: admin, body: { name: 'second', imapHost: 'imap.a2.example', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.a2.example', smtpPort: 465, smtpTls: 'tls' } });
    expect(created.status).toBe(201);
    const id = created.json.id;
    expect((await call('POST', '/admin/servers', { cookie: admin, body: { name: 'bad', imapHost: 'imap.x.example', imapPort: 25, imapTls: 'tls', smtpPort: 465, smtpTls: 'tls' } })).status).toBe(400);
    expect((await call('PUT', `/admin/servers/${id}`, { cookie: admin, body: { name: 'second', imapHost: 'imap.a2.example', imapPort: 143, imapTls: 'starttls', smtpHost: 'smtp.a2.example', smtpPort: 587, smtpTls: 'starttls', savesSent: true } })).status).toBe(204);

    expect((await call('POST', '/admin/domains', { cookie: admin, body: { domain: 'Sales.A.Example', serverId: id } })).json.domain).toBe('sales.a.example');
    const list = await call('GET', '/admin/servers', { cookie: admin });
    const second = list.json.servers.find((s: any) => s.id === id);
    expect(second).toMatchObject({ imapPort: 143, smtpTls: 'starttls', savesSent: true, domains: ['sales.a.example'] });

    const blocked = await call('DELETE', `/admin/servers/${id}`, { cookie: admin });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.message).toContain('sales.a.example');
    expect((await call('DELETE', '/admin/domains/sales.a.example', { cookie: admin })).status).toBe(204);
    expect((await call('DELETE', `/admin/servers/${id}`, { cookie: admin })).status).toBe(204);

    const audit = await call('GET', '/admin/audit?type=registry.', { cookie: admin });
    const types = audit.json.items.map((e: any) => e.type);
    for (const ty of ['registry.server_created', 'registry.server_updated', 'registry.domain_mapped', 'registry.domain_unmapped', 'registry.server_deleted']) expect(types).toContain(ty);
    expect(audit.json.items.every((e: any) => e.actor === 'admin:admin@a.example')).toBe(true);
    const all = JSON.stringify((await call('GET', '/admin/audit?pageSize=200', { cookie: admin })).json);
    expect(all).not.toContain(PW_A);
    expect(all).not.toContain(secrets['admin@a.example']);

    const csv = await call('GET', '/admin/audit/export?type=registry.', { cookie: admin });
    expect(csv.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(csv.text.split('\r\n')[0]).toBe('time,event,actor,details');
  });

  it("never reaches another tenant's servers, domains or audit log", async () => {
    const adminB = await signIn('admin@b.example', PW_B);
    const b = await call('GET', '/admin/servers', { cookie: adminB });
    expect(b.json.servers.map((s: any) => s.id)).toEqual([ids.serverB]);
    expect(JSON.stringify(b.json)).not.toContain('a.example');
    expect((await call('PUT', `/admin/servers/${ids.serverA}`, { cookie: adminB, body: { name: 'x', imapHost: 'evil.example', imapPort: 993, imapTls: 'tls', smtpPort: 465, smtpTls: 'tls' } })).status).toBe(404);
    expect((await call('DELETE', `/admin/servers/${ids.serverA}`, { cookie: adminB })).status).toBe(404);
    expect((await call('DELETE', '/admin/domains/a.example', { cookie: adminB })).status).toBe(404);
    expect((await call('POST', '/admin/domains', { cookie: adminB, body: { domain: 'new.b.example', serverId: ids.serverA } })).status).toBe(404);
    const taken = await call('POST', '/admin/domains', { cookie: adminB, body: { domain: 'a.example', serverId: ids.serverB } });
    expect(taken.status).toBe(400);
    expect(taken.json.error.message).not.toMatch(/tenant|A\b/);
    const audit = JSON.stringify((await call('GET', '/admin/audit?pageSize=200', { cookie: adminB })).json);
    expect(audit).not.toContain('admin@a.example');
    // Tenant A's data is untouched.
    const a = await t.owner.selectFrom('domain_mappings').select('domain').where('tenant_id', '=', ids.tenantA).execute();
    expect(a.map((d) => d.domain)).toContain('a.example');
  });

  it('ends the admin session on logout', async () => {
    const admin = await signIn('admin@b.example', PW_B, 1);
    expect((await call('POST', '/admin/auth/logout', { cookie: admin })).status).toBe(204);
    expect((await call('GET', '/admin/servers', { cookie: admin })).status).toBe(401);
  });
});
