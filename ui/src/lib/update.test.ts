import { describe, expect, it } from 'vitest';
import { isNewer, parseRelease } from './update';

describe('updates', () => {
  it('compares versions by number, not by text', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });

  it('accepts only a complete release description', () => {
    const good = { version: '0.2.0', url: 'https://github.com/sicknett/rove/releases/download/v0.2.0/ROVE-Setup-0.2.0.exe', sha256: 'ab'.repeat(32), signature: 'cd'.repeat(64), notes: 'Fixes' };
    expect(parseRelease(good)?.version).toBe('0.2.0');
    expect(parseRelease({ ...good, version: '0.2' })).toBeNull();
    expect(parseRelease({ ...good, sha256: 'xyz' })).toBeNull();
    expect(parseRelease({ ...good, signature: undefined })).toBeNull();
    expect(parseRelease('nope')).toBeNull();
  });
});
