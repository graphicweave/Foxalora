// Client side of CSV contact import (FOX-074): reads just enough of the file to
// drive the column-mapping step. The real parse and validation happen server-side
// (backend/src/contacts/csv.ts); the two must agree on delimiters and quoting.

export type CsvField = 'ignore' | 'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'company';

export const FIELD_OPTIONS: { value: CsvField; label: string }[] = [
  { value: 'ignore', label: 'Do not import' },
  { value: 'name', label: 'Full name' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
  { value: 'email', label: 'Email address' },
  { value: 'phone', label: 'Phone' },
  { value: 'company', label: 'Company' },
];

/** Fields that hold at most one column; picking one elsewhere moves it. */
export const SINGLE_FIELDS: CsvField[] = ['name', 'firstName', 'lastName', 'phone', 'company'];

/** First rows of the file, quote-aware, with , ; or tab detected from the first line. */
export function parseFirstRows(text: string, maxRows: number): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const firstLine = t.slice(0, t.indexOf('\n') === -1 ? t.length : t.indexOf('\n'));
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
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < t.length && rows.length < maxRows; i++) {
    const ch = t[i];
    if (inQuote) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === delim) endField();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') field += ch;
  }
  if (rows.length < maxRows && (field !== '' || row.length)) endRow();
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Default assignment for a header name; mirrors the backend's guesses. */
export function guessField(header: string): CsvField {
  const h = norm(header);
  if (!h) return 'ignore';
  // "E-mail 1 - Label", "Phone 1 - Type" (Google/Outlook) hold labels, not values.
  if (/\b(label|type)\b/.test(h)) return 'ignore';
  if (/^e ?mail( address)?( \d+)?$/.test(h) || /\be ?mail\b/.test(h)) return 'email';
  if (/^(display )?name$|^full ?name$|^contact( name)?$/.test(h)) return 'name';
  if (/^(first|given)( name)?$/.test(h)) return 'firstName';
  if (/^(last|family|sur)( ?name)?$|^surname$/.test(h)) return 'lastName';
  if (/\b(phone|telephone|mobile|cell|tel)\b/.test(h)) return 'phone';
  if (/^(company|organi[sz]ation|org|employer)$/.test(h)) return 'company';
  return 'ignore';
}

/** Keeps only the first guess of each single field, so the selects show exactly what is submitted. */
export function dedupeSingles(fields: CsvField[]): CsvField[] {
  const used = new Set<CsvField>();
  return fields.map((f) => {
    if (f === 'ignore' || f === 'email') return f;
    if (used.has(f)) return 'ignore';
    used.add(f);
    return f;
  });
}

export interface CsvMapping { name?: number; firstName?: number; lastName?: number; email: number[]; phone?: number; company?: number }

/** The mapping the server expects, from the per-column assignments. */
export function buildMapping(fields: CsvField[]): CsvMapping {
  const m: CsvMapping = { email: [] };
  fields.forEach((f, i) => {
    if (f === 'email') m.email.push(i);
    else if (f !== 'ignore' && m[f] === undefined) m[f] = i;
  });
  return m;
}

/** A mapping that can import something: at least a name or one email column. */
export const mappingUsable = (m: CsvMapping) =>
  m.email.length > 0 || m.name !== undefined || m.firstName !== undefined || m.lastName !== undefined;
