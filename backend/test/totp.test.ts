import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/admin/admin.controller';
import { base32Decode, base32Encode, hashBackupCode, hotp, newBackupCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../src/admin/totp';

/** FOX-134: TOTP as in RFC 6238 (test vectors from its appendix B, SHA-1, 8 digits). */
describe('TOTP', () => {
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC 6238 test vectors', () => {
    const vectors: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
    for (const [t, code] of vectors) expect(hotp(rfcSecret, Math.floor(t / 30), 8)).toBe(code);
  });

  it('round-trips base32', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts the current code and one step of clock drift, nothing else', () => {
    const secret = base32Encode(rfcSecret);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    const at = (s: number) => hotp(rfcSecret, s);
    expect(verifyTotp(secret, at(step), now)).toBe(step);
    expect(verifyTotp(secret, at(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, at(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, at(step - 3), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth link for authenticator apps', () => {
    const url = otpauthUrl('Foxalora (mail.example)', 'admin@example.com', 'JBSWY3DPEHPK3PXP');
    expect(url).toMatch(/^otpauth:\/\/totp\/Foxalora%20\(mail\.example\)%3Aadmin%40example\.com\?secret=JBSWY3DPEHPK3PXP&issuer=/);
  });

  it('makes ten distinct backup codes and hashes them independent of case and dashes', () => {
    const codes = newBackupCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(hashBackupCode(codes[0].toLowerCase().replace(/-/g, ''))).toBe(hashBackupCode(codes[0]));
  });
});

describe('audit CSV export', () => {
  it('neutralises spreadsheet formulas and quotes separators', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell({ domain: 'x.example' })).toBe('"{""domain"":""x.example""}"');
    expect(csvCell('plain')).toBe('plain');
  });
});
