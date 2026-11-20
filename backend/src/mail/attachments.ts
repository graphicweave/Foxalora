import { BadRequestException } from '@nestjs/common';
import { safeFilename } from '../security/filename';
import { sniff } from './inline-images';

export interface AttachmentInput {
  filename: string;
  contentType: string;
  /** base64 */
  data: string;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  contentDisposition: 'attachment';
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

// Extensions most receiving servers refuse because they run when opened (Gmail/Outlook lists).
const BLOCKED_EXTENSIONS = new Set([
  'ade', 'adp', 'apk', 'appx', 'bat', 'cab', 'chm', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'exe',
  'hta', 'ins', 'isp', 'iso', 'jar', 'js', 'jse', 'lib', 'lnk', 'mde', 'msc', 'msi', 'msix',
  'msp', 'mst', 'nsh', 'pif', 'ps1', 'scr', 'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'vxd',
  'wsc', 'wsf', 'wsh',
]);

/** Native executable formats by magic bytes, refused whatever the file is called. */
function isExecutable(b: Buffer): boolean {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true; // Windows PE ("MZ")
  if (b.length >= 4 && b[0] === 0x7f && b.subarray(1, 4).toString('latin1') === 'ELF') return true;
  if (b.length >= 4) {
    const magic = b.readUInt32BE(0);
    // Mach-O (both endiannesses, 32/64 bit) and universal binaries / Java class files.
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true;
  }
  return false;
}

/** Well-formed declared type, lowercased; anything odd becomes octet-stream. */
function declaredType(v: unknown): string {
  const t = String(v ?? '').toLowerCase().trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(t) && t.length <= 120 ? t : 'application/octet-stream';
}

/**
 * Validates regular file attachments on a message (CLAUDE.md rule 11): count and size
 * limits, safe file names, no executable extensions or executable content, and a
 * Content-Type taken from sniffing where possible, never trusted blindly.
 */
export function validateAttachments(list: unknown): OutgoingAttachment[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new BadRequestException('attachments must be a list');
  if (list.length > MAX_ATTACHMENTS) throw new BadRequestException(`too many attachments (max ${MAX_ATTACHMENTS})`);

  let total = 0;
  const out: OutgoingAttachment[] = [];
  for (const raw of list as AttachmentInput[]) {
    if (!raw || typeof raw !== 'object') throw new BadRequestException('invalid attachment');
    const filename = safeFilename(raw.filename);
    if (typeof raw.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) throw new BadRequestException('invalid attachment data');
    if (raw.data.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4) throw new BadRequestException('attachment too large (max 10 MB per file)');
    const content = Buffer.from(raw.data, 'base64');
    if (!content.length) throw new BadRequestException(`attachment is empty: ${filename}`);
    if (content.length > MAX_ATTACHMENT_BYTES) throw new BadRequestException('attachment too large (max 10 MB per file)');
    total += content.length;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) throw new BadRequestException('attachments too large in total (max 20 MB)');

    const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
    if (ext && BLOCKED_EXTENSIONS.has(ext)) throw new BadRequestException(`this file type cannot be sent: .${ext}`);
    if (isExecutable(content)) throw new BadRequestException(`programs cannot be sent as attachments: ${filename}`);

    out.push({ filename, contentType: sniff(content) ?? declaredType(raw.contentType), content, contentDisposition: 'attachment' });
  }
  return out;
}
