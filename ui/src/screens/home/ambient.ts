// The colour Home takes from the banner's picture, so the page below it belongs to what is featured.

import { useEffect, useState } from 'react';
import { create } from 'zustand';

/**
 * The colour the page has right now while Home is in front (undefined elsewhere). The navigation
 * bar sits outside Home and takes its own shading from this, so it does not stand out as a dark
 * strip beside a coloured page.
 */
export const useAmbientPage = create<{ color: string | undefined }>(() => ({ color: undefined }));

const cache = new Map<string, string | null>();

/** A small copy is enough to average, and loads at once. */
function sampleUrl(url: string): string {
  return url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, '$1w300/');
}

/**
 * The picture's overall colour, darkened and calmed so text and posters stay readable on it.
 * Null when the picture's host does not allow reading its pixels (then the page keeps its own colour).
 */
export function ambientFromPixels(data: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    // Colourful pixels count for more than greys, or most pictures average out to mud.
    const w = 1 + (max - min) / 32;
    r += data[i] * w;
    g += data[i + 1] * w;
    b += data[i + 2] * w;
    weight += w;
  }
  if (!weight) return null;
  const [h, s] = hsl(r / weight, g / weight, b / weight);
  // One lightness for every picture: the hue changes, the page's contrast does not.
  return `hsl(${Math.round(h)} ${Math.round(Math.min(62, Math.max(18, s * 100 * 1.25)))}% 24%)`;
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === x ? (y - z) / d + (y < z ? 6 : 0) : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return [h * 60, s, l];
}

function read(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 14;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(ambientFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = sampleUrl(url);
  });
}

/** The ambient colour for a picture, once it is known. Keeps the last colour while the next loads. */
export function useAmbient(url: string | undefined, enabled: boolean): string | undefined {
  const [color, setColor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !url) return setColor(undefined);
    const known = cache.get(url);
    if (known !== undefined) return void (known && setColor(known));
    let alive = true;
    void read(url).then((c) => {
      cache.set(url, c);
      if (alive && c) setColor(c);
    });
    return () => {
      alive = false;
    };
  }, [url, enabled]);
  return enabled ? color : undefined;
}
