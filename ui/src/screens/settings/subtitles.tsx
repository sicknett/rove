// Settings → Subtitles & languages: which languages to play and read, when subtitles come on,
// and how plain subtitles look (with a live preview that stays in view while you adjust).

import { useMemo, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useSettings, type SubtitleMode, DEFAULT_SUBTITLE_FONT, subtitleFont } from '../../state/settings';
import { Segmented, Select, Slider, Switch } from '../../ui/controls';
import { Advanced, Group, SettingRow, Swatches, type SwatchOption } from './parts';

const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['zh', 'Chinese'], ['ru', 'Russian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'],
  ['fi', 'Finnish'], ['pl', 'Polish'], ['tr', 'Turkish'], ['el', 'Greek'], ['he', 'Hebrew'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
  ['cs', 'Czech'], ['hu', 'Hungarian'], ['uk', 'Ukrainian'], ['ro', 'Romanian'], ['tl', 'Filipino'], ['fa', 'Persian'], ['ta', 'Tamil'], ['te', 'Telugu'],
];
const langName = (c: string) => LANGUAGES.find(([k]) => k === c)?.[1] ?? c;

/** Languages in order of preference: add one at the end, move one earlier, or take one out. */
function LanguageList({ value, onChange, kind, empty }: { value: string[]; onChange: (v: string[]) => void; kind: string; empty: string }) {
  const [adding, setAdding] = useState('');
  const rest = LANGUAGES.filter(([c]) => !value.includes(c));
  const earlier = (i: number) => {
    const next = [...value];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  };
  return (
    <div className="lang-list">
      {value.map((c, i) => (
        <span key={c} className="chip is-on chip--removable">
          <span className="chip__order">{i + 1}</span> {langName(c)}
          {i > 0 && (
            <button type="button" aria-label={`Prefer ${langName(c)} over ${langName(value[i - 1])}`} title="Move earlier" onClick={() => earlier(i)}>
              <ArrowLeft size={13} />
            </button>
          )}
          <button type="button" aria-label={`Remove ${langName(c)}`} title="Remove" onClick={() => onChange(value.filter((x) => x !== c))}>
            <X size={13} />
          </button>
        </span>
      ))}
      <Select
        label={`Add ${kind}`}
        value={adding}
        options={[{ value: '', label: 'Add a language' }, ...rest.map(([c, n]) => ({ value: c, label: n }))]}
        onChange={(c) => {
          if (c) onChange([...value, c]);
          setAdding('');
        }}
      />
      {!value.length && <span className="s-row__hint">{empty}</span>}
    </div>
  );
}

const SUB_MODES: { value: SubtitleMode; label: string; detail: string }[] = [
  { value: 'forced', label: 'Forced only', detail: 'Only the forced track: signs, and lines spoken in another language.' },
  { value: 'foreign', label: 'Foreign audio', detail: 'Full subtitles whenever the audio is not one of your subtitle languages, and the forced track otherwise.' },
  { value: 'always', label: 'Always', detail: 'Full subtitles on everything, in your first subtitle language a title has.' },
  { value: 'off', label: 'Never', detail: 'Subtitles stay off until you turn them on in the player.' },
];

/** The sizes the player's subtitle menu offers, by name. */
const SIZE_NAMES: Record<number, string> = { 38: 'S', 46: 'M', 56: 'L', 68: 'XL' };

const TEXT_COLOURS: SwatchOption<string>[] = [
  { value: '#F2F2F2', color: '#F2F2F2', label: 'Soft white' },
  { value: '#FFFFFF', color: '#FFFFFF', label: 'White' },
  { value: '#FFE873', color: '#FFE873', label: 'Yellow' },
  { value: '#BDE7C9', color: '#BDE7C9', label: 'Mint' },
  { value: '#A8D8FF', color: '#A8D8FF', label: 'Sky' },
];

const OUTLINE_COLOURS: SwatchOption<string>[] = [
  { value: '#000000', color: '#000000', label: 'Black' },
  { value: '#2B2B2B', color: '#2B2B2B', label: 'Charcoal' },
  { value: '#0B1B3A', color: '#0B1B3A', label: 'Navy' },
  { value: '#3A1A0B', color: '#3A1A0B', label: 'Brown' },
];

