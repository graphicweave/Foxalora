import { sniff } from './inline-images';

/**
 * Inline cid: image resolution for received mail (FOX-048, PRD VIEW-008).
 * Referenced cid parts become data: URIs: the sanitizer's URI allowlist and the
 * viewer iframe's `img-src data:` CSP already permit exactly those, so the image
 * never needs a network fetch from inside the render frame. Only sniffed image
 * types are inlined and every size is capped; anything else stays an attachment.
 */

export interface CidCandidate {
  part: string;
  contentId: string | null;
  size: number;
}

export interface CidLimits {
  maxImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
  /** IMAP fetch attempts per message, counting refused parts — a hostile message
   *  must not turn one open into thousands of fetches. */
  maxFetches: number;
}

// Mirrors the outgoing inline-image limits (D-008): 10 images, 5 MB each, 10 MB total.
export const CID_LIMITS: CidLimits = {
  maxImages: 10,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxFetches: 20,
};

/** cid: references in the HTML, as written (URL-decoding happens at match time). */
export function findCidReferences(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\bcid:([^"'\s<>)]+)/gi)) out.add(m[1]);
  return [...out];
}

/** The content id a raw reference points at, trying the URL-decoded form too. */
function matchPart(parts: CidCandidate[], raw: string): CidCandidate | undefined {
  const keys = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) keys.push(decoded);
  } catch {
    // not URL-encoded
  }
  return parts.find((p) => p.contentId !== null && keys.includes(p.contentId));
}

/** Replaces src="cid:x" / src='cid:x' / src=cid:x attribute values, never free text. */
function replaceCid(html: string, raw: string, dataUri: string): { html: string; replaced: boolean } {
  let replaced = false;
  const swap = (open: string, close: string) => {
    const needle = `${open}cid:${raw}${close}`;
    if (!html.includes(needle)) return;
    html = html.split(needle).join(`${open}${dataUri}${close}`);
    replaced = true;
  };
  swap('"', '"');
  swap("'", "'");
  // Unquoted attribute value: ends at whitespace or `>`.
  const unquoted = new RegExp(`=cid:${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s>])`, 'g');
  if (unquoted.test(html)) {
    html = html.replace(unquoted, `="${dataUri}"`);
    replaced = true;
  }
  return { html, replaced };
}

/**
 * Rewrites cid: image references to data: URIs. Runs on the raw (pre-sanitizer)
 * HTML so DOMPurify validates the result like any other input. Returns the new
 * HTML and the part ids that were inlined (the caller drops those from the
 * attachment list; unreferenced or refused parts stay listed).
 */
export async function inlineCidImages(
  html: string,
  parts: CidCandidate[],
  fetchPart: (part: CidCandidate) => Promise<Buffer | null>,
  limits: CidLimits = CID_LIMITS,
): Promise<{ html: string; inlinedParts: Set<string> }> {
  const inlinedParts = new Set<string>();
  const refs = findCidReferences(html);
  if (!refs.length) return { html, inlinedParts };

  let total = 0; // bytes successfully inlined
  let downloaded = 0; // bytes actually fetched, refused parts included
  let fetches = 0;
  const fetched = new Map<string, string | null>(); // part id -> data uri (null = refused)
  for (const ref of refs) {
    const part = matchPart(parts, ref);
    if (!part) continue;
    if (inlinedParts.size >= limits.maxImages && !fetched.has(part.part)) break;

    let dataUri = fetched.get(part.part);
    if (dataUri === undefined) {
      // Attempt and byte budgets count refused parts too (the declared size is only
      // an estimate), so a hostile message cannot force unbounded IMAP fetches.
      if (fetches >= limits.maxFetches || downloaded > limits.maxTotalBytes) break;
      dataUri = null;
      if (part.size <= limits.maxImageBytes && total + part.size <= limits.maxTotalBytes) {
        fetches++;
        const buf = await fetchPart(part).catch(() => null);
        downloaded += buf?.length ?? 0;
        if (buf && buf.length <= limits.maxImageBytes && total + buf.length <= limits.maxTotalBytes) {
          const type = sniff(buf);
          if (type) {
            total += buf.length;
            dataUri = `data:${type};base64,${buf.toString('base64')}`;
          }
        }
      }
      fetched.set(part.part, dataUri);
    }
    if (!dataUri) continue;

    const r = replaceCid(html, ref, dataUri);
    html = r.html;
    if (r.replaced) inlinedParts.add(part.part);
  }
  return { html, inlinedParts };
}
