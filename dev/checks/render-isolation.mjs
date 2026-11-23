// FOX-045 browser check: opens a message in the real app (headless Chrome over CDP) and tries,
// from inside the email frame, to read cookies, storage and the parent page.
// Needs the dev stack running (dev/up.sh) and Google Chrome. Run: node dev/checks/render-isolation.mjs
// Exit code 0 when every check passes.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://localhost:5173';
const [EMAIL, PASSWORD] = [process.env.FX_CHECK_EMAIL ?? 'carol@dovecot.test', process.env.FX_CHECK_PASSWORD ?? 'carol-pass-1'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'fx-chrome-'));
const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const events = [];
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try {
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9333/json/version')).json(); } catch { await sleep(200); } }
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method) events.push(d);
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s); await send('Network.enable', {}, s);
  const evaluate = async (expression, contextId) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation failed');
    return r.result.value;
  };
  const waitFor = async (expression, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { try { if (await evaluate(expression)) return true; } catch { /* not yet */ } }
    throw new Error(`timed out waiting for: ${expression}`);
  };

  // Cross-origin frames run in their own process (site isolation): attach to them as separate targets.
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s);
  await send('Page.navigate', { url: APP }, s);
  await waitFor(`!!document.querySelector('input[type=email]')`);
  await evaluate(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)});
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form.login').requestSubmit();
  })()`);
  await waitFor(`!document.querySelector('form.login')`);
  await waitFor(`document.querySelectorAll('li.msg-item button.msg-row').length > 0`);
  // Dismiss the first-run guide if it shows, then open messages until one has an HTML body.
  await sleep(1500);
  await evaluate(`[...document.querySelectorAll('button')].find(b => /skip|close|got it|done/i.test(b.textContent))?.click()`).catch(() => {});
  const opened = await evaluate(`(async () => {
    const items = [...document.querySelectorAll('li.msg-item button.msg-row')];
    const list = items.length ? items : [...document.querySelectorAll('main li')];
    for (const el of list.slice(0, 15)) {
      el.click();
      for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 250)); const f = document.querySelector('.msg-content iframe'); if (f) return f.src ? 'src' : 'srcdoc'; if (document.querySelector('.msg-content pre')) break; }
    }
    return 'none';
  })()`);
  check('an HTML message opened in the real app', opened !== 'none', `frame mode: ${opened}`);

  const frameInfo = await evaluate(`(() => { const f = document.querySelector('.msg-content iframe'); return { src: f.src, sandbox: f.getAttribute('sandbox'), hasSrcdoc: f.hasAttribute('srcdoc') }; })()`);
  const src = new URL(frameInfo.src);
  check('the frame loads from the separate render origin', src.origin === 'http://127.0.0.1:3000' && new URL(APP).origin !== src.origin, src.origin);
  check('the frame has no srcdoc copy of the email on the app origin', !frameInfo.hasSrcdoc);
  check('the frame sandbox allows no scripts or same-origin access', !/allow-scripts|allow-same-origin/.test(frameInfo.sandbox ?? ''), frameInfo.sandbox);

  const parentToFrame = await evaluate(`(() => { try { return 'readable: ' + document.querySelector('.msg-content iframe').contentWindow.document.body.innerHTML.length; } catch (e) { return 'blocked: ' + e.name; } })()`);
  check('the webmail cannot reach into the frame either (cross-origin)', parentToFrame.startsWith('blocked'), parentToFrame);

  // The session cookie exists on the app origin and is HttpOnly.
  const { cookies } = await send('Network.getAllCookies', {}, s);
  const sid = cookies.find((c) => c.name === 'fx_sid');
  check('the webmail session cookie is HttpOnly and host-only on localhost', !!sid && sid.httpOnly && sid.domain === 'localhost', sid ? `${sid.domain} httpOnly=${sid.httpOnly} sameSite=${sid.sameSite}` : 'missing');
  check('no cookie exists for the render host', !cookies.some((c) => c.domain === '127.0.0.1'));

  // Run code inside the email frame (an isolated world has the frame's own origin and rights):
  // this is what an attacker would get if a script ever ran there despite layers 1 and 2.
  const attached = events.filter((e) => e.method === 'Target.attachedToTarget' && e.params.targetInfo.type === 'iframe').map((e) => e.params).pop();
  const fs = attached?.sessionId;
  await send('Page.enable', {}, fs);
  const tree = await send('Page.getFrameTree', {}, fs);
  const frameUrl = tree.frameTree.frame.url;
  check('the frame runs in its own browser process (site isolation), at the render URL', frameUrl.startsWith('http://127.0.0.1:3000/api/v1/render/'), frameUrl.replace(/[A-Za-z0-9_-]{43}$/, '<token>'));
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'attacker' }, fs);
  const inFrame = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, contextId: executionContextId }, fs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation failed');
    return r.result.value;
  };
  const inside = JSON.parse(await inFrame(`(() => {
    const r = { origin: String(self.origin) };
    const t = (k, f) => { try { r[k] = 'readable: ' + JSON.stringify(f()); } catch (e) { r[k] = 'blocked: ' + e.name; } };
    t('cookie', () => document.cookie);
    t('localStorage', () => localStorage.length);
    t('sessionStorage', () => sessionStorage.length);
    t('indexedDB', () => indexedDB.open('x') && 'opened');
    t('parentDocument', () => parent.document.title);
    t('parentLocalStorage', () => parent.localStorage.length);
    t('parentCookie', () => parent.document.cookie);
    t('topLocation', () => top.location.href);
    return JSON.stringify(r);
  })()`));
  console.log('      inside the frame:', inside);
  check('the frame has an opaque origin', inside.origin === 'null', inside.origin);
  check('the frame cannot read cookies', inside.cookie.startsWith('blocked') || inside.cookie === 'readable: ""', inside.cookie);
  check('the frame cannot read localStorage or sessionStorage', inside.localStorage.startsWith('blocked') && inside.sessionStorage.startsWith('blocked'), `${inside.localStorage}; ${inside.sessionStorage}`);
  check('the frame cannot read the parent page, its storage or cookies', ['parentDocument', 'parentLocalStorage', 'parentCookie', 'topLocation'].every((k) => inside[k].startsWith('blocked')),
    `${inside.parentDocument}; ${inside.parentLocalStorage}; ${inside.parentCookie}; ${inside.topLocation}`);

  // One-time link: loading the same URL again shows the expired page, not the email.
  const again = await fetch(frameInfo.src);
  const body = await again.text();
  check('the render link works only once', again.status === 404 && /expired/.test(body), `second load: HTTP ${again.status}`);
  check('the render response sets no cookie', again.headers.get('set-cookie') === null);
  const csp = again.headers.get('content-security-policy') ?? '';
  check('the render response is framable only by the webmail', csp.includes('frame-ancestors http://localhost:5173'), csp.match(/frame-ancestors [^;]+/)?.[0]);
} catch (e) {
  check('browser run completed', false, e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGTERM');
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
