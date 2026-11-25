import { describe, expect, it } from 'vitest';
import { activeSegment, chapterSegments, endingStart, mergeSegments, reachedEnd, type Segment } from './skips';

describe('skip segments', () => {
  it('reads chapter titles', () => {
    const segs = chapterSegments(
      [
        { title: 'Recap', time: 0 },
        { title: 'Opening', time: 60 },
        { title: 'Part A', time: 150 },
        { title: 'Ending', time: 1300 },
        { title: 'Preview', time: 1390 },
      ],
      1420,
    );
    expect(segs.map((s) => [s.kind, s.start, s.end])).toEqual([
      ['recap', 0, 60],
      ['intro', 60, 150],
      ['credits', 1300, 1390],
      ['preview', 1390, null],
    ]);
  });

  it('prefers earlier sources and drops implausible ones', () => {
    const chapters: Segment[] = [{ kind: 'intro', start: 30, end: 2000, source: 'chapters' }];
    const db: Segment[] = [
      { kind: 'intro', start: 40, end: 100, source: 'db' },
      { kind: 'credits', start: 2500, end: null, source: 'db' },
    ];
    const merged = mergeSegments([chapters, db], 2700);
    expect(merged).toEqual([
      { kind: 'intro', start: 40, end: 100, source: 'db' },
      { kind: 'credits', start: 2500, end: null, source: 'db' },
    ]);
    expect(activeSegment(merged, 50, 2700)?.kind).toBe('intro');
    expect(activeSegment(merged, 2600, 2700)?.kind).toBe('credits');
    expect(activeSegment(merged, 200, 2700)).toBeNull();
  });

  it('places the ending at the credits marker, or a lead time before the end', () => {
    const credits: Segment = { kind: 'credits', start: 2500, end: null, source: 'db' };
    expect(endingStart([credits], 2700, 35)).toBe(2500);
    expect(endingStart([], 2700, 35)).toBe(2665);
    // A credits marker early in the video is not the ending.
    expect(endingStart([{ ...credits, start: 300 }], 2700, 35)).toBe(2665);
  });

  it('tells the end of a video from a stream that broke off', () => {
    expect(reachedEnd(2699, 2700)).toBe(true);
    expect(reachedEnd(2675, 2700)).toBe(true);
    expect(reachedEnd(1400, 2700)).toBe(false);
    // Long films: the last couple of percent are credits either way.
    expect(reachedEnd(7100, 7200)).toBe(true);
    expect(reachedEnd(7000, 7200)).toBe(false);
  });
});