/** A colour saved earlier that is not one of the swatches stays selectable, and visibly chosen. */
const withSaved = (options: SwatchOption<string>[], saved: string) => (options.some((o) => o.value.toLowerCase() === saved.toLowerCase()) ? options : [...options, { value: saved, color: saved, label: `Saved colour ${saved}` }]);
const chosen = (options: SwatchOption<string>[], saved: string) => options.find((o) => o.value.toLowerCase() === saved.toLowerCase())?.value ?? saved;

/**
 * The player draws subtitles with fonts installed in Windows, and has none of its own. So the
 * choice is a short list of good subtitle faces that come with Windows: every one is there on
 * every PC, and the preview (drawn with the same installed font) shows what the player will draw.
 */
const FONTS: { value: string; label: string; detail?: string; css: string }[] = [
  { value: DEFAULT_SUBTITLE_FONT, label: 'Segoe UI', detail: 'Clean, the Windows look', css: "'Segoe UI', sans-serif" },
  { value: 'Arial', label: 'Arial', detail: 'The classic subtitle face', css: 'Arial, sans-serif' },
  { value: 'Verdana', label: 'Verdana', detail: 'Wide and open, easy from the sofa', css: 'Verdana, sans-serif' },
  { value: 'Trebuchet MS', label: 'Trebuchet', detail: 'Friendly, a little rounder', css: "'Trebuchet MS', sans-serif" },
  { value: 'Bahnschrift', label: 'Bahnschrift', detail: 'Narrow and modern', css: 'Bahnschrift, sans-serif' },
  { value: 'Georgia', label: 'Georgia', detail: 'Serif, like a film print', css: 'Georgia, serif' },
  { value: 'Consolas', label: 'Consolas', detail: 'Typewriter spacing', css: 'Consolas, monospace' },
];

