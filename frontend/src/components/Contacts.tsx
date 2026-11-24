import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, type Contact, type ContactDraft, type ContactGroup } from '../api';
import { buildMapping, dedupeSingles, FIELD_OPTIONS, guessField, mappingUsable, parseFirstRows, SINGLE_FIELDS, type CsvField } from '../contacts/csv';
import { avatarOf } from '../mail/format';
import { Icon } from '../ui/icons';
import { Menu } from '../ui/Menu';
import { useConfirm } from '../ui/confirm-context';
import { useToast } from '../ui/toast-context';
import type { ComposeInit } from './Compose';

const CONTACTS_PAGE = 50;
const LABELS: { value: string; label: string }[] = [
  { value: '', label: 'Email' }, { value: 'work', label: 'Work' }, { value: 'home', label: 'Home' }, { value: 'other', label: 'Other' },
];
const labelText = (v: string) => LABELS.find((l) => l.value === v)?.label ?? 'Email';
const nameOf = (c: ContactDraft) => c.displayName || c.emails[0]?.email || '(no name)';
const avatarFor = (c: ContactDraft) => avatarOf({ name: c.displayName, address: c.emails[0]?.email ?? c.displayName });
const EMPTY: ContactDraft = { displayName: '', company: '', phone: '', emails: [{ email: '', label: '' }] };

