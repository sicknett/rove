import { describe, expect, it } from 'vitest';
import { nearestPlace, placeAfterDrag, releaseSpeed, restingPlaces } from './dragScroll';

describe('restingPlaces', () => {
  it('offers each card start inside the range, the start and the very end', () => {
    expect(restingPlaces([0, 200, 400, 600, 800], 500)).toEqual([0, 200, 400, 500]);
  });

  it('leaves out starts before the beginning and repeats', () => {
    expect(restingPlaces([-12, 0, 0.3, 199.6, 200.2], 900)).toEqual([0, 200, 900]);
  });

  it('is just the start when nothing scrolls', () => {
    expect(restingPlaces([0, 200], 0)).toEqual([0]);
  });
});

describe('nearestPlace', () => {
  const places = [0, 200, 400, 500];

  it('picks the closest resting place', () => {
    expect(nearestPlace(places, 90)).toBe(0);
    expect(nearestPlace(places, 310)).toBe(400);
  });

  it('lets a row rest at its end rather than pulling back to the last card start', () => {
    expect(nearestPlace(places, 470)).toBe(500);
  });

  it('answers the start for an empty strip', () => {
    expect(nearestPlace([], 120)).toBe(0);
  });
});

describe('placeAfterDrag', () => {
  const places = [0, 200, 400, 500];

  it('rests at the nearest place after a long drag', () => {
    expect(placeAfterDrag(places, 0, 390)).toBe(400);
  });

  it('moves on by one card for a short drag, not back where it was', () => {
    expect(placeAfterDrag(places, 200, 260)).toBe(400);
    expect(placeAfterDrag(places, 200, 140)).toBe(0);
  });

  it('stays put for a drag too small to mean anything', () => {
    expect(placeAfterDrag(places, 200, 215)).toBe(200);
  });

  it('stays at an end it cannot go past', () => {
    expect(placeAfterDrag(places, 500, 500)).toBe(500);
    expect(placeAfterDrag(places, 0, 0)).toBe(0);
  });

  it('works from a place between cards', () => {
    expect(placeAfterDrag(places, 430, 470)).toBe(500);
  });
});

describe('releaseSpeed', () => {
  it('is the speed over the last tenth of a second', () => {
    const samples = [
      { t: 0, x: 0 },
      { t: 900, x: 500 },
      { t: 950, x: 450 },
      { t: 1000, x: 400 },
    ];
    expect(releaseSpeed(samples, 1000)).toBeCloseTo(-1);
  });

  it('is nothing when the pointer had stopped before letting go', () => {
    expect(releaseSpeed([{ t: 0, x: 0 }, { t: 40, x: 300 }], 400)).toBe(0);
  });

  it('is nothing with a single sample', () => {
    expect(releaseSpeed([{ t: 990, x: 10 }], 1000)).toBe(0);
  });
});