/** The font choices, each drawn in its own face. */
function FontPicker({ value, options, onChange }: { value: string; options: typeof FONTS; onChange: (v: string) => void }) {
  return (
    <div className="font-picker" role="radiogroup" aria-label="Subtitle font">
      {options.map((f) => (
        <button key={f.value} type="button" role="radio" aria-checked={f.value === value} title={f.detail} className={`font-tile ${f.value === value ? 'is-on' : ''}`} onClick={() => onChange(f.value)}>
          <span className="font-tile__sample" style={{ fontFamily: f.css }}>
            Aa
          </span>
          <span className="font-tile__name">{f.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Whether Windows has a font, told by whether asking for it changes how wide some text is drawn. */
function fontInstalled(name: string): boolean {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return true;
    const width = (family: string) => {
      ctx.font = `72px ${family}`;
      return ctx.measureText('mmmmmmmmmlli1WQ@').width;
    };
    return ['monospace', 'serif'].some((generic) => width(`'${name}', ${generic}`) !== width(generic));
  } catch {
    return true;
  }
}

export function SubtitlesSection() {
  const l = useSettings((x) => x.settings.languages);
  const st = useSettings((x) => x.settings.subtitleStyle);
  const set = useSettings((x) => x.set);

  const font = subtitleFont(st.font);
  // Only what this PC really has (they all come with Windows; this guards an unusual install),
  // plus a font saved from elsewhere (a restored backup), so the choice in effect is always shown.
  const fonts = useMemo(() => {
    const have = FONTS.filter((f) => f.value === DEFAULT_SUBTITLE_FONT || fontInstalled(f.value));
    return have.some((f) => f.value === font) ? have : [...have, { value: font, label: font, detail: 'Saved earlier', css: `'${font.replace(/['\\]/g, '')}', sans-serif` }];
  }, [font]);
  const fontMissing = !fontInstalled(font);
  const boxed = st.background === 'box';
  const noOutline = boxed && 'The box takes the outline’s place.';
  const textColours = withSaved(TEXT_COLOURS, st.color);
  const outlineColours = withSaved(OUTLINE_COLOURS, st.outlineColor);

  // The preview is drawn at half the player's scale, like the text in it.
  const preview = {
    ['--sub-size' as string]: `${st.size / 2}px`,
    ['--sub-color' as string]: st.color,
    ['--sub-outline' as string]: st.outlineColor,
    ['--sub-outline-w' as string]: `${boxed ? 0 : st.outlineSize / 2}px`,
    ['--sub-font' as string]: fonts.find((f) => f.value === font)!.css,
    ['--sub-lift' as string]: `${Math.round(st.marginY / 2)}px`,
  };

  return (
    <>
      <Group title="Languages" note="Each show also remembers the audio and subtitles you pick while watching it, and that choice wins over these.">
        <SettingRow id="languages.audio" stacked>
          <LanguageList value={l.audio} onChange={(v) => set('languages', { audio: v })} kind="an audio language" empty="None chosen: each title plays its own default audio." />
        </SettingRow>
        <SettingRow id="languages.subtitles" stacked>
          <LanguageList value={l.subtitles} onChange={(v) => set('languages', { subtitles: v })} kind="a subtitle language" empty="None chosen: subtitles only come on when you pick them in the player." />
        </SettingRow>
      </Group>

      <Group title="Subtitles">
        <SettingRow id="languages.subtitleMode" hint={SUB_MODES.find((m) => m.value === l.subtitleMode)?.detail}>
          <Segmented label="Turn subtitles on" value={l.subtitleMode} options={SUB_MODES.map(({ value, label }) => ({ value, label }))} onChange={(v) => set('languages', { subtitleMode: v })} />
        </SettingRow>
        <SettingRow id="languages.stripSdh">
          <Switch checked={l.stripSdh} onChange={(v) => set('languages', { stripSdh: v })} label="Prefer subtitles without sound descriptions" />
        </SettingRow>
      </Group>

      <div className="sub-look">
        <div className="sub-look__top">
          <h3 className="s-group__title">Subtitle look</h3>
          <div className="sub-preview" style={preview} aria-hidden>
            <span className={`sub-preview__text sub-preview__text--${st.background} ${st.bold ? 'is-bold' : ''}`}>Where were you last night?</span>
          </div>
        </div>
        <Group note="Styled subtitles (ASS, common in anime) keep their own look; these apply to plain ones. The preview is half the size of the real thing.">
          <SettingRow id="subtitleStyle.size">
            <Slider value={st.size} min={28} max={80} onChange={(v) => set('subtitleStyle', { size: v })} label="Subtitle size" format={(v) => (SIZE_NAMES[v] ? `${v} · ${SIZE_NAMES[v]}` : String(v))} />
          </SettingRow>
          <SettingRow id="subtitleStyle.font" stacked hint={fontMissing ? `${font} is not installed on this PC, so the player draws subtitles in its fallback font. Pick one of the others.` : undefined}>
            <FontPicker value={font} options={fonts} onChange={(v) => set('subtitleStyle', { font: v })} />
          </SettingRow>
          <SettingRow id="subtitleStyle.color">
            <Swatches label="Text colour" value={chosen(textColours, st.color)} options={textColours} onChange={(v) => set('subtitleStyle', { color: v })} />
          </SettingRow>
          <SettingRow id="subtitleStyle.background">
            <Segmented
              label="Behind the text"
              value={st.background}
              onChange={(v) => set('subtitleStyle', { background: v })}
              options={[
                { value: 'shadow', label: 'Shadow' },
                { value: 'none', label: 'Outline' },
                { value: 'box', label: 'Box' },
              ]}
            />
          </SettingRow>
        </Group>
        <Advanced section="languages" contains="Bold, outline and position">
          <Group>
            <SettingRow id="subtitleStyle.bold">
              <Switch checked={st.bold} onChange={(v) => set('subtitleStyle', { bold: v })} label="Bold subtitles" />
            </SettingRow>
            <SettingRow id="subtitleStyle.outlineSize" disabled={noOutline}>
              <Slider value={st.outlineSize} min={0} max={6} step={0.5} onChange={(v) => set('subtitleStyle', { outlineSize: v })} label="Outline width" format={(v) => v.toFixed(1)} />
            </SettingRow>
            <SettingRow id="subtitleStyle.outlineColor" disabled={noOutline}>
              <Swatches label="Outline colour" value={chosen(outlineColours, st.outlineColor)} options={outlineColours} onChange={(v) => set('subtitleStyle', { outlineColor: v })} />
            </SettingRow>
            <SettingRow id="subtitleStyle.marginY">
              <Slider value={st.marginY} min={10} max={160} step={2} onChange={(v) => set('subtitleStyle', { marginY: v })} label="Distance from the bottom" format={(v) => String(v)} />
            </SettingRow>
          </Group>
        </Advanced>
      </div>
    </>
  );
}
