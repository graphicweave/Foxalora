import { FormEvent, useCallback, useEffect, useState } from 'react';
import { explainReason, type TestResult } from '../setup/setup-api';
import '../setup/setup.css';
import { ConfirmProvider } from '../ui/ConfirmProvider';
import { useConfirm } from '../ui/confirm-context';
import { Logo } from '../ui/icons';
import { useToast } from '../ui/toast-context';
import { ToastProvider } from '../ui/Toasts';
import { AdminError, adminApi, type AdminMe, type AdminServer, type AuditEntry, type AuditFilter, type ServerForm } from './admin-api';
import './admin.css';

type View = { kind: 'loading' } | { kind: 'login' } | { kind: 'enroll' } | { kind: 'code' } | { kind: 'backup'; codes: string[] } | { kind: 'console'; me: AdminMe };

/** Admin console at /admin (E12): sign-in with required two-step verification, then domains, servers, audit log. */
export default function AdminApp() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  const apply = useCallback((me: AdminMe | null) => {
    if (!me) setView({ kind: 'login' });
    else if (me.stage === 'full') setView({ kind: 'console', me });
    else setView({ kind: me.twoStepEnabled ? 'code' : 'enroll' });
  }, []);
  const refresh = useCallback(() => adminApi.me().then(apply, () => apply(null)), [apply]);
  useEffect(() => { adminApi.me().then(apply, () => apply(null)); }, [apply]);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {view.kind === 'loading' && <div className="center muted">Loading…</div>}
        {view.kind === 'login' && <LoginCard onNext={(next) => setView({ kind: next })} />}
        {view.kind === 'enroll' && <EnrollCard onDone={(codes) => setView({ kind: 'backup', codes })} onRestart={() => setView({ kind: 'login' })} />}
        {view.kind === 'code' && <CodeCard onDone={refresh} onRestart={() => setView({ kind: 'login' })} />}
        {view.kind === 'backup' && <BackupCard codes={view.codes} onDone={refresh} />}
        {view.kind === 'console' && <Console me={view.me} onSignedOut={() => setView({ kind: 'login' })} />}
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Card({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <main className="setup-page">
      <section className="setup-card admin-auth">
        <header className="setup-head">
          <Logo size={34} className="brand" />
          <div><div className="setup-product">Foxalora Mail</div><div className="muted small">{subtitle}</div></div>
        </header>
        {children}
      </section>
    </main>
  );
}

function Problem({ text }: { text: string }) {
  return text ? <p className="notice error" role="alert">{text}</p> : null;
}

function LoginCard({ onNext }: { onNext: (next: 'enroll' | 'code') => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onNext((await adminApi.login(email, password)).next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Card subtitle="Administration">
      <h1>Administrator sign-in</h1>
      <p className="muted">For managing domains and mail servers. Mailbox users sign in on the <a href="/">webmail page</a>.</p>
      <form className="setup-form" onSubmit={submit}>
        <label>Email address<input id="admin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label>Password<input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <Problem text={error} />
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
      </form>
    </Card>
  );
}

function CodeInput({ value, onChange, allowBackup }: { value: string; onChange: (v: string) => void; allowBackup: boolean }) {
  return (
    <label>{allowBackup ? '6-digit code (or a backup code)' : '6-digit code from the app'}
      <input id="admin-code" inputMode={allowBackup ? 'text' : 'numeric'} autoComplete="one-time-code" maxLength={allowBackup ? 14 : 6}
        value={value} onChange={(e) => onChange(allowBackup ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))} required autoFocus />
    </label>
  );
}

