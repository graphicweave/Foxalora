// Admin console browser check (E12): sign-in, two-step enrollment, backup codes, domains, servers,
// connection test, audit log and CSV export, in headless Chrome against the dev stack.
// Needs dev/up.sh running, a fresh dev admin (seed:dev creates admin@dev.test; to rerun, reset its
// two-step with `node backend/dist/cli.js admin:reset-2fa admin@dev.test`) and Google Chrome.
// Run: node dev/checks/admin-console.mjs [screenshot-folder]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const require = createRequire(join(BACKEND, 'package.json'));
const { hotp, base32Decode, stepAt } = require(join(BACKEND, 'dist/admin/totp.js'));

const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'fx-admin-shots-'));
const APP = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'fx-admin-'));
const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
let ws, seq = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const results = []; const check = (name, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  (' + d + ')' : ''}`); };
let s;
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed'); return r.result.value; };
const waitFor = async (expr, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { try { if (await ev(expr)) return; } catch { /* retry */ } } throw new Error('timeout: ' + expr); };
const fill = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
const click = (text, scope = 'button') => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(x => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) throw new Error('no ${text}'); b.click(); return true; })()`);
const shot = async (name, width = 1280, height = 860) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, s);
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};
try {
  let ver; for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9334/json/version')).json(); } catch { await sleep(200); } }
  ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  s = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
  await send('Page.navigate', { url: `${APP}/admin` }, s);
  await waitFor(`!!document.querySelector('#admin-email')`);
  await shot('1-login');
  check('the sign-in page opens at /admin', true);

  await fill('#admin-email', 'admin@dev.test'); await fill('#admin-password', 'wrong-password-123');
  await click('Continue'); await waitFor(`!!document.querySelector('.notice.error')`);
  check('a wrong password shows the generic message', await ev(`document.querySelector('.notice.error').textContent.includes('Sign-in failed')`));
  await fill('#admin-password', 'Dev-Admin-Pass-2026'); await click('Continue');
  await waitFor(`!!document.querySelector('.admin-secret')`);
  await sleep(500);
  await shot('2-enroll');
  const secret = (await ev(`document.querySelector('.admin-secret').textContent`)).replace(/\s/g, '');
  check('enrollment shows a QR code and the key', await ev(`document.querySelector('.admin-qr img').naturalWidth > 0`) && /^[A-Z2-7]{32}$/.test(secret));
  await fill('#admin-code', hotp(base32Decode(secret), stepAt(Date.now())));
  await click('Confirm');
  await waitFor(`document.querySelectorAll('.admin-backup li').length > 0`);
  check('ten backup codes are shown once', (await ev(`document.querySelectorAll('.admin-backup li').length`)) === 10);
  await shot('3-backup');
  await ev(`document.querySelector('#admin-saved').click()`);
  await click('Continue to the console');
  await waitFor(`!!document.querySelector('.admin-tabs')`);
  await waitFor(`document.querySelectorAll('.admin-table tbody tr').length > 0`);
  await shot('4-domains');
  const rows = await ev(`[...document.querySelectorAll('.admin-table tbody tr td:first-child')].map(t => t.textContent)`);
  check('the domains list loads', rows.length > 0, rows.join(', '));

  await fill('#new-domain', 'Branch.Dev.Test'); await click('Add domain');
  await waitFor(`[...document.querySelectorAll('.admin-table td')].some(t => t.textContent === 'branch.dev.test')`);
  check('a domain can be added (and is normalised)', true);
  await ev(`[...document.querySelectorAll('.admin-table tr')].find(r => r.textContent.includes('branch.dev.test')).querySelector('button').click()`);
  await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove domain')`);
  await shot('5-confirm');
  await click('Remove domain');
  await waitFor(`![...document.querySelectorAll('.admin-table td')].some(t => t.textContent === 'branch.dev.test')`);
  check('removing a domain asks first, then removes it', true);

  await click('Mail servers'); await waitFor(`!!document.querySelector('.admin-card')`);
  await shot('6-servers');
  await ev(`document.querySelector('.admin-card button').click()`);
  await waitFor(`!!document.querySelector('#srv-imap')`);
  await shot('7-edit');
  await click('Test connection');
  await waitFor(`document.querySelectorAll('.admin-test').length === 2`, 30000);
  const testOut = await ev(`[...document.querySelectorAll('.admin-test')].map(p => p.className + ': ' + p.textContent).join(' | ')`);
  check('the connection test runs from the console', true, testOut.slice(0, 160));
  await click('Cancel');
  await waitFor(`!!document.querySelector('.admin-card')`);

  await click('Audit log'); await waitFor(`document.querySelectorAll('.admin-table tbody tr').length > 1`);
  const types = await ev(`[...document.querySelectorAll('.admin-table tbody td:nth-child(2)')].map(t => t.textContent)`);
  check('the audit log shows the changes just made', ['registry.domain_mapped', 'registry.domain_unmapped', 'admin.login', 'admin.two_step_enabled'].every((x) => types.includes(x)), types.slice(0, 6).join(', '));
  await fill('#audit-type', 'registry.');
  await waitFor(`[...document.querySelectorAll('.admin-table tbody td:nth-child(2)')].every(t => t.textContent.startsWith('registry.'))`);
  check('the event filter works', true);
  const href = await ev(`document.querySelector('a[download]').getAttribute('href')`);
  const csv = await ev(`fetch(${JSON.stringify(href)}).then(async r => r.headers.get('content-type') + ' | ' + (await r.text()).split('\\r\\n')[0])`);
  check('CSV export downloads with the filter', /^text\/csv/.test(csv) && href.includes('type=registry.'), csv);
  await shot('8-audit');
  await shot('9-audit-phone', 390, 844);

  await send('Emulation.clearDeviceMetricsOverride', {}, s);
  await click('Sign out'); await waitFor(`!!document.querySelector('#admin-email')`);
  check('sign out returns to the sign-in page', true);
  await send('Page.navigate', { url: `${APP}/admin` }, s);
  await waitFor(`!!document.querySelector('#admin-email')`);
  await fill('#admin-email', 'admin@dev.test'); await fill('#admin-password', 'Dev-Admin-Pass-2026'); await click('Continue');
  await waitFor(`!!document.querySelector('#admin-code')`);
  check('the next sign-in asks for a code (no new enrollment)', !(await ev(`!!document.querySelector('.admin-qr')`)));
  await shot('10-code');
} catch (e) {
  check('browser run completed', false, e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGTERM'); await sleep(300); rmSync(profile, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed (screenshots: ${OUT})`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
