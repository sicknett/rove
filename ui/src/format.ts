/** The file name at the end of a link, for a stream with no other title. */
export function titleFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return last || 'Stream';
  } catch {
    return 'Stream';
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

const languageNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;

/** "eng" / "en" / "pt-BR" to a readable name; unknown codes come back as they are. */
export function languageName(code?: string): string | null {
  if (!code || code === 'und') return null;
  const iso3: Record<string, string> = {
    eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh',
    por: 'pt', rus: 'ru', ara: 'ar', hin: 'hi', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl',
    tur: 'tr', gre: 'el', ell: 'el', heb: 'he', tha: 'th', vie: 'vi', ind: 'id', ces: 'cs', cze: 'cs', hun: 'hu', ukr: 'uk',
  };
  const normalized = iso3[code.toLowerCase()] ?? code;
  try {
    return languageNames?.of(normalized) ?? code;
  } catch {
    return code;
  }
}

export function channelLabel(count?: number): string | null {
  if (!count) return null;
  if (count === 1) return 'Mono';
  if (count === 2) return 'Stereo';
  if (count === 6) return '5.1';
  if (count === 8) return '7.1';
  return `${count} ch`;
}
