import { describe, expect, it } from 'vitest';
import { parseContactInput } from '../src/contacts/contact-input';
import { validateFolderName } from '../src/mail/folder-ops';
import { parseOutgoing } from '../src/mail/outgoing';
import { parsePreferencesPatch } from '../src/preferences/preferences';
import { htmlComplexity, htmlToRoughText, isHtmlTooComplex, MAX_HTML_DEPTH, sanitizeEmailHtml } from '../src/security/sanitize';
import { isBlockedAddress } from '../src/security/ssrf';

/** Regression tests for the findings of the internal security test of 2026-11-23. */
describe('HTML that would block the server while sanitizing', () => {
  it('detects deep nesting and very many tags in one fast pass', () => {
    const attack = '<div>'.repeat(20_000); // 98 KB: blocked the API for 68 s before the check existed
    const t = Date.now();
    expect(isHtmlTooComplex(attack)).toBe(true);
    expect(Date.now() - t).toBeLessThan(200);
    expect(isHtmlTooComplex('<p>x</p>'.repeat(30_000))).toBe(true);
    expect(isHtmlTooComplex('x'.repeat(1_000_001))).toBe(true);
    expect(() => sanitizeEmailHtml(attack)).toThrow(/too complex/);
  });

  it('accepts realistic email, including deep tables and unclosed paragraphs', () => {
    const newsletter = ('<table><tr><td>'.repeat(30) + '<a href="https://x.test">Read more</a>' + '</td></tr></table>'.repeat(30)).repeat(40);
    expect(htmlComplexity(newsletter).depth).toBe(31);
    expect(isHtmlTooComplex(newsletter)).toBe(false);
    expect(isHtmlTooComplex('<p>line'.repeat(5000))).toBe(false);
    expect(isHtmlTooComplex('<div>'.repeat(MAX_HTML_DEPTH) + '</div>'.repeat(MAX_HTML_DEPTH))).toBe(false);
    expect(isHtmlTooComplex('<div>'.repeat(MAX_HTML_DEPTH + 1))).toBe(true);
  });

  it('turns refused HTML into readable plain text', () => {
    expect(htmlToRoughText('<style>p{}</style><p>Hello &amp; welcome</p><div>Second<br>line</div><script>x</script>'))
      .toBe('Hello & welcome\nSecond\nline');
  });

  it('refuses such HTML when sending, and very long plain text', () => {
    const base = { to: ['a@b.example'], subject: 's' };
    expect(() => parseOutgoing({ ...base, text: 'x', html: '<div>'.repeat(20_000) }, 'send')).toThrow(/too complex/);
    expect(() => parseOutgoing({ ...base, text: 'x'.repeat(1_000_001) }, 'send')).toThrow(/too long/);
  });
});

describe('links in received email', () => {
  it('keep only web, mail and phone links', () => {
    const out = sanitizeEmailHtml('<a href="data:image/png;base64,iVBORw0KGgo=">a</a><a href="cid:x@y">b</a><a href="https://ok.test">c</a><a href="mailto:a@b.c">d</a>');
    expect(out).not.toMatch(/href="data:|href="cid:/);
    expect(out).toContain('href="https://ok.test"');
    expect(out).toContain('href="mailto:a@b.c"');
  });
});

describe('input checks', () => {
  it('refuses folder names that address other namespaces', () => {
    for (const name of ['~root', '#public', '..', '...']) expect(() => validateFolderName(name, '.')).toThrow();
    expect(validateFolderName('Projects 2026', '.')).toBe('Projects 2026');
  });

  it('accepts only the known contact address labels', () => {
    expect(() => parseContactInput({ displayName: 'x', emails: [{ email: 'a@b.example', label: 'HOME:x@evil.test' }] })).toThrow();
    expect(parseContactInput({ displayName: 'x', emails: [{ email: 'a@b.example', label: 'Work' }] }).emails[0].label).toBe('work');
  });

  it('refuses bidi control characters in the display name', () => {
    expect(() => parsePreferencesPatch({ displayName: 'Carol ‮moc.knab' })).toThrow();
    expect(parsePreferencesPatch({ displayName: 'Carol Example' }).displayName).toBe('Carol Example');
  });

  it('blocks multicast, site-local and IPv4-compatible IPv6 destinations, but not ordinary IPv4', () => {
    for (const ip of ['ff02::1', 'fec0::1', '::7f00:1']) expect(isBlockedAddress(ip)).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });
});
