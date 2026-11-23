import DOMPurify from 'isomorphic-dompurify';

/**
 * HTML email sanitization (PRD 3 Module 3 + 5.4).
 * This is defence layer 1. Layer 2 is the sandboxed iframe + CSP in the
 * frontend. Layer 3 (production) is serving that iframe from a separate origin.
 */
const ALLOWED_PROTOCOLS = /^(https?:|mailto:|tel:|cid:|data:image\/(png|jpe?g|gif|webp);base64,)/i;
/** Links may only go to web pages, email addresses and phone numbers. */
const LINK_PROTOCOLS = /^(https?:|mailto:|tel:)/i;

const REMOTE_CSS = /url\s*\(|image-set\s*\(|expression\s*\(|@import|\bsrc\s*\(/i;

/** Decodes CSS escapes (\72, \000072 , \u) so checks see what the browser will parse. */
export function decodeCssEscapes(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/\\(.)/g, '$1');
}

let configured = false;
function configure() {
  if (configured) return;
  configured = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
    // Links: always open in new tab, never leak referrer/opener
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!LINK_PROTOCOLS.test(href)) node.removeAttribute('href');
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    // Remote images blocked by default (tracking pixels). Keep a marker so the
    // UI can offer "Load remote images" later.
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (/^https?:/i.test(src)) {
        node.setAttribute('data-blocked-src', src);
        node.removeAttribute('src');
        node.setAttribute('alt', node.getAttribute('alt') || '[remote image blocked]');
      } else if (!ALLOWED_PROTOCOLS.test(src)) {
        node.removeAttribute('src');
      }
      node.removeAttribute('srcset');
    }
    // Strip inline styles that can load remote content (tracking/exfil). CSS escapes
    // are decoded first, otherwise "u\72l(" slips past as url( (Roundcube CVE class).
    const style = node.getAttribute?.('style');
    if (style && REMOTE_CSS.test(decodeCssEscapes(style))) {
      node.removeAttribute('style');
    }
  });
}

/**
 * Limits for HTML that is worth sanitizing. Sanitizing (jsdom + DOMPurify) gets much slower with
 * nesting depth: 20,000 nested <div> (98 KB) blocked the API for 68 s in the 2026-11-23 internal
 * test, freezing every user. Real email stays far below these limits (deep Outlook tables reach
 * about 30 levels); anything above them is shown as plain text instead.
 */
export const MAX_HTML_BYTES = 1_000_000;
export const MAX_HTML_DEPTH = 100;
export const MAX_HTML_TAGS = 40_000; // opening and closing tags, about 20,000 elements

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Closed implicitly by the parser when a sibling starts, so they rarely nest in real markup.
const AUTO_CLOSED = new Set(['p', 'li', 'dt', 'dd', 'td', 'th', 'tr', 'option', 'thead', 'tbody', 'tfoot', 'colgroup']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)[^>]*?(\/?)>/g;

/** One linear pass over the markup (no parsing): how many tags, and how deeply they nest. */
export function htmlComplexity(html: string): { depth: number; tags: number } {
  let depth = 0;
  let max = 0;
  let tags = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    tags++;
    const name = m[2].toLowerCase();
    if (m[1]) depth = Math.max(0, depth - (AUTO_CLOSED.has(name) ? 0 : 1));
    else if (!m[3] && !VOID_TAGS.has(name) && !AUTO_CLOSED.has(name)) max = Math.max(max, ++depth);
  }
  return { depth: max, tags };
}

/** True when the HTML is too large or too deeply nested to sanitize without blocking the server. */
export function isHtmlTooComplex(html: string): boolean {
  if (html.length > MAX_HTML_BYTES) return true;
  const c = htmlComplexity(html);
  return c.depth > MAX_HTML_DEPTH || c.tags > MAX_HTML_TAGS;
}

/** Plain-text fallback for HTML that is not sanitized: tags dropped, common entities decoded. */
export function htmlToRoughText(html: string, maxChars = 200_000): string {
  return html
    .slice(0, MAX_HTML_BYTES)
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/** Callers must check isHtmlTooComplex first; this refuses oversized input as a last guard. */
export function sanitizeEmailHtml(html: string): string {
  if (isHtmlTooComplex(html)) throw new Error('HTML too complex to sanitize');
  configure();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
      'form', 'input', 'button', 'textarea', 'select', 'option',
      'svg', 'math', 'link', 'meta', 'base', 'audio', 'video', 'source',
    ],
    FORBID_ATTR: ['srcset', 'formaction', 'action', 'background', 'ping'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: ALLOWED_PROTOCOLS,
  });
}
