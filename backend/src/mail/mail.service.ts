import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FetchMessageObject, ImapFlow, MessageAddressObject, MessageStructureObject } from 'imapflow';
import type { Readable } from 'node:stream';
import { safeFilename } from '../security/filename';
import { htmlToRoughText, isHtmlTooComplex, sanitizeEmailHtml } from '../security/sanitize';
import { CID_LIMITS, inlineCidImages } from './cid-images';
import { MailboxCreds, openImap, withSmtp } from './connections';
import { decodePart } from './decode-part';
import { MailError, normalizeMailError } from './mail-errors';
import { assertFolder, decodeMessageId, encodeMessageId, type MessageRef } from './message-id';
import { isProtectedFolder, parseBulk, validateFolderName } from './folder-ops';
import { buildDraftMime, buildSendMime, parseOutgoing, type Outgoing, type OutgoingInput } from './outgoing';
import { saveSentCopy, type SentCopy } from './sent-copy';
import { MAX_SEARCH_RESULTS, searchCriteria } from './search';

const MAX_PAGE_SIZE = 100;
// Cross-folder search caps (E09): bounded per folder, in total and in time.
const SEARCH_ALL_MAX_FOLDERS = 50;
const SEARCH_ALL_PER_FOLDER = 50;
const SEARCH_ALL_MAX_RESULTS = 200;
const SEARCH_ALL_TIME_MS = 10_000;

/** One message list entry from envelope headers; `uid` is dropped before the response. */
function summarize(m: FetchMessageObject, folder: string, uidValidity: bigint) {
  const from = m.envelope?.from?.[0];
  const to = m.envelope?.to?.[0];
  return {
    id: encodeMessageId(folder, uidValidity, m.uid),
    subject: m.envelope?.subject ?? '(no subject)',
    from: { name: from?.name ?? '', address: from?.address ?? '' },
    // First recipient: Sent and Drafts show who a message is for.
    to: { name: to?.name ?? '', address: to?.address ?? '' },
    toCount: (m.envelope?.to?.length ?? 0) + (m.envelope?.cc?.length ?? 0),
    date: m.envelope?.date ?? null,
    seen: m.flags?.has('\\Seen') ?? false,
    flagged: m.flags?.has('\\Flagged') ?? false,
    hasAttachment: classifyParts(m.bodyStructure).attachments.some((a) => !a.inline),
    uid: m.uid,
  };
}
// Fetch policy (CLAUDE.md rule 10, D1): only text parts are read when a message is
// opened, each capped; attachments are streamed one part at a time, on request.
const MAX_TEXT_BYTES = Number(process.env.MAIL_MAX_TEXT_BYTES ?? 2 * 1024 * 1024);
const MAX_ATTACHMENT_BYTES = Number(process.env.MAIL_MAX_ATTACHMENT_BYTES ?? 50 * 1024 * 1024);
const MAX_RAW_BYTES = Number(process.env.MAIL_MAX_RAW_BYTES ?? 50 * 1024 * 1024);
const PART_ID = /^\d{1,4}(\.\d{1,4}){0,20}$/;

interface PartInfo {
  part: string;
  contentType: string;
  filename: string;
  size: number;
  inline: boolean;
  contentId: string | null;
  encoding: string | undefined;
  charset: string | undefined;
}

// Names for parts that arrive without one (bounces and receipts are made of these).
const NAMED_TYPES: Record<string, string> = {
  'message/delivery-status': 'delivery-report.txt',
  'message/global-delivery-status': 'delivery-report.txt',
  'message/disposition-notification': 'read-receipt.txt',
  'message/rfc822': 'attached-message.eml',
  'message/global': 'attached-message.eml',
  'text/rfc822-headers': 'original-headers.txt',
  'text/calendar': 'invitation.ics',
};
const EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};
const fallbackName = (type: string, part: string) =>
  NAMED_TYPES[type] ?? `attachment-${part}${EXTENSIONS[type] ? `.${EXTENSIONS[type]}` : ''}`;

