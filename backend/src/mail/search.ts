import { BadRequestException } from '@nestjs/common';
import type { SearchObject } from 'imapflow';

/** Search box text: free words and `key:value` filters, matched by the mail server. */
export const MAX_SEARCH_LENGTH = 200;
/** A broad search on a huge mailbox stops here instead of paging through everything. */
export const MAX_SEARCH_RESULTS = 1000;

/** Filters the search box understands, mapped to IMAP SEARCH keys. */
const FILTER = /(^|\s)(from|to|subject|is|before|after):("[^"]*"|\S*)/gi;
const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v);

function parseDate(value: string, what: string): Date {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw new BadRequestException(`invalid ${what} date (use for example ${what}:2026-01-31)`);
  }
  return d;
}

/**
 * Maps the search box text to IMAP SEARCH criteria. Free text matches subject, sender
 * or recipient; `from:`, `to:`, `subject:`, `is:unread`, `is:read`, `is:starred`,
 * `before:` and `after:` (YYYY-MM-DD) narrow it down. Returns null when there is
 * nothing to search for. The text is passed as data; the IMAP library quotes it, and
 * control characters (which could end the command) are refused.
 */
export function searchCriteria(raw: unknown): SearchObject | null {
  if (raw === undefined) return null;
  // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (typeof raw !== 'string' || raw.length > MAX_SEARCH_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new BadRequestException('invalid search');
  }

  const crit: SearchObject = {};
  const free = raw
    .replace(FILTER, (_all, space: string, key: string, rawValue: string) => {
      const value = unquote(rawValue);
      switch (key.toLowerCase()) {
        case 'from': if (value) crit.from = value; break;
        case 'to': if (value) crit.to = value; break;
        case 'subject': if (value) crit.subject = value; break;
        case 'before': if (value) crit.before = parseDate(value, 'before'); break;
        case 'after': if (value) crit.since = parseDate(value, 'after'); break;
        case 'is': {
          const v = value.toLowerCase();
          if (v === 'unread') crit.seen = false;
          else if (v === 'read') crit.seen = true;
          else if (v === 'starred' || v === 'flagged') crit.flagged = true;
          break; // other values are ignored, not treated as text
        }
      }
      return space;
    })
    .replace(/\s+/g, ' ')
    .trim();

  const hasFilters = Object.keys(crit).length > 0;
  if (!free) return hasFilters ? crit : null;
  return { ...crit, or: [{ subject: free }, { from: free }, { to: free }] };
}