export default function Contacts({ onCompose }: { onCompose: (init: ComposeInit) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Contact[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editing, setEditing] = useState<(ContactDraft & { id?: string }) | null>(null);
  const [importing, setImporting] = useState(false);
  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [groupDialog, setGroupDialog] = useState<{ id?: string; name: string } | null>(null);
  const seq = useRef(0);

  function load(q: string, p: number, g: string | null = activeGroup) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    api
      .contacts(q, p, g)
      .then((r) => n === seq.current && setData(r))
      .catch((e: Error) => n === seq.current && setError(e.message))
      .finally(() => n === seq.current && setLoading(false));
  }

  const loadGroups = () => api.groups().then((r) => setGroups(r.items)).catch(() => {});

  useEffect(() => {
    const n = ++seq.current;
    api
      .contacts('', 1)
      .then((r) => n === seq.current && setData(r))
      .catch((e: Error) => n === seq.current && setError(e.message))
      .finally(() => n === seq.current && setLoading(false));
    api.groups().then((r) => setGroups(r.items)).catch(() => {});
  }, []);

  function runSearch(e: FormEvent) {
    e.preventDefault();
    setQuery(search.trim());
    setPage(1);
    load(search.trim(), 1);
  }

  function clearSearch() {
    setSearch('');
    if (!query) return;
    setQuery('');
    setPage(1);
    load('', 1);
  }

  function selectGroup(g: string | null) {
    setActiveGroup(g);
    setPage(1);
    load(query, 1, g);
  }

  /** Row click shows what the list knows, then fills in the group memberships. */
  function open(c: Contact) {
    setEditing(null);
    setSelected(c);
    api.contact(c.id).then((full) => setSelected((cur) => (cur?.id === c.id ? full : cur))).catch(() => {});
  }

  async function toggleMembership(g: ContactGroup) {
    if (!selected) return;
    try {
      // The list payload has no groups; fetch the detail before deciding the direction.
      const cur = selected.groups ? selected : await api.contact(selected.id);
      const member = cur.groups?.some((x) => x.id === g.id) ?? false;
      if (member) await api.removeFromGroup(g.id, selected.id);
      else await api.addToGroup(g.id, selected.id);
      const full = await api.contact(selected.id);
      setSelected((cur) => (cur?.id === full.id ? full : cur));
      loadGroups();
      if (activeGroup === g.id) load(query, page);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function writeToGroup(g: ContactGroup) {
    try {
      const { emails } = await api.groupAddresses(g.id);
      if (!emails.length) {
        toast('info', 'No contact in this group has an email address.');
        return;
      }
      onCompose({ to: emails.join(', ') });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function removeGroup(g: ContactGroup) {
    if (!(await confirm({ title: `Delete the group “${g.name}”?`, message: 'The contacts in it are kept; only the group is removed.', confirmLabel: 'Delete group', danger: true }))) return;
    try {
      await api.deleteGroup(g.id);
      toast('success', 'Group deleted.');
      if (activeGroup === g.id) selectGroup(null);
      loadGroups();
      if (selected) open(selected);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function save(draft: ContactDraft & { id?: string }) {
    const body: ContactDraft = { ...draft, emails: draft.emails.filter((e) => e.email.trim()) };
    const saved = draft.id ? await api.updateContact(draft.id, body) : await api.createContact(body);
    toast('success', draft.id ? 'Contact saved.' : 'Contact added.');
    open(saved); // refetches the detail, so group badges survive the save
    load(query, page);
  }

  async function remove(c: Contact) {
    if (!(await confirm({ title: `Delete ${nameOf(c)}?`, message: 'The contact is removed from your address book. Your emails are not affected.', confirmLabel: 'Delete contact', danger: true }))) return;
    try {
      await api.deleteContact(c.id);
      toast('success', 'Contact deleted.');
      setSelected(null);
      load(query, page);
      loadGroups();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  const pages = Math.max(1, Math.ceil(data.total / CONTACTS_PAGE));
  const goTo = (p: number) => {
    setPage(p);
    load(query, p);
  };
  const detailOpen = !!(selected || editing);
  const activeGroupObj = groups.find((g) => g.id === activeGroup) ?? null;

  return (
    <main id="main" tabIndex={-1} className={`contacts-view ${detailOpen ? 'has-detail' : ''}`}>
      <section className="list" aria-label="Contacts">
        <div className="pane-head">
          <form role="search" className="search" onSubmit={runSearch}>
            {Icon.search}
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search contacts" aria-label="Search contacts" maxLength={100} />
            {(search || query) && <button type="button" className="icon-btn" aria-label="Clear search" onClick={clearSearch}>{Icon.x}</button>}
          </form>
          <button type="button" className="icon-btn" aria-label="New contact" data-tip="New contact" onClick={() => { setSelected(null); setEditing({ ...EMPTY, emails: [{ email: '', label: '' }] }); }}>
            {Icon.plus}
          </button>
        </div>
        <div className="list-title">
          <h1>Contacts</h1>
          <span className="muted small">
            {query
              ? `${data.total} found for “${query}”`
              : activeGroupObj
                ? `${data.total} in “${activeGroupObj.name}”`
                : `${data.total} contact${data.total === 1 ? '' : 's'}`}
          </span>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Import contacts" data-tip="Import contacts (vCard or CSV)" onClick={() => setImporting(true)}>{Icon.upload}</button>
          <a className={`icon-btn ${data.total ? '' : 'disabled'}`} href={data.total ? api.exportContactsUrl() : undefined} aria-disabled={!data.total} download aria-label="Export all contacts" data-tip="Export all contacts (vCard)">{Icon.download}</a>
        </div>
        <div className="group-bar" role="toolbar" aria-label="Groups">
          <button type="button" className={`chip-btn ${activeGroup ? '' : 'active'}`} aria-pressed={!activeGroup} onClick={() => selectGroup(null)}>All</button>
          {groups.map((g) => (
            <button type="button" key={g.id} className={`chip-btn ${activeGroup === g.id ? 'active' : ''}`} aria-pressed={activeGroup === g.id} onClick={() => selectGroup(g.id)} dir="auto">
              {g.name}<small>{g.members}</small>
            </button>
          ))}
          <button type="button" className="icon-btn group-add" aria-label="New group" data-tip="New group" onClick={() => setGroupDialog({ name: '' })}>{Icon.plus}</button>
          {activeGroupObj && (
            <span className="group-actions">
              <button type="button" className="icon-btn" aria-label={`Write to everyone in ${activeGroupObj.name}`} data-tip="Write to this group" disabled={!activeGroupObj.members} onClick={() => writeToGroup(activeGroupObj)}>{Icon.send}</button>
              <button type="button" className="icon-btn" aria-label={`Rename ${activeGroupObj.name}`} data-tip="Rename group" onClick={() => setGroupDialog({ id: activeGroupObj.id, name: activeGroupObj.name })}>{Icon.pen}</button>
              <button type="button" className="icon-btn" aria-label={`Delete ${activeGroupObj.name}`} data-tip="Delete group" onClick={() => removeGroup(activeGroupObj)}>{Icon.trash}</button>
            </span>
          )}
        </div>
        <div className="list-body" aria-busy={loading}>
          {error && <div className="notice error" role="alert">{Icon.alert}<span>{error}</span></div>}
          {data.items.length > 0 && (
            <ul className="msg-list">
              {data.items.map((c) => {
                const av = avatarFor(c);
                const active = selected?.id === c.id || editing?.id === c.id;
                return (
                  <li key={c.id}>
                    <button type="button" className={`msg-row contact-row ${active ? 'active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => open(c)}>
                      <span className="avatar" style={{ '--h': av.hue } as CSSProperties} aria-hidden="true">{av.letter}</span>
                      <span className="msg-main">
                        <span className="msg-from ellipsis" dir="auto">{nameOf(c)}</span>
                        <span className="msg-subject ellipsis">{c.displayName ? c.emails[0]?.email ?? c.company : c.company}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!loading && !error && !data.items.length && (
            <div className="empty">
              {query ? Icon.search : Icon.contacts}
              <strong>{query ? 'No contacts match your search' : activeGroupObj ? 'No contacts in this group' : 'No contacts yet'}</strong>
              {query ? (
                <button type="button" className="link" onClick={clearSearch}>Clear search</button>
              ) : activeGroupObj ? (
                <span className="muted small">Open a contact and use the Groups button to add it here.</span>
              ) : (
                <span className="row-actions">
                  <button type="button" className="link" onClick={() => setEditing({ ...EMPTY, emails: [{ email: '', label: '' }] })}>Add a contact</button>
                  <button type="button" className="link" onClick={() => setImporting(true)}>Import a file</button>
                </span>
              )}
            </div>
          )}
        </div>
        {data.total > CONTACTS_PAGE && (
          <footer className="pager" aria-label="Pages">
            <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => goTo(page - 1)}>{Icon.chevronLeft}</button>
            <span>Page {page} of {pages}</span>
            <button type="button" className="icon-btn" aria-label="Next page" disabled={page >= pages || loading} onClick={() => goTo(page + 1)}>{Icon.chevronRight}</button>
          </footer>
        )}
      </section>

      <section className="reader" aria-label="Contact details">
        {editing ? (
          <ContactForm key={editing.id ?? 'new'} initial={editing} onSave={save} onCancel={() => setEditing(null)} />
        ) : selected ? (
          <>
            <div className="pane-head toolbar" role="toolbar" aria-label="Contact actions">
              <button type="button" className="icon-btn only-mobile" aria-label="Back to contacts" onClick={() => setSelected(null)}>{Icon.back}</button>
              <ToolButton icon={Icon.send} label="Write email" disabled={!selected.emails.length} onClick={() => onCompose({ to: selected.emails[0].email })} />
              <ToolButton icon={Icon.pen} label="Edit" onClick={() => setEditing(selected)} />
              <ToolButton icon={Icon.trash} label="Delete" onClick={() => remove(selected)} />
              <Menu
                label="Groups"
                icon={Icon.contacts}
                tip="Add this contact to groups, or take it out"
                items={() => [
                  ...groups.map((g) => ({
                    label: g.name,
                    icon: selected.groups?.some((x) => x.id === g.id) ? Icon.check : undefined,
                    onSelect: () => toggleMembership(g),
                  })),
                  { label: 'New group…', icon: Icon.plus, onSelect: () => setGroupDialog({ name: '' }) },
                ]}
              />
              <span className="tool-sep" />
              <a className="tool-btn" href={api.exportContactsUrl([selected.id])} download data-tip="Export as vCard">
                {Icon.download}<span className="tool-label">Export</span>
              </a>
            </div>
            <div className="reader-body">
              <ContactCard contact={selected} onWrite={(email) => onCompose({ to: email })} />
            </div>
          </>
        ) : (
          <>
            <div className="pane-head toolbar" />
            <div className="reader-body">
              <div className="reader-empty">
                <span className="watermark-icon" aria-hidden="true">{Icon.contacts}</span>
                <span className="muted">Select a contact, or add a new one</span>
              </div>
            </div>
          </>
        )}
      </section>

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setPage(1);
            load(query, 1);
          }}
        />
      )}
      {groupDialog && (
        <GroupDialog
          initial={groupDialog}
          onClose={() => setGroupDialog(null)}
          onSave={async (name) => {
            if (groupDialog.id) await api.renameGroup(groupDialog.id, name);
            else await api.createGroup(name);
            toast('success', groupDialog.id ? 'Group renamed.' : 'Group created.');
            setGroupDialog(null);
            loadGroups();
            if (selected) open(selected);
          }}
        />
      )}
    </main>
  );
}

function GroupDialog({ initial, onClose, onSave }: { initial: { id?: string; name: string }; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial.name);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await onSave(name.trim());
    } catch (ex) {
      setErr((ex as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal" onKeyDown={(e) => e.key === 'Escape' && onClose()} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="group-title" onSubmit={submit}>
        <button type="button" className="icon-btn dialog-close" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        <h2 id="group-title" className="dialog-title">{initial.id ? 'Rename group' : 'New group'}</h2>
        <label className="field">
          Group name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus dir="auto" placeholder="Family, Team, Book club…" />
        </label>
        {err && <div className="notice error" role="alert">{Icon.alert}<span>{err}</span></div>}
        <div className="form-actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim() || busy}>{busy ? 'Saving…' : initial.id ? 'Rename' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function ToolButton({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="tool-btn" disabled={disabled} onClick={onClick} data-tip={label}>
      {icon}
      <span className="tool-label">{label}</span>
    </button>
  );
}

function ContactCard({ contact: c, onWrite }: { contact: Contact; onWrite: (email: string) => void }) {
  const av = avatarFor(c);
  return (
    <article className="message-card contact-card" aria-labelledby="contact-name">
      <header className="contact-head">
        <span className="avatar large" style={{ '--h': av.hue } as CSSProperties} aria-hidden="true">{av.letter}</span>
        <div>
          <h2 id="contact-name" dir="auto">{nameOf(c)}</h2>
          {c.company && <p className="muted" dir="auto">{c.company}</p>}
          {(c.groups?.length ?? 0) > 0 && (
            <p className="contact-groups" aria-label="Groups">
              {c.groups!.map((g) => <span key={g.id} className="badge-soft" dir="auto">{g.name}</span>)}
            </p>
          )}
        </div>
      </header>
      <dl className="contact-fields">
        {c.emails.map((e) => (
          <div key={e.email} className="contact-field">
            <dt>{Icon.mail}<span>{labelText(e.label)}</span></dt>
            <dd>
              <span className="ellipsis">{e.email}</span>
              <button type="button" className="link" onClick={() => onWrite(e.email)}>Write</button>
            </dd>
          </div>
        ))}
        {c.phone && (
          <div className="contact-field">
            <dt>{Icon.phone}<span>Phone</span></dt>
            <dd><a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a></dd>
          </div>
        )}
        {c.company && (
          <div className="contact-field">
            <dt>{Icon.building}<span>Company</span></dt>
            <dd dir="auto">{c.company}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

function ContactForm({ initial, onSave, onCancel }: { initial: ContactDraft & { id?: string }; onSave: (c: ContactDraft & { id?: string }) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(() => ({ ...initial, emails: initial.emails.length ? initial.emails : [{ email: '', label: '' }] }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<ContactDraft>) => setDraft((d) => ({ ...d, ...change }));
  const setEmail = (i: number, change: Partial<{ email: string; label: string }>) =>
    setDraft((d) => ({ ...d, emails: d.emails.map((e, j) => (j === i ? { ...e, ...change } : e)) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.displayName.trim() && !draft.emails.some((x) => x.email.trim())) {
      setErr('Enter a name or an email address.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await onSave(draft);
    } catch (ex) {
      setErr((ex as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pane-head toolbar">
        <button type="button" className="icon-btn only-mobile" aria-label="Back to contacts" onClick={onCancel}>{Icon.back}</button>
        <h2 className="pane-title">{initial.id ? 'Edit contact' : 'New contact'}</h2>
      </div>
      <div className="reader-body">
        <form className="message-card form-card" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
          <label className="field">
            Name
            <input value={draft.displayName} onChange={(e) => set({ displayName: e.target.value })} maxLength={200} autoFocus dir="auto" />
          </label>
          <fieldset className="field">
            <legend>Email addresses</legend>
            {draft.emails.map((em, i) => (
              <div className="email-row" key={i}>
                <select aria-label={`Type of address ${i + 1}`} value={em.label} onChange={(e) => setEmail(i, { label: e.target.value })}>
                  {LABELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
                <input type="email" aria-label={`Email address ${i + 1}`} value={em.email} onChange={(e) => setEmail(i, { email: e.target.value })} maxLength={320} placeholder="name@example.com" />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove address ${i + 1}`}
                  disabled={draft.emails.length === 1}
                  onClick={() => setDraft((d) => ({ ...d, emails: d.emails.filter((_, j) => j !== i) }))}
                >
                  {Icon.x}
                </button>
              </div>
            ))}
            {draft.emails.length < 10 && (
              <button type="button" className="link add-row" onClick={() => setDraft((d) => ({ ...d, emails: [...d.emails, { email: '', label: '' }] }))}>
                {Icon.plus} Add another address
              </button>
            )}
          </fieldset>
          <label className="field">
            Phone
            <input type="tel" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={50} />
          </label>
          <label className="field">
            Company
            <input value={draft.company} onChange={(e) => set({ company: e.target.value })} maxLength={200} dir="auto" />
          </label>
          {err && <div className="notice error" role="alert">{Icon.alert}<span>{err}</span></div>}
          <div className="form-actions">
            <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
            <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [duplicates, setDuplicates] = useState<'skip' | 'add'>('skip');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [err, setErr] = useState('');
  // CSV mapping step (FOX-074): text + per-column field assignments.
  const [csvText, setCsvText] = useState<string | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [fields, setFields] = useState<CsvField[]>([]);

  const isCsv = (f: File) => /\.csv$/i.test(f.name) || f.type === 'text/csv';
  const rows = csvText !== null ? parseFirstRows(csvText, 2) : [];
  const headers = csvText !== null ? (hasHeader ? rows[0] ?? [] : (rows[0] ?? []).map((_, i) => `Column ${i + 1}`)) : [];
  const preview = hasHeader ? rows[1] ?? [] : rows[0] ?? [];
  const mapping = buildMapping(fields);

  function pickFile(f: File | null) {
    setFile(f);
    setErr('');
    setCsvText(null);
    setFields([]);
  }

  function setField(i: number, f: CsvField) {
    setFields((old) => old.map((v, j) => (j === i ? f : SINGLE_FIELDS.includes(f) && v === f ? 'ignore' : v)));
  }

  function startHeader(text: string, withHeader: boolean) {
    const first = parseFirstRows(text, 1)[0] ?? [];
    setFields(withHeader ? dedupeSingles(first.map(guessField)) : first.map(() => 'ignore'));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > 2_000_000) {
      setErr('The file is larger than 2 MB.');
      return;
    }
    setErr('');
    if (isCsv(file) && csvText === null) {
      // Step 1 for CSV: read the file and open the column-mapping step.
      let text: string;
      try {
        text = await file.text();
      } catch {
        setErr('The file could not be read. Choose it again.');
        setFile(null);
        return;
      }
      if (!text.trim()) {
        setErr('The file is empty.');
        return;
      }
      setCsvText(text);
      startHeader(text, hasHeader);
      return;
    }
    setBusy(true);
    try {
      const r = csvText !== null
        ? await api.importContactsCsv(csvText, mapping, hasHeader, duplicates)
        : await api.importContacts(await file.text(), duplicates);
      setResult(r);
      onDone();
      toast('success', `${r.imported} contact${r.imported === 1 ? '' : 's'} imported.`);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" onKeyDown={(e) => e.key === 'Escape' && onClose()} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <button type="button" className="icon-btn dialog-close" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        <h2 id="import-title" className="dialog-title">Import contacts</h2>
        {result ? (
          <div className="import-result">
            <p><strong>{result.imported}</strong> imported{result.skipped ? <>, <strong>{result.skipped}</strong> skipped because the address is already in your contacts</> : null}.</p>
            {result.errors.length > 0 && (
              <>
                <p className="muted">{result.errors.length} could not be imported:</p>
                <ul className="error-list">{result.errors.slice(0, 50).map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul>
              </>
            )}
            <div className="form-actions"><button type="button" className="primary" onClick={onClose} autoFocus>Done</button></div>
          </div>
        ) : csvText !== null ? (
          <form onSubmit={submit} className="import-form">
            <p className="muted">Choose what each column becomes. At least a name or an email column is needed.</p>
            <label className="radio">
              <input type="checkbox" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); startHeader(csvText, e.target.checked); }} />
              {' '}The first row is column names
            </label>
            <div className="csv-map" role="group" aria-label="Column mapping">
              {headers.map((h, i) => (
                <div className="csv-map-row" key={i}>
                  <span className="csv-map-head" dir="auto">
                    <strong className="ellipsis">{h || `Column ${i + 1}`}</strong>
                    {preview[i] ? <small className="muted ellipsis">e.g. {preview[i]}</small> : null}
                  </span>
                  <select aria-label={`Import “${h || `Column ${i + 1}`}” as`} value={fields[i] ?? 'ignore'} onChange={(e) => setField(i, e.target.value as CsvField)}>
                    {FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {err && <div className="notice error" role="alert">{Icon.alert}<span>{err}</span></div>}
            <div className="form-actions">
              <button type="button" className="ghost" onClick={() => { setFile(null); setCsvText(null); setFields([]); setErr(''); }}>Back</button>
              <button className="primary" disabled={busy || !mappingUsable(mapping)}>{busy ? 'Importing…' : 'Import'}</button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit} className="import-form">
            <p className="muted">Choose a vCard file (.vcf) exported from Outlook, Gmail, Apple Contacts or another webmail, or a CSV file (.csv) with one contact per row.</p>
            <input type="file" accept=".vcf,.csv,text/vcard,text/x-vcard,text/csv" aria-label="vCard or CSV file" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} autoFocus />
            <fieldset className="field">
              <legend>If an address is already in your contacts</legend>
              <label className="radio"><input type="radio" name="dup" checked={duplicates === 'skip'} onChange={() => setDuplicates('skip')} /> Skip that contact</label>
              <label className="radio"><input type="radio" name="dup" checked={duplicates === 'add'} onChange={() => setDuplicates('add')} /> Add it anyway</label>
            </fieldset>
            {err && <div className="notice error" role="alert">{Icon.alert}<span>{err}</span></div>}
            <div className="form-actions">
              <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!file || busy}>{file && isCsv(file) ? 'Continue' : busy ? 'Importing…' : 'Import'}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
