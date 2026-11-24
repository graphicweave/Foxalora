import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { csvToContacts, guessField, parseCsv, MAX_CSV_ROWS } from '../src/contacts/csv';

describe('parseCsv', () => {
  it('parses quoted fields, doubled quotes and CRLF', () => {
    const rows = parseCsv('a,"b,with comma","say ""hi"""\r\nnext,row,here\r\n');
    expect(rows).toEqual([
      ['a', 'b,with comma', 'say "hi"'],
      ['next', 'row', 'here'],
    ]);
  });

  it('handles newlines inside quoted fields', () => {
    expect(parseCsv('"line\nbreak",x')).toEqual([['line\nbreak', 'x']]);
  });

  it('detects semicolon and tab delimiters from the first line', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a BOM and skips blank rows', () => {
    expect(parseCsv('\uFEFFname,email\n\n , \nx,y')).toEqual([['name', 'email'], ['x', 'y']]);
  });

  it('refuses empty input, oversize input and too many rows', () => {
    expect(() => parseCsv('')).toThrow(BadRequestException);
    expect(() => parseCsv('   ')).toThrow(BadRequestException);
    // Rows that are all blank fields count as empty, not as a crash (review fix).
    expect(() => parseCsv(' , , \n , ')).toThrow(/empty/);
    expect(() => csvToContacts(' , , \n , ', { name: 0 })).toThrow(BadRequestException);
    expect(() => parseCsv('x,'.repeat(1_100_000))).toThrow(/too large/);
    const big = `h\n${Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `r${i}`).join('\n')}`;
    expect(() => parseCsv(big)).toThrow(/at most/);
  });
});

describe('guessField', () => {
  it('maps common headers', () => {
    expect(guessField('Name')).toBe('name');
    expect(guessField('Full Name')).toBe('name');
    expect(guessField('First Name')).toBe('firstName');
    expect(guessField('given_name')).toBe('firstName');
    expect(guessField('Last Name')).toBe('lastName');
    expect(guessField('Surname')).toBe('lastName');
    expect(guessField('E-mail Address')).toBe('email');
    expect(guessField('Email 2')).toBe('email');
    expect(guessField('Home Email')).toBe('email');
    expect(guessField('Mobile Phone')).toBe('phone');
    expect(guessField('Organization')).toBe('company');
    expect(guessField('Birthday')).toBeNull();
    expect(guessField('')).toBeNull();
    // Label/type columns from Google and Outlook exports hold labels, not values.
    expect(guessField('E-mail 1 - Label')).toBeNull();
    expect(guessField('Phone 1 - Type')).toBeNull();
    expect(guessField('E-mail 1 - Value')).toBe('email');
  });
});

describe('csvToContacts', () => {
  const csv = 'First Name,Last Name,E-mail Address,Home Email,Phone,Company\nAda,Lovelace,ada@example.com,ada@home.example,0800-1,Analytical\nCharles,Babbage,charles@example.com,,,Engines';
  const mapping = { firstName: 0, lastName: 1, email: [2, 3], phone: 4, company: 5 };

  it('builds contacts from mapped columns with labels from the headers', () => {
    const { contacts, errors } = csvToContacts(csv, mapping);
    expect(errors).toEqual([]);
    expect(contacts).toEqual([
      {
        displayName: 'Ada Lovelace', company: 'Analytical', phone: '0800-1',
        emails: [{ email: 'ada@example.com', label: '' }, { email: 'ada@home.example', label: 'home' }],
      },
      { displayName: 'Charles Babbage', company: 'Engines', phone: '', emails: [{ email: 'charles@example.com', label: '' }] },
    ]);
  });

  it('prefers a mapped full-name column over first+last', () => {
    const { contacts } = csvToContacts('Name,First,Email\nAda Byron,Ada,a@x.test', { name: 0, firstName: 1, email: [2] });
    expect(contacts[0].displayName).toBe('Ada Byron');
  });

  it('collects row errors without losing valid rows and numbers them like the file', () => {
    const { contacts, errors } = csvToContacts('Name,Email\nGood,good@x.test\nBad,not-an-email\nAlso Good,ok@x.test', { name: 0, email: [1] });
    expect(contacts.map((c) => c.displayName)).toEqual(['Good', 'Also Good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Row 3: /);
  });

  it('skips rows where nothing mapped has a value', () => {
    const { contacts, errors } = csvToContacts('Name,Email,Note\n,,only a note', { name: 0, email: [1] });
    expect(contacts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('supports headerless files with 1-based error rows', () => {
    const { contacts, errors } = csvToContacts('Ada,ada@x.test\nBad,broken', { name: 0, email: [1] }, false);
    expect(contacts).toHaveLength(1);
    expect(errors[0]).toMatch(/^Row 2: /);
  });

  it('rejects a mapping pointing outside the file or without name/email', () => {
    expect(() => csvToContacts('a,b\n1,2', { name: 5 })).toThrow(/not in the file/);
    expect(() => csvToContacts('a,b\n1,2', { phone: 0 })).toThrow(/name or an email/);
    expect(() => csvToContacts('a,b\n1,2', null)).toThrow(/mapping/);
    expect(() => csvToContacts('a,b\n1,2', { email: 'x' })).toThrow(BadRequestException);
  });

  it('rejects control characters through the shared contact validation', () => {
    const { contacts, errors } = csvToContacts('Name,Email\n"evil\u0007name",a@x.test', { name: 0, email: [1] });
    expect(contacts).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