/** Splits a body structure into the displayable text/html parts and everything else. */
export function classifyParts(root: MessageStructureObject | undefined) {
  let text: PartInfo | undefined;
  let html: PartInfo | undefined;
  const attachments: PartInfo[] = [];
  const visit = (node: MessageStructureObject) => {
    const type = (node.type ?? '').toLowerCase();
    // An attached email is one attachment; its own parts are not shown inline.
    if (node.childNodes?.length && type !== 'message/rfc822') {
      for (const c of node.childNodes) visit(c);
      return;
    }
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    const info: PartInfo = {
      part: node.part ?? '1',
      contentType: type,
      filename: safeFilename(filename, fallbackName(type, node.part ?? '1')),
      size: node.encoding === 'base64' && node.size ? Math.floor((node.size * 3) / 4) : node.size ?? 0,
      inline: node.disposition === 'inline',
      contentId: node.id ? node.id.replace(/^<|>$/g, '') : null,
      encoding: node.encoding,
      charset: node.parameters?.charset,
    };
    const bodyCandidate = node.disposition !== 'attachment' && !filename;
    if (bodyCandidate && type === 'text/plain' && !text) text = info;
    else if (bodyCandidate && type === 'text/html' && !html) html = info;
    else attachments.push(info);
  };
  if (root) visit(root);
  return { text, html, attachments };
}

const addr = (list?: MessageAddressObject[]) => (list ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));

async function readCapped(stream: Readable, max: number, as: BufferEncoding = 'utf8'): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + b.length > max) {
      chunks.push(b.subarray(0, max - size));
      truncated = true;
      stream.destroy();
      break;
    }
    chunks.push(b);
    size += b.length;
  }
  return { text: Buffer.concat(chunks).toString(as), truncated };
}