function EnrollCard({ onDone, onRestart }: { onDone: (codes: string[]) => void; onRestart: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    adminApi.enroll().then(setSetup, (e: AdminError) => (e.status === 401 ? onRestart() : setError(e.message)));
  }, [onRestart]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await adminApi.verify(code);
      onDone(r.backupCodes ?? []);
    } catch (err) {
      if ((err as AdminError).status === 401 && /required|Unauthorized/i.test((err as Error).message)) return onRestart();
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Card subtitle="Two-step verification">
      <h1>Set up two-step verification</h1>
      <p>Every administrator needs a second step, so a stolen password alone is not enough.</p>
      <ol className="setup-list">
        <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password …).</li>
        <li>Scan this code, or type the key below into the app.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {setup ? (
        <div className="admin-qr">
          <img src={setup.qrSvg} alt="QR code for the authenticator app" width={240} height={240} />
          <div><div className="muted small">Key, if you cannot scan</div><code className="admin-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></div>
        </div>
      ) : !error && <p className="muted">Preparing…</p>}
      <form className="setup-form" onSubmit={submit}>
        <CodeInput value={code} onChange={setCode} allowBackup={false} />
        <Problem text={error} />
        <button className="primary" disabled={busy || !setup || code.length !== 6}>{busy ? 'Checking…' : 'Confirm'}</button>
      </form>
    </Card>
  );
}

function CodeCard({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi.verify(code);
      onDone();
    } catch (err) {
      if ((err as AdminError).status === 401 && /required|Unauthorized/i.test((err as Error).message)) return onRestart();
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Card subtitle="Two-step verification">
      <h1>Enter your code</h1>
      <p className="muted">Open your authenticator app. Lost your phone? Use one of your backup codes.</p>
      <form className="setup-form" onSubmit={submit}>
        <CodeInput value={code} onChange={setCode} allowBackup />
        <Problem text={error} />
        <button className="primary" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</button>
      </form>
    </Card>
  );
}

