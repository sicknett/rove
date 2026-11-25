import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, formatShareCode, groupCode, parseShareCode, ShareCodeError, tidyCode, type CodeProblem } from './shareCode';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const sample = (seed: number) => {
  const key = new Uint8Array(16).map((_, i) => (i * 37 + seed * 11 + 5) & 255);
  const id = Array.from({ length: 16 }, (_, i) => ((i * 7 + seed) % 16).toString(16)).join('');
  return { host: seed % 2 ? 'A' : 'B', id, key };
};

const problemOf = (text: string): CodeProblem | null => {
  try {
    parseShareCode(text);
    return null;
  } catch (e) {
    if (e instanceof ShareCodeError) return e.problem;
    throw e;
  }
};

describe('a share code', () => {
  it('carries the host, the id and the key there and back', () => {
    for (let seed = 0; seed < 20; seed++) {
      const made = sample(seed);
      const code = formatShareCode(made);
      const read = parseShareCode(code);
      expect(read.host).toBe(made.host);
      expect(read.id).toBe(made.id);
      expect([...read.key]).toEqual([...made.key]);
    }
  });

  it('is 45 letters and digits in nine groups of five, starting with the version and the host', () => {
    const code = formatShareCode(sample(1));
    expect(code).toMatch(/^1A[0-9A-Z]{3}(-[0-9A-Z]{5}){8}$/);
    expect(tidyCode(code)).toHaveLength(CODE_LENGTH);
    expect(CODE_LENGTH).toBe(45);
    expect(/[ILOU]/.test(tidyCode(code))).toBe(false);
  });

  it('reads the same code however it was typed', () => {
    const made = sample(3);
    const code = formatShareCode(made);
    const bare = tidyCode(code);
    const typed = [code.toLowerCase(), bare, `  ${code.replace(/-/g, ' ')}\n`, groupCode(bare).replace(/-/g, ' - '), bare.replace(/0/g, 'o').replace(/1/g, 'l'), bare.replace(/1/g, 'I')];
    for (const t of typed) expect(parseShareCode(t).id).toBe(made.id);
  });

  it('says what is wrong with a code that cannot be one', () => {
    const code = tidyCode(formatShareCode(sample(4)));
    expect(problemOf('')).toBe('empty');
    expect(problemOf('  - ')).toBe('empty');
    expect(problemOf(code.slice(0, 10) + 'U' + code.slice(11))).toBe('characters');
    expect(problemOf(code + '!')).toBe('characters');
    expect(problemOf('https://example.org/?abc')).toBe('characters');
    expect(problemOf(code.slice(0, -1))).toBe('length');
    expect(problemOf(code + '7')).toBe('length');
    expect(problemOf(code.slice(0, 20))).toBe('length');
    expect(problemOf('2' + code.slice(1))).toBe('newer');
    // A newer format may have another length: it is still called newer, not too short.
    expect(problemOf('3ABCDEFGH')).toBe('newer');
  });

  it('catches every single wrong character', () => {
    for (let seed = 0; seed < 12; seed++) {
      const code = tidyCode(formatShareCode(sample(seed)));
      // Past the version character, which has a message of its own.
      for (let at = 1; at < code.length; at++) {
        for (const ch of ALPHABET) {
          if (ch === code[at]) continue;
          const wrong = code.slice(0, at) + ch + code.slice(at + 1);
          if (problemOf(wrong) !== 'mistyped') throw new Error(`not caught: code ${seed}, position ${at}, ${ch}`);
        }
      }
    }
  });

  it('catches two neighbouring characters swapped', () => {
    for (let seed = 0; seed < 40; seed++) {
      const code = tidyCode(formatShareCode(sample(seed)));
      for (let at = 1; at < code.length - 1; at++) {
        if (code[at] === code[at + 1]) continue;
        const swapped = code.slice(0, at) + code[at + 1] + code[at] + code.slice(at + 2);
        expect(problemOf(swapped), `${seed}:${at}`).toBe('mistyped');
      }
    }
  });

  it('gives an id that can only be sixteen hex digits, whatever the code says', () => {
    // Every body of the right length is some id and key: there is no code whose id is anything else.
    let seed = 99;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const key = new Uint8Array(16).map(() => next() & 255);
      const id = Array.from({ length: 16 }, () => (next() & 15).toString(16)).join('');
      expect(parseShareCode(formatShareCode({ host: 'A', id, key })).id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('refuses to make a code from the wrong parts', () => {
    const good = sample(1);
    expect(() => formatShareCode({ ...good, id: '../etc/passwd' })).toThrow();
    expect(() => formatShareCode({ ...good, id: good.id.toUpperCase().replace(/\d/g, 'A') })).toThrow();
    expect(() => formatShareCode({ ...good, key: new Uint8Array(32) })).toThrow();
    expect(() => formatShareCode({ ...good, host: 'U' })).toThrow();
    expect(() => formatShareCode({ ...good, host: 'AB' })).toThrow();
  });
});