/** Reads a stream into a Buffer, stopping one byte past `max` so oversize is detectable. */
async function readBuffer(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(b.subarray(0, max + 1 - size));
    size += b.length;
    if (size > max) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Mailbox operations. Every IMAP/SMTP error is converted to a stable code (FOX-028)
 * and message ids carry UIDVALIDITY, checked before every action (FOX-027).
 * Prototype strategy: one short-lived IMAP connection per request (pooling: FOX-029).
 */
@Injectable()
export class MailService {
  private async withImap<T>(c: MailboxCreds, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    let client: ImapFlow | undefined;
    try {
      client = await openImap(c);
      return await fn(client);
    } catch (e) {
      throw normalizeMailError(e);
    } finally {
      if (client) await client.logout().catch(() => client?.close());
    }
  }

  /** Opens the message's folder and refuses to act if UIDVALIDITY changed since the id was issued. */
  private async withMessage<T>(c: MailboxCreds, id: unknown, fn: (client: ImapFlow, ref: MessageRef) => Promise<T>): Promise<T> {
    const ref = decodeMessageId(id);
    return this.withImap(c, async (client) => {
      const lock = await client.getMailboxLock(ref.folder);
      try {
        const current = client.mailbox ? BigInt(client.mailbox.uidValidity) : 0n;
        if (current !== ref.uidValidity) {
          throw new MailError('folder_reset', 409, 'This folder was reset on the mail server. Reload the message list.');
        }
        return await fn(client, ref);
      } finally {
        lock.release();
      }
    });
  }

  /** Verify credentials for login: IMAP auth + SMTP auth (AUTH-002, AUTH-003). Raw errors, for the auth log. */
  async verifyLogin(c: MailboxCreds): Promise<void> {
    const client = await openImap(c);
    await client.logout().catch(() => client.close());
    await withSmtp(c, (t) => t.verify());
  }

  async listFolders(c: MailboxCreds) {
    return this.withImap(c, async (client) => {
      const boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
      return boxes.map((b) => ({
        path: b.path,
        name: b.name,
        // Folder role from IMAP SPECIAL-USE first; the library falls back to well-known names (PRD Module 2).
        specialUse: b.specialUse ?? (b.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null),
        delimiter: b.delimiter,
        parentPath: b.parentPath,
        // Container-only folders (\Noselect) hold subfolders but no messages.
        selectable: !b.flags?.has('\\Noselect') && !b.flags?.has('\\NonExistent'),
        total: b.status?.messages ?? 0,
        unseen: b.status?.unseen ?? 0,
      }));
    });
  }

  /** New folder, at the top level or inside another folder (FOX-038). */
  async createFolder(c: MailboxCreds, nameRaw: unknown, parentRaw?: unknown): Promise<{ path: string }> {
    return this.withImap(c, async (client) => {
      const boxes = await client.list();
      const delimiter = boxes[0]?.delimiter ?? '/';
      const name = validateFolderName(nameRaw, delimiter);
      let path = name;
      if (parentRaw !== undefined && parentRaw !== null && parentRaw !== '') {
        const parent = boxes.find((b) => b.path === assertFolder(parentRaw));
        if (!parent) throw new MailError('folder_not_found', 404, 'Folder not found.');
        if (parent.flags?.has('\\Noinferiors')) throw new BadRequestException('This folder cannot hold subfolders.');
        path = `${parent.path}${parent.delimiter}${name}`;
      }
      if (boxes.some((b) => b.path.toLowerCase() === path.toLowerCase())) throw new BadRequestException('A folder with that name already exists here.');
      await client.mailboxCreate(path);
      await client.mailboxSubscribe(path).catch(() => undefined);
      return { path };
    });
  }

  /** Renames a folder in place (keeps its parent). Folders with a role cannot be renamed. */
  async renameFolder(c: MailboxCreds, pathRaw: unknown, nameRaw: unknown): Promise<{ path: string }> {
    const path = assertFolder(pathRaw);
    return this.withImap(c, async (client) => {
      const boxes = await client.list();
      const box = boxes.find((b) => b.path === path);
      if (!box) throw new MailError('folder_not_found', 404, 'Folder not found.');
      if (isProtectedFolder(box)) throw new BadRequestException('This folder cannot be renamed.');
      const name = validateFolderName(nameRaw, box.delimiter);
      const newPath = box.parentPath ? `${box.parentPath}${box.delimiter}${name}` : name;
      if (newPath === path) return { path };
      if (boxes.some((b) => b.path.toLowerCase() === newPath.toLowerCase())) throw new BadRequestException('A folder with that name already exists here.');
      await client.mailboxRename(path, newPath);
      return { path: newPath };
    });
  }

  /** Deletes a folder and the messages in it. Folders with a role or with subfolders are refused. */
  async deleteFolder(c: MailboxCreds, pathRaw: unknown): Promise<void> {
    const path = assertFolder(pathRaw);
    await this.withImap(c, async (client) => {
      const boxes = await client.list();
      const box = boxes.find((b) => b.path === path);
      if (!box) throw new MailError('folder_not_found', 404, 'Folder not found.');
      if (isProtectedFolder(box)) throw new BadRequestException('This folder cannot be deleted.');
      if (boxes.some((b) => b.parentPath === path)) throw new BadRequestException('Delete or move the folders inside it first.');
      await client.mailboxDelete(path);
    });
  }

  /**
   * One action on up to 500 messages of one folder, in a single connection (FOX-037).
   * Moves return the new ids so the client can offer Undo.
   */
  async bulk(c: MailboxCreds, body: unknown): Promise<{ newIds: string[]; target?: string; created?: boolean }> {
    const req = parseBulk(body);
    return this.withImap(c, async (client) => {
      const boxes = await client.list();
      const role = (use: string) => boxes.find((b) => b.specialUse === use);
      let target: string | undefined;
      let created = false;
      if (req.action === 'move') {
        if (!boxes.some((b) => b.path === req.target)) throw new MailError('folder_not_found', 404, 'Folder not found.');
        target = req.target;
      } else if (req.action === 'archive') {
        target = role('\\Archive')?.path;
        if (!target) {
          // No Archive folder yet: create one, as Roundcube and Gmail-style clients do.
          await client.mailboxCreate('Archive');
          await client.mailboxSubscribe('Archive').catch(() => undefined);
          target = 'Archive';
          created = true;
        }
      } else if (req.action === 'junk') {
        target = role('\\Junk')?.path;
        if (!target) throw new MailError('folder_not_found', 404, 'There is no Junk folder on the mail server.');
      } else if (req.action === 'notjunk') {
        target = 'INBOX';
      } else if (req.action === 'delete') {
        const trash = role('\\Trash')?.path;
        target = trash && trash !== req.folder ? trash : undefined; // in Trash (or none): delete for good
      }

      const lock = await client.getMailboxLock(req.folder);
      try {
        const current = client.mailbox ? BigInt(client.mailbox.uidValidity) : 0n;
        if (current !== req.uidValidity) throw new MailError('folder_reset', 409, 'This folder was reset on the mail server. Reload the message list.');
        const uids = req.uids.join(',');
        const flag = async (name: string, on: boolean) =>
          on ? client.messageFlagsAdd(uids, [name], { uid: true }) : client.messageFlagsRemove(uids, [name], { uid: true });
        switch (req.action) {
          case 'seen': await flag('\\Seen', true); return { newIds: [] };
          case 'unseen': await flag('\\Seen', false); return { newIds: [] };
          case 'flag': await flag('\\Flagged', true); return { newIds: [] };
          case 'unflag': await flag('\\Flagged', false); return { newIds: [] };
        }
        if (!target) {
          await client.messageDelete(uids, { uid: true });
          return { newIds: [] };
        }
        if (target === req.folder) return { newIds: [], target };
        const res = await client.messageMove(uids, target, { uid: true });
        const newIds = res && res.uidValidity && res.uidMap
          ? req.uids.map((u) => res.uidMap!.get(u)).filter((u): u is number => !!u).map((u) => encodeMessageId(target!, res.uidValidity!, u))
          : [];
        return { newIds, target, ...(created ? { created } : {}) };
      } finally {
        lock.release();
      }
    });
  }

  /** Storage used and allowed (FOX-137); null when the server does not report a quota. */
  async quota(c: MailboxCreds): Promise<{ quota: { used: number; limit: number | null } | null }> {
    return this.withImap(c, async (client) => {
      if (!client.capabilities.has('QUOTA')) return { quota: null };
      const q = await client.getQuota('INBOX').catch(() => false as const);
      if (!q || !q.storage || typeof q.storage.usage !== 'number') return { quota: null };
      return { quota: { used: q.storage.usage, limit: typeof q.storage.limit === 'number' && q.storage.limit > 0 ? q.storage.limit : null } };
    });
  }

  async listMessages(c: MailboxCreds, folderRaw: string, page: number, pageSize: number, query?: unknown) {
    const folder = assertFolder(folderRaw);
    const criteria = searchCriteria(query);
    page = Math.max(1, Math.floor(page) || 1);
    pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || 25));

    return this.withImap(c, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const box = client.mailbox;
        if (!box) throw new NotFoundException();
        const uidValidity = String(box.uidValidity);
        let total = box.exists;
        let range: string;
        let byUid = false;
        if (criteria) {
          // Search runs on the server; newest first, capped so a broad search stays cheap.
          const found = (await client.search(criteria, { uid: true })) || [];
          const uids = found.sort((a, b) => b - a).slice(0, MAX_SEARCH_RESULTS);
          total = uids.length;
          const pageUids = uids.slice((page - 1) * pageSize, page * pageSize);
          if (!pageUids.length) return { uidValidity, total, items: [] };
          range = pageUids.join(',');
          byUid = true;
        } else {
          const end = total - (page - 1) * pageSize;
          if (end < 1) return { uidValidity, total, items: [] };
          range = `${Math.max(1, end - pageSize + 1)}:${end}`;
        }

        const items = [];
        // Headers/envelope only; bodies are fetched when a message is opened. A sequence
        // range only pages the plain list; every item is identified by UID.
        for await (const m of client.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: byUid })) {
          items.push(summarize(m, folder, box.uidValidity));
        }
        items.sort((a, b) => b.uid - a.uid);
        return { uidValidity, total, items: items.map(({ uid: _uid, ...rest }) => rest) };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Search across every folder (E09). Bounded per folder, in total and in time, so a
   * broad search cannot hold the connection for long; `truncated` tells the client
   * when there is more than what is shown.
   */
  async searchAllFolders(c: MailboxCreds, query: unknown) {
    const criteria = searchCriteria(query);
    if (!criteria) throw new BadRequestException('search text required');
    return this.withImap(c, async (client) => {
      const selectable = (await client.list()).filter((f) => !f.flags?.has('\\Noselect'));
      let truncated = selectable.length > SEARCH_ALL_MAX_FOLDERS;
      const folders = selectable.slice(0, SEARCH_ALL_MAX_FOLDERS);
      const started = Date.now();
      const items: (ReturnType<typeof summarize> & { folder: string })[] = [];
      for (const f of folders) {
        if (Date.now() - started > SEARCH_ALL_TIME_MS || items.length >= SEARCH_ALL_MAX_RESULTS) {
          truncated = true;
          break;
        }
        let lock;
        try {
          lock = await client.getMailboxLock(f.path);
        } catch {
          continue; // a folder that cannot be opened is skipped, not fatal
        }
        try {
          const box = client.mailbox;
          if (!box) continue;
          const found = (await client.search(criteria, { uid: true }).catch(() => null)) || [];
          if (!found.length) continue;
          const uids = found.sort((a, b) => b - a).slice(0, SEARCH_ALL_PER_FOLDER);
          if (found.length > uids.length) truncated = true;
          for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
            items.push({ ...summarize(m, f.path, box.uidValidity), folder: f.path });
          }
        } finally {
          lock.release();
        }
      }
      items.sort((a, b) => (b.date ? +new Date(b.date) : 0) - (a.date ? +new Date(a.date) : 0));
      const shown = items.slice(0, SEARCH_ALL_MAX_RESULTS).map(({ uid: _uid, ...rest }) => rest);
      return { items: shown, total: shown.length, truncated: truncated || items.length > shown.length };
    });
  }

  async getMessage(c: MailboxCreds, id: unknown) {
    return this.withMessage(c, id, async (client, ref) => {
      const uid = String(ref.uid);
      const msg = await client.fetchOne(uid, { uid: true, envelope: true, bodyStructure: true, flags: true, size: true }, { uid: true });
      if (!msg) throw new NotFoundException();
      const { text, html, attachments } = classifyParts(msg.bodyStructure);

      const read = async (p?: PartInfo) => {
        if (!p) return null;
        const d = await client.download(uid, p.part, { uid: true, maxBytes: MAX_TEXT_BYTES });
        if (!d.content) return null;
        if ((d.meta.contentType ?? '').toLowerCase() === p.contentType) return readCapped(d.content, MAX_TEXT_BYTES);
        // The server answered BODY[part.MIME] with headers of another part, so imapflow
        // could not decode it: decode from BODYSTRUCTURE instead (seen on GreenMail).
        const raw = await readCapped(d.content, MAX_TEXT_BYTES, 'latin1');
        return { text: decodePart(Buffer.from(raw.text, 'latin1'), p.encoding, p.charset), truncated: raw.truncated };
      };
      const textBody = await read(text);
      const htmlBody = await read(html);

      // Markup that would block the server while sanitizing is shown as plain text instead.
      const htmlTooComplex = !!htmlBody && isHtmlTooComplex(htmlBody.text);
      // Referenced cid: images become data: URIs in the HTML (FOX-048); refused or
      // unreferenced parts stay in the attachment list. Skipped when the HTML will
      // not be shown anyway (too complex): no fetches for an unused body.
      let htmlText = !htmlTooComplex ? htmlBody?.text ?? null : null;
      let inlined = new Set<string>();
      if (htmlText && attachments.some((a) => a.contentId)) {
        const r = await inlineCidImages(htmlText, attachments, async (p) => {
          const d = await client.download(uid, p.part, { uid: true, maxBytes: CID_LIMITS.maxImageBytes + 1 });
          return d.content ? readBuffer(d.content, CID_LIMITS.maxImageBytes) : null;
        });
        htmlText = r.html;
        inlined = r.inlinedParts;
      }
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });

      const env = msg.envelope;
      const bodyText = textBody?.text || (htmlTooComplex ? htmlToRoughText(htmlBody!.text) : '');
      return {
        id: encodeMessageId(ref.folder, ref.uidValidity, ref.uid),
        subject: env?.subject ?? '(no subject)',
        from: addr(env?.from),
        to: addr(env?.to),
        cc: addr(env?.cc),
        bcc: addr(env?.bcc),
        replyTo: addr(env?.replyTo),
        date: env?.date ?? null,
        messageId: env?.messageId ?? null,
        inReplyTo: env?.inReplyTo ?? null,
        flagged: msg.flags?.has('\\Flagged') ?? false,
        text: bodyText,
        // Untrusted: sanitized here, then rendered in a sandboxed iframe by the UI.
        html: htmlText !== null ? sanitizeEmailHtml(htmlText) : null,
        htmlTooComplex,
        truncated: !!(textBody?.truncated || htmlBody?.truncated),
        attachments: attachments
          .filter((a) => !inlined.has(a.part))
          .map((a) => ({ part: a.part, filename: a.filename, size: a.size, contentType: a.contentType, inline: a.inline })),
      };
    });
  }

  /** Streams one attachment part to `sink` without buffering the message (D1). */
  async streamAttachment(c: MailboxCreds, id: unknown, partRaw: unknown, onStart: (filename: string) => NodeJS.WritableStream) {
    if (typeof partRaw !== 'string' || !PART_ID.test(partRaw)) throw new BadRequestException('invalid part');
    return this.withMessage(c, id, async (client, ref) => {
      const uid = String(ref.uid);
      const msg = await client.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
      const part = msg ? classifyParts(msg.bodyStructure).attachments.find((a) => a.part === partRaw) : undefined;
      if (!part) throw new NotFoundException();
      const d = await client.download(uid, part.part, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES });
      if (!d.content) throw new NotFoundException();
      const sink = onStart(part.filename);
      await new Promise<void>((resolve, reject) => {
        d.content.on('error', reject);
        sink.on('error', reject);
        sink.on('finish', resolve);
        d.content.pipe(sink);
      });
    });
  }

  /**
   * Streams the complete raw message (RFC 822 source) as a .eml download (D-014).
   * Refuses over-limit messages up front instead of truncating silently.
   */
  async streamRaw(c: MailboxCreds, id: unknown, onStart: (filename: string) => NodeJS.WritableStream) {
    return this.withMessage(c, id, async (client, ref) => {
      const uid = String(ref.uid);
      const msg = await client.fetchOne(uid, { uid: true, envelope: true, size: true }, { uid: true });
      if (!msg) throw new NotFoundException();
      if ((msg.size ?? 0) > MAX_RAW_BYTES) {
        throw new MailError('message_too_large', 413, 'This message is too large to download.');
      }
      // Part omitted = the entire rfc822 message. One byte past the cap so an
      // overflow is detectable: RFC822.SIZE can be absent or under-reported, and a
      // truncated .eml that looks complete is worse than a failed download.
      const d = await client.download(uid, undefined, { uid: true, maxBytes: MAX_RAW_BYTES + 1 });
      if (!d.content) throw new NotFoundException();
      const base = safeFilename(msg.envelope?.subject, 'message').replace(/\.eml$/i, '');
      const sink = onStart(`${base}.eml`);
      await new Promise<void>((resolve, reject) => {
        let sent = 0;
        d.content.on('data', (chunk: Buffer) => {
          sent += chunk.length;
          if (sent > MAX_RAW_BYTES) d.content.destroy(new Error('raw message exceeds the download limit'));
        });
        d.content.on('error', reject);
        sink.on('error', reject);
        sink.on('finish', resolve);
        d.content.pipe(sink);
      });
    });
  }

  async setFlags(c: MailboxCreds, id: unknown, f: { seen?: boolean; flagged?: boolean }) {
    await this.withMessage(c, id, async (client, ref) => {
      const uid = String(ref.uid);
      const set = async (flag: string, on?: boolean) => {
        if (on === true) await client.messageFlagsAdd(uid, [flag], { uid: true });
        if (on === false) await client.messageFlagsRemove(uid, [flag], { uid: true });
      };
      await set('\\Seen', f.seen);
      await set('\\Flagged', f.flagged);
    });
  }

  /** Moves to Trash (returns the id there, for Undo), or deletes for good when already in Trash. */
  async deleteMessage(c: MailboxCreds, id: unknown): Promise<{ trashId: string | null }> {
    return this.withMessage(c, id, async (client, ref) => {
      const boxes = await client.list();
      const trash = boxes.find((b) => b.specialUse === '\\Trash');
      if (trash && trash.path !== ref.folder) {
        const res = await client.messageMove(String(ref.uid), trash.path, { uid: true });
        const newUid = res && res.uidMap?.get(ref.uid);
        return { trashId: res && newUid && res.uidValidity ? encodeMessageId(trash.path, res.uidValidity, newUid) : null };
      }
      await client.messageDelete(String(ref.uid), { uid: true }); // already in Trash: permanent
      return { trashId: null };
    });
  }

  /**
   * Sends a message, then keeps a copy in the Sent folder (OPEN-4) unless the server does
   * that itself. The copy is the same message (same Message-ID and Date) with Bcc kept.
   * A failed copy never fails or repeats the send; `sentCopy` tells the client what happened.
   */
  async send(c: MailboxCreds, m: OutgoingInput, fromName?: string): Promise<Outgoing & { sentCopy: SentCopy }> {
    const out = parseOutgoing(m, 'send');
    const mime = await buildSendMime(c.email, fromName, out);
    try {
      // From is ALWAYS the authenticated mailbox: users cannot spoof other senders (prototype policy).
      // The name is validated in preferences (no control characters, no address look-alikes).
      await withSmtp(c, (t) => t.sendMail({ envelope: mime.envelope, raw: mime.smtpRaw }));
    } catch (e) {
      throw normalizeMailError(e);
    }
    let sentCopy: SentCopy = 'server';
    if (!c.server.savesSent) {
      sentCopy = await this.withImap(c, (client) => saveSentCopy(client, mime.copyRaw)).catch((): SentCopy => 'failed');
    }
    return { ...out, sentCopy };
  }

  private async specialFolder(client: ImapFlow, use: string): Promise<string> {
    const box = (await client.list()).find((b) => b.specialUse === use);
    if (!box) throw new MailError('folder_not_found', 404, `There is no ${use.slice(1)} folder on the mail server.`);
    return box.path;
  }

  /**
   * Saves a draft to the Drafts folder with IMAP APPEND (FOX-055). When `replaceId` names an
   * earlier version, it is removed after the new one is stored, so nothing is lost if a
   * step fails. Only messages in the Drafts folder can be replaced.
   */
  async saveDraft(c: MailboxCreds, m: OutgoingInput & { replaceId?: unknown }, fromName?: string): Promise<{ id: string }> {
    const draft = parseOutgoing(m, 'draft');
    const replace = m.replaceId === undefined || m.replaceId === null ? null : decodeMessageId(m.replaceId);
    const { raw, messageId } = await buildDraftMime(c.email, fromName, draft);
    return this.withImap(c, async (client) => {
      const drafts = await this.specialFolder(client, '\\Drafts');
      if (replace && replace.folder !== drafts) throw new BadRequestException('only drafts can be replaced');
      const res = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
      const lock = await client.getMailboxLock(drafts);
      try {
        const uidValidity = BigInt(client.mailbox ? client.mailbox.uidValidity : 0);
        let uid = res && res.uid && res.uidValidity === uidValidity ? res.uid : undefined;
        if (!uid) {
          // No UIDPLUS: find the new draft by its Message-ID.
          const found = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
          uid = found.sort((a, b) => b - a)[0];
        }
        if (!uid) throw new MailError('mail_protocol_error', 502, 'The mail server did not confirm the saved draft.');
        if (replace && replace.uidValidity === uidValidity && replace.uid !== uid) {
          await client.messageDelete(String(replace.uid), { uid: true });
        }
        return { id: encodeMessageId(drafts, uidValidity, uid) };
      } finally {
        lock.release();
      }
    });
  }

  /** Removes a draft for good (after sending it, or when the user discards it). */
  async deleteDraft(c: MailboxCreds, id: unknown): Promise<void> {
    const ref = decodeMessageId(id);
    await this.withImap(c, async (client) => {
      if (ref.folder !== (await this.specialFolder(client, '\\Drafts'))) throw new BadRequestException('not a draft');
    });
    await this.withMessage(c, id, (client, r) => client.messageDelete(String(r.uid), { uid: true }).then(() => undefined));
  }

  /** Moves a message to another existing folder (FOX-035, single message). Returns its new id when the server reports it. */
  async moveMessage(c: MailboxCreds, id: unknown, folderRaw: unknown): Promise<{ id: string | null }> {
    const target = assertFolder(folderRaw);
    const ref = decodeMessageId(id);
    if (target === ref.folder) return { id: String(id) };
    return this.withMessage(c, id, async (client) => {
      if (!(await client.list()).some((b) => b.path === target)) throw new MailError('folder_not_found', 404, 'Folder not found.');
      const res = await client.messageMove(String(ref.uid), target, { uid: true });
      const newUid = res && res.uidMap?.get(ref.uid);
      return { id: res && newUid && res.uidValidity ? encodeMessageId(target, res.uidValidity, newUid) : null };
    });
  }
}
