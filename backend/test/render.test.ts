import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service';
import { renderConfig } from '../src/render/render-config';
import { renderCsp, renderPage } from '../src/render/render.controller';
import { createTestDatabase, hasPg, type TestDatabase } from './helpers/pg';

/** FOX-045: separate-origin render host. */
describe('render origin configuration', () => {
  it('is off unless a render origin or domain is set', () => {
    expect(renderConfig({})).toBeNull();
  });

  it('builds an https origin from the domain', () => {
    expect(renderConfig({ FOXALORA_RENDER_DOMAIN: 'content.mail.example', FOXALORA_APP_ORIGIN: 'https://mail.example' })).toEqual({
      renderOrigin: 'https://content.mail.example', renderHost: 'content.mail.example', appOrigin: 'https://mail.example',
    });
  });

  it('requires the app origin and a different host name (cookies are shared across ports)', () => {
    expect(() => renderConfig({ FOXALORA_RENDER_DOMAIN: 'content.mail.example' })).toThrow(/APP_ORIGIN/);
    expect(() => renderConfig({ FOXALORA_RENDER_ORIGIN: 'https://mail.example:8443', FOXALORA_APP_ORIGIN: 'https://mail.example' })).toThrow(/different host/);
  });

  it('requires https in production', () => {
    expect(() => renderConfig({ NODE_ENV: 'production', FOXALORA_RENDER_ORIGIN: 'http://content.mail.example', FOXALORA_APP_ORIGIN: 'https://mail.example' })).toThrow(/https/);
  });

  it('serves content under a policy without scripts, network or same-origin access', () => {
    const csp = renderCsp('https://mail.example');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data:');
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('frame-ancestors https://mail.example');
    const sandbox = csp.split('; ').find((d) => d.startsWith('sandbox'));
    expect(sandbox).toBe('sandbox allow-popups allow-popups-to-escape-sandbox');
    expect(csp).not.toMatch(/allow-scripts|allow-same-origin|allow-forms|script-src|connect-src/);
    expect(renderPage('<p>hi</p>')).toContain('<body><p>hi</p></body>');
  });
});

const VALKEY = process.env.FOXALORA_TEST_VALKEY_URL ?? '';
const PASSWORD = `pw-${randomBytes(6).toString('hex')}`;
const APP_HOST = 'app.test';
const RENDER_HOST = 'content.app.test';
const HTML = '<p>Quarterly figures <b>attached</b></p>';

class FakeMail {
  async verifyLogin({ password }: { password: string }) {
    if (password !== PASSWORD) throw Object.assign(new Error('auth failed'), { code: 'EAUTH' });
  }
  async getMessage(_c: unknown, id: string) {
    return { id, subject: 'Report', from: [], to: [], cc: [], bcc: [], text: 'Quarterly figures', html: HTML, attachments: [] };
  }
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

describe.skipIf(!hasPg || !VALKEY)('render host over HTTP (FOX-045)', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let port = 0;
  let redis: Redis;
  let cookie = '';

  /** Plain node:http, so the Host header can name the app or the render host. */
  const call = (host: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<Res>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({
        host: '127.0.0.1', port, method, path,
        headers: { Host: host, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}), ...headers },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      req.end(data);
    });

  const clearTokens = async () => {
    const keys = await redis.keys('fx:render:*');
    if (keys.length) await redis.del(...keys);
  };

