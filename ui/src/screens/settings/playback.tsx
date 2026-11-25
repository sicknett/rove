// Settings → Playback: what Play does, how episodes follow each other, what gets skipped, and
// under Advanced the rarely touched parts (source rules, saved links, another player, decoding).

import { useState } from 'react';
import { useSettings, type AutoPlayMode, type SkipMode } from '../../state/settings';
import { isValidRegex } from '../../sources/select';
import { Segmented, Select, Slider, Switch, TextField } from '../../ui/controls';
import { Advanced, Group, SettingRow, useSettingsNav } from './parts';

const SKIP_OPTIONS: { value: SkipMode; label: string }[] = [
  { value: 'button', label: 'Button' },
  { value: 'auto', label: 'Automatic' },
  { value: 'off', label: 'Off' },
];

const seconds = (v: number) => `${v} s`;

export function PlaybackSection() {
  const p = useSettings((s) => s.settings.playback);
  const src = useSettings((s) => s.settings.sources);
  const set = useSettings((s) => s.set);
  const { go } = useSettingsNav();

  // The rule is saved only while it is a valid expression; what is being typed lives here.
  const [rule, setRule] = useState(src.regex);
  const [savedRule, setSavedRule] = useState(src.regex);
  if (src.regex !== savedRule) {
    // Changed from elsewhere (a reset, or its undo): show that.
    setSavedRule(src.regex);
    if (src.regex !== rule) setRule(src.regex);
  }
  const ruleOk = isValidRegex(rule);

  const sourceHint: Record<AutoPlayMode, string> = {
    binge: src.preferBingeGroup
      ? 'Plays the same release as the last episode when there is one, and otherwise the first source your addons list.'
      : 'Plays the first source your addons list. (“Stay with the same release” is off under Advanced.)',
    first: 'Always plays the first source your addons list.',
    regex: src.regex.trim() ? `Plays the first source that fits your rule, ${src.regex.trim()}. When none does, the source list opens.` : 'There is no rule yet, so the source list opens every time. Write one under Advanced.',
    off: 'The source list opens every time, and you pick.',
  };
  const resumeHint = { resume: 'Play picks up where you stopped.', ask: 'Play asks whether to pick up where you stopped or start over.', start: 'Play always starts from the beginning.' }[p.resume];
  // Episodes follow each other by themselves through the countdown, or through credits skipped automatically.
  const chains = p.autoPlayNext || p.skipCredits === 'auto';

  return (
    <>
      <Group title="Starting" note="Sources keep the order your stream addon gives them (AIOStreams sorts on its server), so “first” means the addon’s own top pick.">
        <SettingRow id="playback.resume" hint={resumeHint}>
          <Segmented
            label="A title you stopped partway"
            value={p.resume}
            onChange={(v) => set('playback', { resume: v })}
            options={[
              { value: 'resume', label: 'Resume' },
              { value: 'ask', label: 'Ask' },
              { value: 'start', label: 'Start over' },
            ]}
          />
        </SettingRow>
        <SettingRow id="sources.autoPlay" hint={sourceHint[src.autoPlay]}>
          <Segmented<AutoPlayMode>
            label="Choosing the source"
            value={src.autoPlay}
            onChange={(v) => {
              set('sources', { autoPlay: v });
              // The rule itself is under Advanced: with none written yet, go straight to it.
              if (v === 'regex' && !src.regex.trim()) go('sources.regex');
            }}
            options={[
              { value: 'binge', label: 'Best match' },
              { value: 'first', label: 'First source' },
              { value: 'regex', label: 'My rule' },
              { value: 'off', label: 'Ask me' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group title="Episodes">
        <SettingRow id="playback.autoPlayNext">
          <Switch checked={p.autoPlayNext} onChange={(v) => set('playback', { autoPlayNext: v })} label="Play the next episode automatically" />
        </SettingRow>
        <SettingRow id="playback.nextCountdownSec" disabled={!p.autoPlayNext && 'Only counts down while the next episode plays automatically.'}>
          <Slider value={p.nextCountdownSec} min={3} max={30} onChange={(v) => set('playback', { nextCountdownSec: v })} label="Countdown before the next episode, in seconds" format={seconds} />
        </SettingRow>
        <SettingRow id="playback.stillWatchingAfter" disabled={!chains && 'Nothing to count: episodes only start by themselves with the switch above on, or with Credits set to Automatic.'}>
          <Segmented
            label="Ask “Are you still watching?”"
            value={p.stillWatchingAfter}
            onChange={(v) => set('playback', { stillWatchingAfter: v })}
            options={[
              { value: 2, label: 'After 2' },
              { value: 3, label: 'After 3' },
              { value: 5, label: 'After 5' },
              { value: 0, label: 'Never' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group
        title="Skipping"
        note="Button offers “Skip” for you to press (or the S key); Automatic jumps without asking. The times come from the file’s chapters and from community data (TheIntroDB, IntroDB, PublicMetaDB, AniSkip), so not every title has them."
      >
        <SettingRow id="playback.skipIntro" hint={false}>
          <Segmented label="Intros" value={p.skipIntro} options={SKIP_OPTIONS} onChange={(v) => set('playback', { skipIntro: v })} />
        </SettingRow>
        <SettingRow id="playback.skipRecap" hint={false}>
          <Segmented label="Recaps" value={p.skipRecap} options={SKIP_OPTIONS} onChange={(v) => set('playback', { skipRecap: v })} />
        </SettingRow>
        <SettingRow id="playback.skipCredits">
          <Segmented label="Credits" value={p.skipCredits} options={SKIP_OPTIONS} onChange={(v) => set('playback', { skipCredits: v })} />
        </SettingRow>
      </Group>

      <Group title="Controls">
        <SettingRow id="playback.seekStepSec">
          <Segmented
            label="Skip back and forward by"
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
      </Group>

      <Advanced section="playback" contains="Source rule and saved links, next-episode timing, another player, hardware decoding">
        <Group title="Sources">
          <SettingRow
            id="sources.preferBingeGroup"
            disabled={(src.autoPlay === 'first' || src.autoPlay === 'off') && `Not used while “Choosing the source” is ${src.autoPlay === 'first' ? 'First source' : 'Ask me'}.`}
          >
            <Switch checked={src.preferBingeGroup} onChange={(v) => set('sources', { preferBingeGroup: v })} label="Stay with the same release between episodes" />
          </SettingRow>
          <SettingRow id="sources.regex" stacked disabled={src.autoPlay !== 'regex' && 'Used when “Choosing the source” is My rule. What you wrote is kept.'}>
            <TextField
              value={rule}
              onChange={(v) => {
                setRule(v);
                if (isValidRegex(v)) {
                  setSavedRule(v);
                  set('sources', { regex: v });
                }
              }}
              error={ruleOk ? null : 'That is not a valid expression, so the last valid one is still in use.'}
              placeholder="1080p|2160p"
              aria-label="Your rule"
            />
          </SettingRow>
          <SettingRow id="sources.reuseLinkHours">
            <Select
              label="Reuse a link that worked for"
              value={src.reuseLinkHours}
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
        <Group title="Episodes">
          <SettingRow id="playback.nextLeadSec">
            <Slider value={p.nextLeadSec} min={10} max={120} step={5} onChange={(v) => set('playback', { nextLeadSec: v })} label="Show the next episode this long before the end, in seconds" format={seconds} />
          </SettingRow>
        </Group>
        <Group title="Player">
          <SettingRow id="sources.externalPlayer" stacked>
            <TextField value={src.externalPlayer} onChange={(v) => set('sources', { externalPlayer: v })} placeholder="Path to the player’s .exe" aria-label="External player" />
          </SettingRow>
          <SettingRow id="playback.hwdec">
            <Switch checked={p.hwdec !== 'no'} onChange={(v) => set('playback', { hwdec: v ? 'auto-safe' : 'no' })} label="Hardware decoding" />
          </SettingRow>
        </Group>
      </Advanced>
    </>
  );
}
