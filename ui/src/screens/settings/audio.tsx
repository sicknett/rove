// Settings → Audio: volume, timing against the picture, and (under Advanced) surround passthrough.

import { useSettings } from '../../state/settings';
import { Segmented, Slider, Switch } from '../../ui/controls';
import { Advanced, Group, SeeAlso, SettingLink, SettingRow } from './parts';

export function AudioSection() {
  const a = useSettings((x) => x.settings.audio);
  const rememberVolume = useSettings((x) => x.settings.playback.rememberVolume);
  const set = useSettings((x) => x.set);
  return (
    <>
      <Group title="Volume">
        <SettingRow id="playback.rememberVolume">
          <Switch checked={rememberVolume} onChange={(v) => set('playback', { rememberVolume: v })} label="Remember the volume" />
        </SettingRow>
        <SettingRow id="audio.volumeMax">
          <Segmented
            label="Volume boost"
            value={a.volumeMax}
            onChange={(v) => set('audio', { volumeMax: v })}
            options={[
              { value: 100, label: 'Off' },
              { value: 130, label: 'To 130 %' },
              { value: 150, label: 'To 150 %' },
            ]}
          />
        </SettingRow>
        <SettingRow id="audio.normalize">
          <Switch checked={a.normalize} onChange={(v) => set('audio', { normalize: v })} label="Even out loud and quiet scenes" />
        </SettingRow>
      </Group>

      <Group title="Timing">
        <SettingRow id="audio.delayMs">
          <Slider value={a.delayMs} min={-500} max={1500} step={50} onChange={(v) => set('audio', { delayMs: v })} label="Audio offset, in milliseconds" format={(v) => `${v > 0 ? '+' : ''}${v} ms`} />
        </SettingRow>
      </Group>

      <Advanced section="audio" contains="Surround sound passthrough to a receiver">
        <Group title="Output">
          <SettingRow id="audio.passthrough">
            <Switch checked={a.passthrough} onChange={(v) => set('audio', { passthrough: v })} label="Send surround sound untouched to a receiver" />
          </SettingRow>
        </Group>
      </Advanced>

      <SeeAlso>
        Which language plays is under <SettingLink to="languages.audio">Subtitles &amp; languages</SettingLink>.
      </SeeAlso>
    </>
  );
}
