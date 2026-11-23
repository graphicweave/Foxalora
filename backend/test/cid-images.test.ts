import { describe, expect, it } from 'vitest';
import { findCidReferences, inlineCidImages, type CidCandidate, type CidLimits } from '../src/mail/cid-images';
import { sanitizeEmailHtml } from '../src/security/sanitize';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('fake-jpeg-body')]);
const NOT_IMAGE = Buffer.from('#!/bin/sh\necho pwned');

const part = (over: Partial<CidCandidate> = {}): CidCandidate => ({ part: '2', contentId: 'img1@example', size: PNG.length, ...over });
const LIMITS: CidLimits = { maxImages: 10, maxImageBytes: 1024, maxTotalBytes: 2048, maxFetches: 20 };

const fetchOk = (buf: Buffer) => async () => buf;

describe('findCidReferences', () => {
  it('finds quoted, single-quoted and unquoted references once each', () => {
    const html = '<img src="cid:a@x"><img src=\'cid:a@x\'><img src=cid:b@x >text cid:c@x';
    expect(findCidReferences(html).sort()).toEqual(['a@x', 'b@x', 'c@x']);
  });

  it('finds nothing in cid-free html', () => {
    expect(findCidReferences('<p>plain</p>')).toEqual([]);
  });
});

describe('inlineCidImages', () => {
  it('inlines a referenced png as a data: uri and reports the part', async () => {
    const html = '<p>hi</p><img src="cid:img1@example" alt="logo">';
    const r = await inlineCidImages(html, [part()], fetchOk(PNG), LIMITS);
    expect(r.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    expect(r.html).not.toContain('cid:');
    expect([...r.inlinedParts]).toEqual(['2']);
  });

  it('replaces every occurrence but fetches the part once', async () => {
    let fetches = 0;
    const html = '<img src="cid:img1@example"><img src="cid:img1@example">';
    const r = await inlineCidImages(html, [part()], async () => { fetches++; return PNG; }, LIMITS);
    expect(fetches).toBe(1);
    expect(r.html.match(/data:image\/png/g)).toHaveLength(2);
  });

  it('matches a url-encoded reference and replaces it as written', async () => {
    const html = '<img src="cid:img1%40example">';
    const r = await inlineCidImages(html, [part()], fetchOk(PNG), LIMITS);
    expect(r.html).toContain('data:image/png;base64,');
    expect(r.html).not.toContain('cid:');
    expect(r.inlinedParts.has('2')).toBe(true);
  });

  it('rewrites unquoted attribute values with quotes', async () => {
    const html = '<img src=cid:img1@example >';
    const r = await inlineCidImages(html, [part()], fetchOk(PNG), LIMITS);
    expect(r.html).toContain('src="data:image/png;base64,');
  });

  it('refuses parts whose bytes are not a supported image', async () => {
    const html = '<img src="cid:img1@example">';
    const r = await inlineCidImages(html, [part()], fetchOk(NOT_IMAGE), LIMITS);
    expect(r.html).toBe(html);
    expect(r.inlinedParts.size).toBe(0);
  });

  it('refuses oversized parts, by declared size and by fetched bytes', async () => {
    const declared = await inlineCidImages('<img src="cid:img1@example">', [part({ size: 5000 })], fetchOk(PNG), LIMITS);
    expect(declared.inlinedParts.size).toBe(0);

    const big = Buffer.concat([PNG, Buffer.alloc(2000)]);
    const fetched = await inlineCidImages('<img src="cid:img1@example">', [part({ size: 100 })], fetchOk(big), LIMITS);
    expect(fetched.inlinedParts.size).toBe(0);
  });

  it('stops when the total budget is spent', async () => {
    const a = part({ part: '2', contentId: 'a@x', size: 900 });
    const b = part({ part: '3', contentId: 'b@x', size: 900 });
    const c = part({ part: '4', contentId: 'c@x', size: 900 });
    const buf = Buffer.concat([PNG, Buffer.alloc(880)]); // ~900 bytes, total cap 2048
    const html = '<img src="cid:a@x"><img src="cid:b@x"><img src="cid:c@x">';
    const r = await inlineCidImages(html, [a, b, c], fetchOk(buf), LIMITS);
    expect(r.inlinedParts.size).toBe(2);
    expect(r.html).toContain('cid:c@x');
  });

  it('caps the number of inlined images', async () => {
    const limits: CidLimits = { ...LIMITS, maxImages: 1 };
    const parts = [part({ part: '2', contentId: 'a@x' }), part({ part: '3', contentId: 'b@x' })];
    const r = await inlineCidImages('<img src="cid:a@x"><img src="cid:b@x">', parts, fetchOk(PNG), limits);
    expect(r.inlinedParts.size).toBe(1);
  });

  it('leaves unreferenced and unmatched cids alone', async () => {
    const html = '<img src="cid:other@x">';
    const r = await inlineCidImages(html, [part()], fetchOk(PNG), LIMITS);
    expect(r.html).toBe(html);
    expect(r.inlinedParts.size).toBe(0);
  });

  it('stops fetching after the attempt cap even when every part is refused', async () => {
    // A hostile message: many parts whose bytes are not images, all referenced.
    const parts = Array.from({ length: 50 }, (_, i) => part({ part: String(i + 2), contentId: `p${i}@x`, size: 10 }));
    const html = parts.map((p) => `<img src="cid:${p.contentId}">`).join('');
    let fetchCount = 0;
    const r = await inlineCidImages(html, parts, async () => { fetchCount++; return NOT_IMAGE; }, LIMITS);
    expect(fetchCount).toBe(LIMITS.maxFetches);
    expect(r.inlinedParts.size).toBe(0);
  });

  it('counts refused bytes toward the download budget', async () => {
    // Parts declare tiny sizes but actually return near-cap non-image bytes.
    const parts = Array.from({ length: 10 }, (_, i) => part({ part: String(i + 2), contentId: `p${i}@x`, size: 1 }));
    const html = parts.map((p) => `<img src="cid:${p.contentId}">`).join('');
    let fetchCount = 0;
    const big = Buffer.alloc(1000); // not an image, 1000 bytes each; budget 2048
    await inlineCidImages(html, parts, async () => { fetchCount++; return big; }, LIMITS);
    expect(fetchCount).toBeLessThanOrEqual(3); // 3rd fetch crosses the 2048 budget; then stop
  });

  it('survives a fetch failure without touching the html', async () => {
    const html = '<img src="cid:img1@example">';
    const r = await inlineCidImages(html, [part()], async () => { throw new Error('imap broke'); }, LIMITS);
    expect(r.html).toBe(html);
    expect(r.inlinedParts.size).toBe(0);
  });

  it('never replaces cid text outside attribute values', async () => {
    const html = '<p>see cid:img1@example for details</p>';
    const r = await inlineCidImages(html, [part()], fetchOk(PNG), LIMITS);
    expect(r.html).toBe(html);
    expect(r.inlinedParts.size).toBe(0);
  });

  it('produces data uris that survive the sanitizer; hostile types do not', async () => {
    const html = '<img src="cid:img1@example"><img src="cid:evil@x">';
    const parts = [part(), part({ part: '3', contentId: 'evil@x', size: NOT_IMAGE.length })];
    const r = await inlineCidImages(html, parts, async (p) => (p.part === '2' ? JPEG : NOT_IMAGE), LIMITS);
    const clean = sanitizeEmailHtml(r.html);
    expect(clean).toContain('data:image/jpeg;base64,');
    // The refused part keeps its cid: reference, which the sanitizer allows but never loads.
    expect(clean).toContain('cid:evil@x');
    expect(clean).not.toContain('pwned');
  });
});
