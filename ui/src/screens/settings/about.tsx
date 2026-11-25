// Settings → About: the version, updates, and what ROVE is built with.

import { Download, RefreshCw } from 'lucide-react';
import { useUpdate } from '../../lib/update';
import { Button } from '../../ui/controls';
import { Group, SettingRow } from './parts';
import markUrl from '../../assets/rove-mark.png';

const megabytes = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** Check for a newer release, and install it (signed builds) or download its Setup (any other). */
function UpdateRow() {
  const { status, release, error, received, total, checkedAt, selfUpdate } = useUpdate();
  const check = useUpdate((s) => s.check);
  const install = useUpdate((s) => s.install);
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';
  const hint =
    status === 'available' && release
      ? selfUpdate
        ? `Version ${release.version} is ready to install. ROVE closes, updates and opens again; nothing you set up changes.`
        : `Version ${release.version} is out. Its Setup downloads straight to your Downloads folder through your browser: close ROVE, run it, and everything you set up stays.`
      : status === 'downloading'
        ? total > 0
          ? `Downloading ${megabytes(received)} of ${megabytes(total)}.`
          : 'Downloading.'
        : status === 'installing'
          ? 'Installing. ROVE will reopen in a moment.'
          : status === 'checking'
            ? 'Checking.'
            : status === 'error'
              ? (error ?? 'Could not check for updates.')
              : status === 'current'
                ? `You have the latest version${checkedAt ? ` (checked at ${new Date(checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}.`
                : undefined;
  return (
    <>
      <SettingRow id="about.update" hint={hint}>
        {status === 'available' || status === 'downloading' || status === 'installing' ? (
          <Button variant="primary" icon={<Download size={16} />} disabled={busy} onClick={() => void install()}>
            {status === 'available' ? (selfUpdate ? `Update to ${release?.version}` : `Get ${release?.version}`) : 'Updating'}
          </Button>
        ) : (
          <Button variant="secondary" icon={<RefreshCw size={16} className={status === 'checking' ? 'spin' : ''} />} disabled={busy} onClick={() => void check()}>
            Check for updates
          </Button>
        )}
      </SettingRow>
      {status === 'available' && release?.notes && <p className="about__notes">{release.notes}</p>}
    </>
  );
}

export function AboutSection() {
  return (
    <>
      <Group>
        <div className="about">
          <img src={markUrl} alt="" className="about__mark" />
          <div>
            <h3 className="about__name">ROVE</h3>
            <p className="about__version">Version {__APP_VERSION__}</p>
          </div>
        </div>
        <UpdateRow />
      </Group>
      <Group id="about.credits" title="Built with">
        <SettingRow label="Playback" hint="mpv (libmpv) with Direct3D 11 and libplacebo." />
        <SettingRow label="Window and page" hint="Rust with tao and wry, on Microsoft Edge WebView2." />
        <SettingRow label="Metadata" hint="Your addons, plus TMDB when there is a key. This product uses the TMDB API but is not endorsed or certified by TMDB." />
        <SettingRow label="Skip times" hint="Community data from TheIntroDB, IntroDB, PublicMetaDB and AniSkip." />
      </Group>
    </>
  );
}
