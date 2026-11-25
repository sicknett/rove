import { describe, expect, it, vi } from 'vitest';

describe('player store', () => {
  it('keeps the position of the video apart from what mpv reports while loading or after a failure', async () => {
    let shell: ((m: unknown) => void) | null = null;
    vi.stubGlobal('window', { rove: { platform: 'windows', send: vi.fn(), subscribe: (fn: (m: unknown) => void) => ((shell = fn), () => undefined) } });
    const { expectLoad, getPlayerState, knownPosition, onPlayerEvent, patchPlayerState, startListening } = await import('./store');
    const send = (m: unknown) => shell!(m);
    const event = (name: string, extra: object = {}) => send({ t: 'event', name, ...extra });
    const props = (v: Record<string, unknown>) => send({ t: 'props', v });
    const seen: string[] = [];
    startListening();
    onPlayerEvent((e) => seen.push(`${e.name}${e.reason ? `:${e.reason}` : ''}${e.stale ? ' (stale)' : ''}`));

    // First file, from the beginning. Nothing is certain until it has started playing.
    expectLoad(0);
    event('start-file');
    props({ 'time-pos': 0, duration: 1000 });
    expect(knownPosition()).toEqual({ pos: 0, dur: 0 });
    event('file-loaded');
    event('playback-restart');
    props({ 'time-pos': 300, duration: 1000 });
    expect(knownPosition()).toEqual({ pos: 300, dur: 1000 });

    // The link dies: mpv unloads the file and reports no position.
    event('end-file', { reason: 'error', error: 'loading failed' });
    props({ 'time-pos': null, duration: null });
    expect(getPlayerState().timePos).toBe(0);
    expect(getPlayerState().error).toBe('loading failed');
    expect(knownPosition()).toEqual({ pos: 300, dur: 1000 });

    // Another source is loaded at that position. Until mpv begins it, events are the old file's.
    expectLoad(300);
    expect(knownPosition()).toEqual({ pos: 300, dur: 0 });
    patchPlayerState({ error: null });
    event('end-file', { reason: 'error', error: 'late failure of the old file' });
    expect(getPlayerState().error).toBeNull();
    event('start-file');
    props({ 'time-pos': 0, duration: 900 });
    expect(knownPosition()).toEqual({ pos: 300, dur: 0 });
    event('playback-restart');
    props({ 'time-pos': 300.5 });
    expect(knownPosition()).toEqual({ pos: 300.5, dur: 900 });

    // This one fails before it plays: the place to retry from is where it was asked to start.
    expectLoad(300.5);
    event('end-file', { reason: 'stop' });
    event('start-file');
    event('end-file', { reason: 'error' });
    expect(knownPosition()).toEqual({ pos: 300.5, dur: 0 });
    expect(getPlayerState().error).toBe('This stream could not be played.');

    expect(seen).toEqual([
      'start-file',
      'file-loaded',
      'playback-restart',
      'end-file:error',
      'end-file:error (stale)',
      'start-file',
      'playback-restart',
      'end-file:stop (stale)',
      'start-file',
      'end-file:error',
    ]);
    vi.unstubAllGlobals();
  });
});
