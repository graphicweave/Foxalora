import { BadRequestException } from '@nestjs/common';
import { MAX_EMAILS_PER_CONTACT, parseContactInput, type ContactInput } from './contact-input';

/**
 * CSV contact import (FOX-074). Pure parser in the shape of vcard.ts: valid rows
 * become contacts, broken rows become errors without stopping the import. The
 * column mapping comes from the client's mapping step; headers are only used to
 * guess defaults and address labels.
 */
export const MAX_CSV_BYTES = 2_000_000;
export const MAX_CSV_ROWS = 5000;
export const MAX_CSV_COLUMNS = 100;

export type CsvField = 'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'company';

export interface CsvMapping {
  name?: number;
  firstName?: number;
  lastName?: number;
  email?: number[];
  phone?: number;
  company?: number;
}

/** RFC 4180-style parse: quoted fields, doubled quotes, CR/LF/CRLF rows; comma, semicolon or tab delimited. */
export function parseCsv(input: unknown): string[][] {
  if (typeof input !== 'string' || !input.trim()) throw new BadRequestException('the CSV file is empty');
  if (Buffer.byteLength(input, 'utf8') > MAX_CSV_BYTES) throw new BadRequestException('the CSV file is too large (max 2 MB)');
  const text = input.replace(/^\uFEFF/, '');

  // Delimiter: whichever of , ; tab appears most on the first line, outside quotes.
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuote = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== '')) {
      if (rows.length >= MAX_CSV_ROWS + 1) throw new BadRequestException(`a CSV file holds at most ${MAX_CSV_ROWS} contacts`);
      if (row.length > MAX_CSV_COLUMNS) throw new BadRequestException(`a CSV row holds at most ${MAX_CSV_COLUMNS} columns`);
      rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === delim) endField();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) endRow();
  if (!rows.length) throw new BadRequestException('the CSV file is empty');
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Guesses which contact field a CSV header belongs to; null = not imported. */
export function guessField(header: string): CsvField | null {
  const h = norm(header);
  if (!h) return null;
  // "E-mail 1 - Label", "Phone 1 - Type" (Google/Outlook) hold labels, not values.
  if (/\b(label|type)\b/.test(h)) return null;
  if (/^e ?mail( address)?( \d+)?$/.test(h) || /\be ?mail\b/.test(h)) return 'email';
  if (/^(display )?name$|^full ?name$|^contact( name)?$/.test(h)) return 'name';
  if (/^(first|given)( name)?$/.test(h)) return 'firstName';
  if (/^(last|family|sur)( ?name)?$|^surname$/.test(h)) return 'lastName';
  if (/\b(phone|telephone|mobile|cell|tel)\b/.test(h)) return 'phone';
  if (/^(company|organi[sz]ation|org|employer)$/.test(h)) return 'company';
  return null;
}

/** Address label from a header name, matching the vCard label set. */
const emailLabel = (header: string): string => {
  const h = norm(header);
  if (/\bhome\b|\bpersonal\b/.test(h)) return 'home';
  if (/\bwork\b|\bbusiness\b|\boffice\b/.test(h)) return 'work';
  return '';
};

function parseMapping(raw: unknown, columns: number): CsvMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('a column mapping is required');
  const b = raw as Record<string, unknown>;
  const col = (v: unknown, field: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= columns) throw new BadRequestException(`the ${field} column is not in the file`);
    return n;
  };
  const emailsRaw = b.email === undefined || b.email === null ? [] : b.email;
  if (!Array.isArray(emailsRaw) || emailsRaw.length > MAX_EMAILS_PER_CONTACT) throw new BadRequestException('too many email columns');
  const email = emailsRaw.map((v) => col(v, 'email')).filter((n): n is number => n !== undefined);
  return {
    name: col(b.name, 'name'),
    firstName: col(b.firstName, 'first name'),
    lastName: col(b.lastName, 'last name'),
    phone: col(b.phone, 'phone'),
    company: col(b.company, 'company'),
    email,
  };
}

/**
 * Turns CSV text + a column mapping into contacts. Row errors are collected, not
 * fatal (FOX-074: errors listed without losing valid rows).
 */
export function csvToContacts(csv: unknown, mappingRaw: unknown, hasHeader = true): { contacts: ContactInput[]; errors: string[] } {
  const rows = parseCsv(csv);
  const header = hasHeader ? rows[0] : [];
  const data = hasHeader ? rows.slice(1) : rows;
  const columns = Math.max(header.length, ...data.map((r) => r.length), 1);
  const m = parseMapping(mappingRaw, columns);
  if (m.name === undefined && m.firstName === undefined && m.lastName === undefined && !m.email!.length) {
    throw new BadRequestException('map at least a name or an email column');
  }

  const contacts: ContactInput[] = [];
  const errors: string[] = [];
  data.forEach((row, i) => {
    const cell = (n?: number) => (n === undefined ? '' : (row[n] ?? '').trim());
    const name = cell(m.name) || [cell(m.firstName), cell(m.lastName)].filter(Boolean).join(' ');
    const emails = m.email!
      .map((n) => ({ email: cell(n), label: hasHeader ? emailLabel(header[n] ?? '') : '' }))
      .filter((e) => e.email !== '');
    if (!name && !emails.length) return; // nothing of this row was mapped: not an error
    try {
      contacts.push(parseContactInput({ displayName: name, company: cell(m.company), phone: cell(m.phone), emails }));
    } catch (e) {
      const msg = e instanceof BadRequestException ? e.message.replace(/^Contact not saved: /, '') : 'not a valid contact';
      errors.push(`Row ${i + (hasHeader ? 2 : 1)}: ${msg}`);
    }
  });
  if (contacts.length > MAX_CSV_ROWS) throw new BadRequestException(`a CSV file holds at most ${MAX_CSV_ROWS} contacts`);
  return { contacts, errors };
}