  const openMessage = async () => {
    const res = await call(APP_HOST, 'GET', '/api/v1/messages/msg-1', { Cookie: cookie });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    return new URL(json.renderUrl as string);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    const tn = await t.owner.insertInto('tenants').values({ name: 'A' }).returning('id').executeTakeFirstOrThrow();
    const s = await t.owner.insertInto('mail_servers').values({
      tenant_id: tn.id, name: 'm', imap_host: 'mail.a.example', imap_port: 993, imap_tls: 'tls',
      smtp_host: 'mail.a.example', smtp_port: 465, smtp_tls: 'tls', allow_private: false,
    }).returning('id').executeTakeFirstOrThrow();
    await t.owner.insertInto('domain_mappings').values({ tenant_id: tn.id, domain: 'a.example', mail_server_id: s.id }).execute();

    const valkeyUrl = new URL(VALKEY);
    valkeyUrl.pathname = '/14'; // own database: tests in other files flush theirs
    Object.assign(process.env, {
      DATABASE_URL: t.appUrl,
      VALKEY_URL: valkeyUrl.toString(),
      FOXALORA_VAULT_KEYS: `e2e:${randomBytes(32).toString('base64')}`,
      LOGIN_MIN_FAILURE_MS: '0',
      FOXALORA_RENDER_ORIGIN: `http://${RENDER_HOST}`,
      FOXALORA_APP_ORIGIN: `http://${APP_HOST}`,
      ALLOWED_HOSTS: APP_HOST,
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
    port = (app.getHttpServer().address() as AddressInfo).port;

    const login = await call(APP_HOST, 'POST', '/api/v1/auth/login', { 'X-Requested-With': 'foxalora' }, { email: 'alice@a.example', password: PASSWORD });
    expect(login.status).toBe(200);
    cookie = `fx_sid=${/fx_sid=([^;]+)/.exec(String(login.headers['set-cookie']))?.[1]}`;
  });

  afterAll(async () => {
    await app?.close();
    await redis?.flushdb();
    redis?.disconnect();
    await t?.drop();
    for (const k of ['FOXALORA_RENDER_ORIGIN', 'FOXALORA_APP_ORIGIN', 'ALLOWED_HOSTS']) delete process.env[k];
  });

  it('opening a message returns a one-time link on the render origin, and keeps html for quoting', async () => {
    const res = await call(APP_HOST, 'GET', '/api/v1/messages/msg-1', { Cookie: cookie });
    const json = JSON.parse(res.body);
    expect(json.html).toBe(HTML);
    const url = new URL(json.renderUrl);
    expect(url.origin).toBe(`http://${RENDER_HOST}`);
    expect(url.pathname).toMatch(/^\/api\/v1\/render\/[A-Za-z0-9_-]{43}$/);
  });

  it('serves the content once, with the strict policy and without cookies', async () => {
    const url = await openMessage();
    // A browser would never send the webmail cookie here (other host); send it anyway to prove it is ignored.
    const first = await call(RENDER_HOST, 'GET', url.pathname, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' });
    expect(first.status).toBe(200);
    expect(first.body).toContain(HTML);
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(first.headers['content-type']).toMatch(/^text\/html/);
    expect(first.headers['content-security-policy']).toBe(renderCsp(`http://${APP_HOST}`));
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-content-type-options']).toBe('nosniff');

    const again = await call(RENDER_HOST, 'GET', url.pathname);
    expect(again.status).toBe(404);
    expect(again.body).not.toContain(HTML);
    expect(again.headers['content-security-policy']).toBe(renderCsp(`http://${APP_HOST}`));
  });

  it('works without any session: the token is the only credential', async () => {
    const url = await openMessage();
    expect((await call(RENDER_HOST, 'GET', url.pathname)).status).toBe(200);
  });

  it('rejects unknown, malformed and expired tokens', async () => {
    expect((await call(RENDER_HOST, 'GET', `/api/v1/render/${randomBytes(32).toString('base64url')}`)).status).toBe(404);
    expect((await call(RENDER_HOST, 'GET', '/api/v1/render/not-a-token')).status).toBe(404);

    await clearTokens();
    const url = await openMessage();
    const keys = await redis.keys('fx:render:*');
    expect(keys).toHaveLength(1);
    const ttl = await redis.pttl(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    await redis.pexpire(keys[0], 1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(RENDER_HOST, 'GET', url.pathname)).status).toBe(404);
  });

  it('stores the content encrypted under a hash of the token', async () => {
    await clearTokens();
    const url = await openMessage();
    const token = url.pathname.split('/').pop()!;
    const keys = await redis.keys('fx:render:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(token);
    const raw = (await redis.get(keys[0])) ?? '';
    expect(raw).not.toContain('Quarterly');
    expect(Buffer.from(raw.split('.')[1] ?? '', 'base64').toString('latin1')).not.toContain('Quarterly');
    await call(RENDER_HOST, 'GET', url.pathname);
  });

  it('keeps the two hosts apart', async () => {
    const url = await openMessage();
    // Email content is never served on the webmail host...
    expect((await call(APP_HOST, 'GET', url.pathname, { Cookie: cookie })).status).toBe(404);
    // ...and the render host serves nothing but email content.
    expect((await call(RENDER_HOST, 'GET', '/api/v1/auth/me', { Cookie: cookie })).status).toBe(404);
    expect((await call(RENDER_HOST, 'GET', '/api/v1/messages/msg-1', { Cookie: cookie })).status).toBe(404);
    expect((await call(RENDER_HOST, 'POST', '/api/v1/auth/login', { 'X-Requested-With': 'foxalora' }, { email: 'alice@a.example', password: PASSWORD })).status).toBe(404);
    // The link was not used up by the refused request on the webmail host.
    expect((await call(RENDER_HOST, 'GET', url.pathname)).status).toBe(200);
    // Other host names are refused too.
    expect((await call('evil.test', 'GET', url.pathname)).status).toBe(404);
    expect((await call('evil.test', 'GET', '/api/v1/auth/me')).status).toBe(400);
  });
});
