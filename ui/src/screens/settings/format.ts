// Small wording helpers shared by the settings pages.

/** `1 addon`, `3 addons`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * How long ago something happened, for a status line: "just now", "12 min ago", "at 9:14 PM"
 * for earlier today, and the day as well once it was not today ("Mon at 9:14 PM", "3 Mar").
 */
export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const then = new Date(ms);
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (then.toDateString() === today.toDateString()) return `at ${time}`;
  if (now - ms < 6 * 86400 * 1000) return `${then.toLocaleDateString(undefined, { weekday: 'short' })} at ${time}`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The host of an address, or the address itself when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
