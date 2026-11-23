import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, validateAttachments } from '../src/mail/attachments';
import { parseOutgoing } from '../src/mail/outgoing';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const file = (filename: string, content: string | Buffer, contentType = 'application/octet-stream') => ({ filename, contentType, data: b64(content) });

describe('attachments (send; CLAUDE.md rule 11)', () => {
  it('accepts normal files and keeps a safe name and type', () => {
    const out = validateAttachments([
      file('report.pdf', '%PDF-1.7 fake', 'application/pdf'),
      file('../..\\windows/notes.txt', 'hello', 'text/plain'),
    ]);
    expect(out.map((a) => [a.filename, a.contentType])).toEqual([
      ['report.pdf', 'application/pdf'],
      ['notes.txt', 'text/plain'],
    ]);
    expect(out[0].contentDisposition).toBe('attachment');
    expect(out[1].content.toString()).toBe('hello');
  });

  it('uses the sniffed type for images, not the declared one', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const out = validateAttachments([{ filename: 'photo.png', contentType: 'text/plain', data: png.toString('base64') }]);
    expect(out[0].contentType).toBe('image/png');
  });

  it('turns a malformed declared type into octet-stream', () => {
    const out = validateAttachments([file('data.bin', 'x', 'text/html; charset="x" onload=hack')]);
    expect(out[0].contentType).toBe('application/octet-stream');
  });

  it('refuses executable extensions whatever the content', () => {
    for (const name of ['run.exe', 'setup.MSI', 'script.vbs', 'notes.txt.js', 'app.apk']) {
      expect(() => validateAttachments([file(name, 'just text')]), name).toThrow(BadRequestException);
    }
  });

  it('refuses executable content whatever the name', () => {
    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    const elf = Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(16)]);
    for (const [name, content] of [['report.pdf', pe], ['data.bin', elf]] as const) {
      expect(() => validateAttachments([file(name, content)]), name).toThrow(/programs cannot be sent/);
    }
  });

  it('enforces count, size, total size, base64 and non-empty rules', () => {
    expect(() => validateAttachments('x')).toThrow(BadRequestException);
    expect(() => validateAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`f${i}.txt`, 'x')))).toThrow(/too many/);
    expect(() => validateAttachments([{ filename: 'a.txt', contentType: 'text/plain', data: '@@not-base64@@' }])).toThrow(/invalid attachment data/);
    expect(() => validateAttachments([file('empty.txt', '')])).toThrow(/empty/);
    const half = Buffer.alloc(MAX_ATTACHMENT_BYTES); // 10 MB: allowed alone, three exceed the 20 MB total
    expect(() => validateAttachments([file('a.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))])).toThrow(/too large/);
    expect(validateAttachments([file('a.bin', half), file('b.bin', half)])).toHaveLength(2);
    expect(() => validateAttachments([file('a.bin', half), file('b.bin', half), file('c.txt', 'x')])).toThrow(/in total/);
  });

  it('is sent with a message but never kept in a draft', () => {
    const m = { to: ['dave@dovecot.test'], subject: 'x', text: 'x', attachments: [file('a.txt', 'hi', 'text/plain')] };
    expect(parseOutgoing(m, 'send').files).toHaveLength(1);
    expect(parseOutgoing(m, 'draft').files).toEqual([]);
  });
});

describe('attachment names that change on save (internal test 2026-11-23)', () => {
  const file = (filename: string) => ({ filename, contentType: 'text/plain', data: Buffer.from('echo hi').toString('base64') });
  it.each(['payload.bat.', 'payload.bat ', 'payload.bat. . ', 'x.exe::$DATA', 'x.ps1', 'x.vhd', 'x.reg', 'x.library-ms'])('refuses %j', (name) => {
    expect(() => validateAttachments([file(name)])).toThrow(/cannot be sent/);
  });
  it('keeps ordinary names', () => {
    expect(validateAttachments([file('notes.txt')])[0].filename).toBe('notes.txt');
  });
});