function BackupCard({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  return (
    <Card subtitle="Two-step verification">
      <h1>Save your backup codes</h1>
      <p>If you lose your phone, each of these codes signs you in once. They are shown only now: store them somewhere safe, such as a password manager.</p>
      <ul className="admin-backup">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <button type="button" className="ghost" onClick={() => navigator.clipboard.writeText(codes.join('\n')).then(() => toast('success', 'Backup codes copied.'), () => toast('error', 'Copying failed. Select the codes and copy them by hand.'))}>Copy codes</button>
      <label className="check admin-check"><input id="admin-saved" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes</label>
      <button className="primary" disabled={!saved} onClick={onDone}>Continue to the console</button>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

type Tab = 'domains' | 'servers' | 'audit';

function Console({ me, onSignedOut }: { me: AdminMe; onSignedOut: () => void }) {
  const [tab, setTab] = useState<Tab>('domains');
  const [servers, setServers] = useState<AdminServer[] | null>(null);
  const toast = useToast();
  const load = useCallback(() => adminApi.servers().then((r) => setServers(r.servers), (e: AdminError) => (e.status === 401 ? onSignedOut() : toast('error', e.message))), [onSignedOut, toast]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="admin-page">
      <header className="admin-top">
        <div className="admin-brand"><Logo size={28} className="brand" /><span>Foxalora administration</span></div>
        <nav className="admin-tabs" aria-label="Sections">
          {(['domains', 'servers', 'audit'] as Tab[]).map((t) => (
            <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
              {t === 'domains' ? 'Domains' : t === 'servers' ? 'Mail servers' : 'Audit log'}
            </button>
          ))}
        </nav>
        <div className="admin-user">
          <span className="muted small">{me.email}</span>
          <button type="button" className="ghost" onClick={() => adminApi.logout().finally(onSignedOut)}>Sign out</button>
        </div>
      </header>
      <main className="admin-main">
        {servers === null ? <p className="muted">Loading…</p>
          : tab === 'domains' ? <Domains servers={servers} reload={load} />
          : tab === 'servers' ? <Servers servers={servers} reload={load} />
          : <Audit />}
      </main>
    </div>
  );
}

function Domains({ servers, reload }: { servers: AdminServer[]; reload: () => Promise<void> }) {
  const [domain, setDomain] = useState('');
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const rows = servers.flatMap((s) => s.domains.map((d) => ({ domain: d, server: s })));

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await adminApi.addDomain(domain, serverId);
      toast('success', `${r.domain} added. Its users can sign in now.`);
      setDomain('');
      await reload();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(d: string) {
    const ok = await confirm({ title: `Remove ${d}?`, message: 'Its users can no longer sign in to the webmail. Their mail stays on the mail server.', confirmLabel: 'Remove domain', danger: true });
    if (!ok) return;
    try {
      await adminApi.removeDomain(d);
      toast('success', `${d} removed.`);
      await reload();
    } catch (err) {
      toast('error', (err as Error).message);
    }
  }

  return (
    <section className="admin-section" aria-labelledby="domains-h">
      <h1 id="domains-h">Domains</h1>
      <p className="muted">Users of these email domains sign in with their normal address and password. Each domain uses one mail server.</p>
      {servers.length === 0 ? <p className="notice">Add a mail server first.</p> : (
        <form className="admin-inline" onSubmit={add}>
          <label>Domain<input id="new-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required /></label>
          <label>Mail server<select id="new-domain-server" value={serverId} onChange={(e) => setServerId(e.target.value)}>{servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <button className="primary" disabled={busy || !domain.trim()}>Add domain</button>
        </form>
      )}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>Domain</th><th>Mail server</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={3} className="muted">No domains yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.domain}><td>{r.domain}</td><td>{r.server.name} <span className="muted small">({r.server.imapHost})</span></td>
                <td className="admin-actions"><button type="button" className="link danger-link" onClick={() => remove(r.domain)}>Remove</button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const EMPTY_SERVER: ServerForm = { name: '', imapHost: '', imapPort: 993, imapTls: 'tls', smtpHost: '', smtpPort: 465, smtpTls: 'tls', allowPrivate: false, savesSent: false };
const IMAP_MODES = [{ v: '993-tls', l: 'SSL/TLS, port 993' }, { v: '143-starttls', l: 'STARTTLS, port 143' }];
const SMTP_MODES = [{ v: '465-tls', l: 'SSL/TLS, port 465' }, { v: '587-starttls', l: 'STARTTLS, port 587' }, { v: '25-starttls', l: 'STARTTLS, port 25' }];
const mode = (port: number, tls: string) => `${port}-${tls}`;
const fromMode = (v: string) => { const [p, t] = v.split('-'); return { port: Number(p), tls: t as 'tls' | 'starttls' }; };

function Servers({ servers, reload }: { servers: AdminServer[]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<{ id: string | null; form: ServerForm } | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  async function remove(s: AdminServer) {
    const ok = await confirm({ title: `Delete ${s.name}?`, message: 'Users signed in through this server are signed out.', confirmLabel: 'Delete server', danger: true });
    if (!ok) return;
    try {
      await adminApi.deleteServer(s.id);
      toast('success', `${s.name} deleted.`);
      await reload();
    } catch (err) {
      toast('error', (err as Error).message);
    }
  }

  if (editing) return <ServerEditor initial={editing.form} id={editing.id} onClose={async (changed) => { setEditing(null); if (changed) await reload(); }} />;
  return (
    <section className="admin-section" aria-labelledby="servers-h">
      <div className="admin-section-head">
        <h1 id="servers-h">Mail servers</h1>
        <button type="button" className="primary" onClick={() => setEditing({ id: null, form: EMPTY_SERVER })}>Add mail server</button>
      </div>
      <p className="muted">The IMAP and SMTP servers your customers' mailboxes are on. Foxalora connects to them; it does not store mail.</p>
      <div className="admin-cards">
        {servers.length === 0 && <p className="muted">No mail servers yet.</p>}
        {servers.map((s) => (
          <article key={s.id} className="admin-card">
            <h2>{s.name}</h2>
            <dl className="setup-review">
              <dt>Incoming (IMAP)</dt><dd>{s.imapHost}:{s.imapPort} · {s.imapTls === 'tls' ? 'SSL/TLS' : 'STARTTLS'}</dd>
              <dt>Outgoing (SMTP)</dt><dd>{s.smtpHost}:{s.smtpPort} · {s.smtpTls === 'tls' ? 'SSL/TLS' : 'STARTTLS'}</dd>
              <dt>Domains</dt><dd>{s.domains.join(', ') || <span className="muted">none</span>}</dd>
              {(s.savesSent || s.allowPrivate) && <><dt>Options</dt><dd>{[s.savesSent && 'saves sent mail itself', s.allowPrivate && 'private network'].filter(Boolean).join(', ')}</dd></>}
            </dl>
            <div className="admin-card-actions">
              <button type="button" className="ghost" onClick={() => setEditing({ id: s.id, form: { ...s } })}>Edit</button>
              <button type="button" className="link danger-link" onClick={() => remove(s)}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ServerEditor({ initial, id, onClose }: { initial: ServerForm; id: string | null; onClose: (changed: boolean) => void }) {
  const [f, setF] = useState<ServerForm>(initial);
  const [sameHost, setSameHost] = useState(!initial.smtpHost || initial.smtpHost === initial.imapHost);
  const [mailbox, setMailbox] = useState({ email: '', password: '' });
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const payload = (): ServerForm => ({ ...f, name: f.name.trim() || f.imapHost.trim(), smtpHost: sameHost ? f.imapHost : f.smtpHost });
  const set = (p: Partial<ServerForm>) => { setF((x) => ({ ...x, ...p })); setTest(null); };

  async function runTest() {
    setBusy(true);
    setError('');
    try {
      setTest(await adminApi.testServer(payload(), mailbox.email || mailbox.password ? mailbox : undefined));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setMailbox((m) => ({ ...m, password: '' }));
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (id) await adminApi.updateServer(id, payload());
      else await adminApi.createServer(payload());
      toast('success', id ? 'Mail server saved.' : 'Mail server added. Now add its domains.');
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="admin-section" aria-labelledby="server-edit-h">
      <h1 id="server-edit-h">{id ? `Edit ${initial.name}` : 'Add mail server'}</h1>
      <form className="setup-form admin-form" onSubmit={save}>
        <label>Name<input id="srv-name" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Main mail server" /></label>
        <div className="setup-row">
          <label>IMAP server (incoming)<input id="srv-imap" value={f.imapHost} onChange={(e) => set({ imapHost: e.target.value.trim() })} placeholder="mail.example.com" required /></label>
          <label>Security<select id="srv-imap-mode" value={mode(f.imapPort, f.imapTls)} onChange={(e) => { const m = fromMode(e.target.value); set({ imapPort: m.port, imapTls: m.tls }); }}>{IMAP_MODES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
        </div>
        <label className="check"><input id="srv-same" type="checkbox" checked={sameHost} onChange={(e) => { setSameHost(e.target.checked); setTest(null); }} /> Outgoing mail (SMTP) uses the same server</label>
        <div className="setup-row">
          {!sameHost && <label>SMTP server (outgoing)<input id="srv-smtp" value={f.smtpHost} onChange={(e) => set({ smtpHost: e.target.value.trim() })} placeholder="smtp.example.com" required /></label>}
          <label>SMTP security<select id="srv-smtp-mode" value={mode(f.smtpPort, f.smtpTls)} onChange={(e) => { const m = fromMode(e.target.value); set({ smtpPort: m.port, smtpTls: m.tls }); }}>{SMTP_MODES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
        </div>
        <details className="setup-advanced" open={f.allowPrivate || f.savesSent}>
          <summary>Advanced</summary>
          <label className="check"><input id="srv-saves" type="checkbox" checked={f.savesSent} onChange={(e) => set({ savesSent: e.target.checked })} /> The server saves sent mail itself (Gmail, Microsoft 365, Zoho)</label>
          <label className="check"><input id="srv-private" type="checkbox" checked={f.allowPrivate} onChange={(e) => set({ allowPrivate: e.target.checked })} /> Mail server is on a private network (only if it really is)</label>
        </details>
        <fieldset className="setup-test">
          <legend>Test the connection</legend>
          <p className="muted small">Optional: sign in with any real mailbox on this server to test the login too. The password is used once and not saved.</p>
          <div className="setup-row">
            <label>Test mailbox<input id="srv-test-email" type="email" autoComplete="off" value={mailbox.email} onChange={(e) => setMailbox({ ...mailbox, email: e.target.value })} /></label>
            <label>Its password<input id="srv-test-password" type="password" autoComplete="off" value={mailbox.password} onChange={(e) => setMailbox({ ...mailbox, password: e.target.value })} /></label>
          </div>
          <button type="button" className="ghost" disabled={busy || !f.imapHost} onClick={runTest}>Test connection</button>
          {test && (['imap', 'smtp'] as const).map((k) => (
            <p key={k} className={`admin-test ${test[k].ok ? 'ok' : 'fail'}`}>
              <strong>{k.toUpperCase()}</strong> {test[k].ok ? (test.loginTested ? 'connected securely and signed in.' : 'connected securely.') : explainReason(test[k].reason)}
            </p>
          ))}
        </fieldset>
        <Problem text={error} />
        <div className="setup-actions">
          <button type="button" className="ghost" onClick={() => onClose(false)}>Cancel</button>
          <button className="primary" disabled={busy}>{id ? 'Save changes' : 'Add mail server'}</button>
        </div>
      </form>
    </section>
  );
}

const TYPES = [{ v: '', l: 'All events' }, { v: 'auth.', l: 'Mailbox sign-ins' }, { v: 'admin.', l: 'Administrator activity' }, { v: 'registry.', l: 'Domain and server changes' }, { v: 'setup.', l: 'Setup' }];

function Audit() {
  const [filter, setFilter] = useState<AuditFilter>({ type: '', q: '', from: '', to: '', page: 1 });
  const [data, setData] = useState<{ total: number; pageSize: number; items: AuditEntry[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    adminApi.audit({ ...filter, to: filter.to ? new Date(new Date(filter.to).getTime() + 86_400_000).toISOString().slice(0, 10) : '' })
      .then((d) => { setData(d); setError(''); }, (e: Error) => setError(e.message));
  }, [filter]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const set = (p: Partial<AuditFilter>) => setFilter((f) => ({ ...f, ...p, page: p.page ?? 1 }));

  return (
    <section className="admin-section" aria-labelledby="audit-h">
      <div className="admin-section-head">
        <h1 id="audit-h">Audit log</h1>
        <a className="button-link" href={adminApi.exportUrl(filter)} download>Export CSV</a>
      </div>
      <p className="muted">Security events of this installation. Entries never contain passwords or mail content.</p>
      <div className="admin-inline admin-filters">
        <label>Event<select id="audit-type" value={filter.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select></label>
        <label>From<input id="audit-from" type="date" value={filter.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>To<input id="audit-to" type="date" value={filter.to} onChange={(e) => set({ to: e.target.value })} /></label>
        <label>Search<input id="audit-q" type="search" value={filter.q} onChange={(e) => set({ q: e.target.value })} placeholder="Email, domain, IP …" /></label>
      </div>
      <Problem text={error} />
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>Time</th><th>Event</th><th>By</th><th>Details</th></tr></thead>
          <tbody>
            {data?.items.length === 0 && <tr><td colSpan={4} className="muted">No entries match.</td></tr>}
            {data?.items.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td className="nowrap">{new Date(e.at).toLocaleString()}</td>
                <td><code>{e.type}</code></td>
                <td>{e.actor}</td>
                <td className="admin-details">{Object.entries(e.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && (
        <div className="admin-pager">
          <button type="button" className="ghost" disabled={(filter.page ?? 1) <= 1} onClick={() => set({ page: (filter.page ?? 1) - 1 })}>Newer</button>
          <span className="muted small">Page {filter.page} of {pages} · {data.total} entries</span>
          <button type="button" className="ghost" disabled={(filter.page ?? 1) >= pages} onClick={() => set({ page: (filter.page ?? 1) + 1 })}>Older</button>
        </div>
      )}
    </section>
  );
}
