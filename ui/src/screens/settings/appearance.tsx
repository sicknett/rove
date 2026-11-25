// Settings → Appearance: the app's colour, where the navigation sits, motion, and how posters
// look and behave wherever they appear.

import { useSettings, type Settings } from '../../state/settings';
import { Segmented, Switch } from '../../ui/controls';
import { Group, SeeAlso, SettingLink, SettingRow, Swatches, type SwatchOption } from './parts';

const ACCENTS: SwatchOption<Settings['appearance']['accent']>[] = [
  { value: 'sage', color: '#9eb7a4', label: 'Sage' },
  { value: 'mist', color: '#9fb3c8', label: 'Mist' },
  { value: 'sand', color: '#cbb48f', label: 'Sand' },
  { value: 'rose', color: '#c99aa6', label: 'Rose' },
  { value: 'sky', color: '#8fc1e3', label: 'Sky' },
];

export function AppearanceSection() {
  const a = useSettings((x) => x.settings.appearance);
  const set = useSettings((x) => x.set);
  // Windows can ask every app to keep motion down; ROVE follows it whatever is chosen here.
  const windowsCalm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const noPreview = a.reduceMotion ? 'Off while Reduce motion is on.' : windowsCalm ? 'Off because Windows is set to show fewer animations.' : null;
  return (
    <>
      <Group title="App">
        <SettingRow id="appearance.accent">
          <Swatches label="Accent colour" large value={a.accent} options={ACCENTS} onChange={(v) => set('appearance', { accent: v })} />
        </SettingRow>
        <SettingRow id="appearance.navPosition">
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
        <SettingRow id="appearance.reduceMotion">
          <Switch checked={a.reduceMotion} onChange={(v) => set('appearance', { reduceMotion: v })} label="Reduce motion" />
        </SettingRow>
      </Group>

      <Group title="Posters">
        <SettingRow id="appearance.cardSize">
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
        <SettingRow id="appearance.showRatings">
          <Switch checked={a.showRatings} onChange={(v) => set('appearance', { showRatings: v })} label="Ratings on posters" />
        </SettingRow>
        <SettingRow id="appearance.hoverPreview" disabled={noPreview}>
          <Switch checked={a.hoverPreview} onChange={(v) => set('appearance', { hoverPreview: v })} label="Preview on hover" />
        </SettingRow>
      </Group>

      <SeeAlso>
        The banner, its trailers and the rows on Home are under <SettingLink to="appearance.heroEnabled">Home layout</SettingLink>.
      </SeeAlso>
    </>
  );
}
