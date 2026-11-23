import { describe, expect, it } from 'vitest';
import { buildMapping, dedupeSingles, guessField, mappingUsable, parseFirstRows } from '../../src/contacts/csv';

describe('parseFirstRows', () => {
  it('reads only the asked-for rows, quote-aware', () => {
    const rows = parseFirstRows('Name,"E,mail"\r\n"say ""hi""",a@x.test\nmore,rows\n', 2);
    expect(rows).toEqual([
      ['Name', 'E,mail'],
      ['say "hi"', 'a@x.test'],
    ]);
  });

  it('detects semicolons and skips blank lines', () => {
    expect(parseFirstRows('a;b\n\n1;2', 2)).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('guessField / buildMapping', () => {
  it('guesses common headers and collects email columns', () => {
    const fields = ['First Name', 'Last Name', 'E-mail Address', 'Home Email', 'Mobile Phone', 'Notes'].map(guessField);
    expect(fields).toEqual(['firstName', 'lastName', 'email', 'email', 'phone', 'ignore']);
    expect(buildMapping(fields)).toEqual({ firstName: 0, lastName: 1, email: [2, 3], phone: 4 });
  });

  it('keeps only the first column per single field', () => {
    expect(buildMapping(['name', 'name', 'email'])).toEqual({ name: 0, email: [2] });
  });

  it('ignores label/type columns and dedupes single-field guesses for the UI', () => {
    const google = ['Name', 'E-mail 1 - Label', 'E-mail 1 - Value', 'Phone 1 - Label', 'Phone 1 - Value'].map(guessField);
    expect(google).toEqual(['name', 'ignore', 'email', 'ignore', 'phone']);
    const outlook = ['First Name', 'Home Phone', 'Business Phone', 'Mobile Phone'].map(guessField);
    expect(dedupeSingles(outlook)).toEqual(['firstName', 'phone', 'ignore', 'ignore']);
  });

  it('knows when a mapping cannot import anything', () => {
    expect(mappingUsable(buildMapping(['phone', 'company']))).toBe(false);
    expect(mappingUsable(buildMapping(['ignore', 'email']))).toBe(true);
    expect(mappingUsable(buildMapping(['lastName']))).toBe(true);
  });
});
