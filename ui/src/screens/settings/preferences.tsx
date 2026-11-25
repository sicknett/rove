import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { useSettings, type SkipMode, type SubtitleMode, type AutoPlayMode } from '../../state/settings';
import { isValidRegex } from '../../sources/select';
import { Select, Segmented, Slider, Switch, TextField } from '../../ui/controls';
import { Group, SettingRow } from './parts';

const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['zh', 'Chinese'], ['ru', 'Russian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'],
  ['fi', 'Finnish'], ['pl', 'Polish'], ['tr', 'Turkish'], ['el', 'Greek'], ['he', 'Hebrew'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
  ['cs', 'Czech'], ['hu', 'Hungarian'], ['uk', 'Ukrainian'], ['ro', 'Romanian'], ['tl', 'Filipino'], ['fa', 'Persian'], ['ta', 'Tamil'], ['te', 'Telugu'],
];
const langName = (c: string) => LANGUAGES.find(([k]) => k === c)?.[1] ?? c;

function LanguageList({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const [adding, setAdding] = useState('');
  const rest = LANGUAGES.filter(([c]) => !value.includes(c));
  return (
    <div className="lang-list">
      {value.map((c, i) => (
        <span key={c} className="chip is-on chip--removable">
          <span className="chip__order">{i + 1}</span> {langName(c)}
          <button aria-label={`Remove ${langName(c)}`} onClick={() => onChange(value.filter((x) => x !== c))}>
            <X size={13} />
          </button>
        </span>
      ))}
      <Select
        label={`Add ${label}`}
        value={adding}
        options={[{ value: '', label: 'Add a language' }, ...rest.map(([c, n]) => ({ value: c, label: n }))]}
        onChange={(c) => {
          if (c) onChange([...value, c]);
          setAdding('');
        }}
      />
      {!value.length && (
        <span className="s-row__hint">
          <Plus size={12} /> None yet
        </span>
      )}
    </div>
  );
}

const SKIP_OPTIONS: { value: SkipMode; label: string }[] = [
  { value: 'button', label: 'Show a button' },
  { value: 'auto', label: 'Skip automatically' },
  { value: 'off', label: 'Off' },
];

export function PlaybackSection() {
  const p = useSettings((s) => s.settings.playback);
  const set = useSettings((s) => s.set);
  return (
    <>
      <Group title="Episodes">
        <SettingRow label="Play the next episode automatically" hint="After a short countdown at the credits">
          <Switch checked={p.autoPlayNext} onChange={(v) => set('playback', { autoPlayNext: v })} label="Auto-play next episode" />
        </SettingRow>
        <SettingRow label="Countdown" hint="Seconds before the next episode starts">
          <Slider value={p.nextCountdownSec} min={3} max={30} onChange={(v) => set('playback', { nextCountdownSec: v })} label="Countdown seconds" format={(v) => `${v} s`} />
        </SettingRow>
        <SettingRow label="Show “Next episode” before the end" hint="Used when the credits are not marked">
          <Slider value={p.nextLeadSec} min={10} max={120} step={5} onChange={(v) => set('playback', { nextLeadSec: v })} label="Lead time" format={(v) => `${v} s`} />
        </SettingRow>
        <SettingRow label="Ask “Are you still watching?”" hint="After this many episodes in a row without touching anything">
          <Select
            label="Still watching"
            value={p.stillWatchingAfter}
            options={[
              { value: 0, label: 'Never' },
              { value: 2, label: 'After 2 episodes' },
              { value: 3, label: 'After 3 episodes' },
              { value: 5, label: 'After 5 episodes' },
            ]}
            onChange={(v) => set('playback', { stillWatchingAfter: v })}
          />
        </SettingRow>
      </Group>
      <Group title="Skipping" note="Intro, recap and credit times come from the file's chapters, TheIntroDB, IntroDB, PublicMetaDB and AniSkip.">
        <SettingRow label="Intros">
          <Select label="Intros" value={p.skipIntro} options={SKIP_OPTIONS} onChange={(v) => set('playback', { skipIntro: v })} />
        </SettingRow>
        <SettingRow label="Recaps">
          <Select label="Recaps" value={p.skipRecap} options={SKIP_OPTIONS} onChange={(v) => set('playback', { skipRecap: v })} />
        </SettingRow>
        <SettingRow label="Credits" hint="For episodes, the next-episode card takes over">
          <Select label="Credits" value={p.skipCredits} options={SKIP_OPTIONS} onChange={(v) => set('playback', { skipCredits: v })} />
        </SettingRow>
      </Group>
      <Group title="Player">
        <SettingRow label="When there is a saved position">
          <Segmented
            label="Resume"
            value={p.resume}
            onChange={(v) => set('playback', { resume: v })}
            options={[
              { value: 'resume', label: 'Resume' },
              { value: 'ask', label: 'Ask' },
              { value: 'start', label: 'Start over' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Skip step" hint="Arrow keys and the ±buttons">
          <Segmented
            label="Skip step"
            value={p.seekStepSec}
            onChange={(v) => set('playback', { seekStepSec: v })}
            options={[
              { value: 5, label: '5 s' },
              { value: 10, label: '10 s' },
              { value: 15, label: '15 s' },
              { value: 30, label: '30 s' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Hardware decoding" hint="Uses the graphics card; turn off only if a video shows artefacts">
          <Switch checked={p.hwdec !== 'no'} onChange={(v) => set('playback', { hwdec: v ? 'auto-safe' : 'no' })} label="Hardware decoding" />
        </SettingRow>
        <SettingRow label="Remember volume">
          <Switch checked={p.rememberVolume} onChange={(v) => set('playback', { rememberVolume: v })} label="Remember volume" />
        </SettingRow>
      </Group>
    </>
  );
}

export function SourcesSection() {
  const s = useSettings((x) => x.settings.sources);
  const set = useSettings((x) => x.set);
  const [regex, setRegex] = useState(s.regex);
  const regexOk = isValidRegex(regex);
  return (
    <>
      <Group title="Starting playback" note="Your stream addon's own order is kept (AIOStreams sorts on its server). Auto-play takes the first source that fits; otherwise the source list opens.">
        <SettingRow label="Auto-play" stacked>
          <Segmented<AutoPlayMode>
            label="Auto-play"
            value={s.autoPlay}
            onChange={(v) => set('sources', { autoPlay: v })}
            options={[
              { value: 'binge', label: 'Same release, else first' },
              { value: 'first', label: 'First source' },
              { value: 'regex', label: 'Matching a rule' },
              { value: 'off', label: 'Always ask' },
            ]}
          />
        </SettingRow>
        {s.autoPlay === 'regex' && (
          <SettingRow label="Rule" hint="A regular expression matched against each source's name and description, e.g. 2160p.*(DV|HDR)" stacked>
            <TextField value={regex} onChange={(v) => (setRegex(v), isValidRegex(v) && set('sources', { regex: v }))} error={regexOk ? null : 'That expression is not valid'} placeholder="1080p|2160p" />
          </SettingRow>
        )}
        <SettingRow label="Stay with the same release between episodes" hint="Uses the binge group the addon gives, so a season keeps one quality and group">
          <Switch checked={s.preferBingeGroup} onChange={(v) => set('sources', { preferBingeGroup: v })} label="Prefer the same release" />
        </SettingRow>
        <SettingRow label="Reuse a working link for" hint="Starts instantly when you come back; debrid links expire after a while">
          <Select
            label="Reuse link"
            value={s.reuseLinkHours}
            options={[
              { value: 0, label: 'Never' },
              { value: 1, label: '1 hour' },
              { value: 3, label: '3 hours' },
              { value: 6, label: '6 hours' },
              { value: 12, label: '12 hours' },
            ]}
            onChange={(v) => set('sources', { reuseLinkHours: v })}
          />
        </SettingRow>
      </Group>
      <Group title="External player" note="Shows an “open in” button on each source. Give the full path to the program, e.g. C:\Program Files\mpv\mpv.exe or VLC.">
        <SettingRow label="Program" stacked>
          <TextField value={s.externalPlayer} onChange={(v) => set('sources', { externalPlayer: v })} placeholder="C:\Program Files\VideoLAN\VLC\vlc.exe" />
        </SettingRow>
      </Group>
    </>
  );
}

const SUB_MODES: { value: SubtitleMode; label: string; detail: string }[] = [
  { value: 'forced', label: 'Forced only', detail: 'Signs and foreign lines in a language you know' },
  { value: 'foreign', label: 'When the audio is in another language', detail: 'Full subtitles unless the audio is one of your subtitle languages' },
  { value: 'always', label: 'Always', detail: 'In your first available subtitle language' },
  { value: 'off', label: 'Off', detail: 'Never turn them on by themselves' },
];

export function LanguagesSection() {
  const l = useSettings((x) => x.settings.languages);
  const st = useSettings((x) => x.settings.subtitleStyle);
  const set = useSettings((x) => x.set);
  return (
    <>
      <Group title="Languages" note="Each show also remembers the audio and subtitles you pick while watching it.">
        <SettingRow label="Audio, in order of preference" stacked>
          <LanguageList value={l.audio} onChange={(v) => set('languages', { audio: v })} label="audio language" />
        </SettingRow>
        <SettingRow label="Subtitles, in order of preference" hint="These are the languages you read" stacked>
          <LanguageList value={l.subtitles} onChange={(v) => set('languages', { subtitles: v })} label="subtitle language" />
        </SettingRow>
        <SettingRow label="Turn subtitles on">
          <Select label="Subtitle mode" value={l.subtitleMode} options={SUB_MODES.map((m) => ({ value: m.value, label: m.label, detail: m.detail }))} onChange={(v) => set('languages', { subtitleMode: v })} />
        </SettingRow>
        <SettingRow label="Prefer subtitles without hearing-impaired notes" hint="Puts SDH tracks last when there is a choice">
          <Switch checked={l.stripSdh} onChange={(v) => set('languages', { stripSdh: v })} label="Prefer non-SDH" />
        </SettingRow>
      </Group>
      <Group title="Subtitle style" note="Styled subtitles (ASS) keep their own look; these apply to plain ones.">
        <div className="sub-preview" style={{ ['--sub-size' as string]: `${st.size / 2}px`, ['--sub-color' as string]: st.color, ['--sub-outline' as string]: st.outlineColor, ['--sub-outline-w' as string]: `${st.outlineSize / 2}px` }}>
          <span className={`sub-preview__text sub-preview__text--${st.background} ${st.bold ? 'is-bold' : ''}`}>The quick brown fox jumps over the lazy dog</span>
        </div>
        <SettingRow label="Size">
          <Slider value={st.size} min={28} max={80} onChange={(v) => set('subtitleStyle', { size: v })} label="Subtitle size" format={(v) => String(v)} />
        </SettingRow>
        <SettingRow label="Colour">
          <div className="swatches">
            {['#F2F2F2', '#FFFFFF', '#FFE873', '#BDE7C9', '#A8D8FF'].map((c) => (
              <button key={c} className={`swatch ${st.color === c ? 'is-on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => set('subtitleStyle', { color: c })} />
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Background">
          <Segmented
            label="Background"
            value={st.background}
            onChange={(v) => set('subtitleStyle', { background: v })}
            options={[
              { value: 'shadow', label: 'Outline + shadow' },
              { value: 'none', label: 'Outline' },
              { value: 'box', label: 'Box' },
            ]}
          />
        </SettingRow>
        {st.background !== 'box' && (
          <SettingRow label="Outline">
            <Slider value={st.outlineSize} min={0} max={6} step={0.5} onChange={(v) => set('subtitleStyle', { outlineSize: v })} label="Outline width" format={(v) => v.toFixed(1)} />
          </SettingRow>
        )}
        <SettingRow label="Bold">
          <Switch checked={st.bold} onChange={(v) => set('subtitleStyle', { bold: v })} label="Bold subtitles" />
        </SettingRow>
        <SettingRow label="Distance from the bottom">
          <Slider value={st.marginY} min={10} max={160} step={2} onChange={(v) => set('subtitleStyle', { marginY: v })} label="Bottom margin" format={(v) => String(v)} />
        </SettingRow>
      </Group>
    </>
  );
}

export function AudioSection() {
  const a = useSettings((x) => x.settings.audio);
  const set = useSettings((x) => x.set);
  return (
    <Group title="Sound">
      <SettingRow label="Audio offset" hint="Raise it if Bluetooth headphones play behind the picture; the video waits to match">
        <Slider value={a.delayMs} min={-500} max={1500} step={50} onChange={(v) => set('audio', { delayMs: v })} label="Audio offset" format={(v) => `${v > 0 ? '+' : ''}${v} ms`} />
      </SettingRow>
      <SettingRow label="Even out loud and quiet scenes" hint="Levels dialogue and explosions; good for late nights">
        <Switch checked={a.normalize} onChange={(v) => set('audio', { normalize: v })} label="Level volume" />
      </SettingRow>
      <SettingRow label="Volume boost" hint="Lets the volume go past 100 %">
        <Select
          label="Volume boost"
          value={a.volumeMax}
          options={[
            { value: 100, label: 'Off' },
            { value: 130, label: 'Up to 130 %' },
            { value: 150, label: 'Up to 150 %' },
          ]}
          onChange={(v) => set('audio', { volumeMax: v })}
        />
      </SettingRow>
      <SettingRow label="Pass surround sound to a receiver" hint="Dolby and DTS untouched over HDMI. Leave off for headphones and speakers.">
        <Switch checked={a.passthrough} onChange={(v) => set('audio', { passthrough: v })} label="Passthrough" />
      </SettingRow>
    </Group>
  );
}

export function AppearanceSection() {
  const a = useSettings((x) => x.settings.appearance);
  const set = useSettings((x) => x.set);
  const accents: { value: typeof a.accent; color: string; label: string }[] = [
    { value: 'sage', color: '#9eb7a4', label: 'Sage' },
    { value: 'mist', color: '#9fb3c8', label: 'Mist' },
    { value: 'sand', color: '#cbb48f', label: 'Sand' },
    { value: 'rose', color: '#c99aa6', label: 'Rose' },
    { value: 'sky', color: '#8fc1e3', label: 'Sky' },
  ];
  return (
    <Group title="Look">
      <SettingRow label="Accent">
        <div className="swatches">
          {accents.map((c) => (
            <button key={c.value} className={`swatch swatch--lg ${a.accent === c.value ? 'is-on' : ''}`} style={{ background: c.color }} aria-label={c.label} title={c.label} onClick={() => set('appearance', { accent: c.value })} />
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Navigation" hint="Home, Search and the rest down the left side, or across the top">
        <Segmented
          label="Navigation"
          value={a.navPosition}
          onChange={(v) => set('appearance', { navPosition: v })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'top', label: 'Top' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Poster size">
        <Segmented
          label="Poster size"
          value={a.cardSize}
          onChange={(v) => set('appearance', { cardSize: v })}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Show ratings on posters">
        <Switch checked={a.showRatings} onChange={(v) => set('appearance', { showRatings: v })} label="Ratings on posters" />
      </SettingRow>
      <SettingRow label="Reduce motion" hint="Fewer animations and no moving backgrounds">
        <Switch checked={a.reduceMotion} onChange={(v) => set('appearance', { reduceMotion: v })} label="Reduce motion" />
      </SettingRow>
    </Group>
  );
}
