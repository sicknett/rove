// Sharing a setup with a code (lib/share.ts): the window that makes a code, and the one that
// takes a code, shows what is inside and asks before anything on this PC changes. Settings → Data
// opens both; first-run setup opens the second.

import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { applyShare, createShare, fetchShare, profilesReplaced, SHARE_HOSTS, shareMessage, stopSharing, type CreatedShare, type FetchedShare, type ShareSummary } from '../../lib/share';
import { CODE_LENGTH, groupCode, tidyCode } from '../../lib/shareCode';
import { useAddons } from '../../addons/store';
import { useProfiles } from '../../state/profiles';
import { Button, Dialog } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { count } from './format';

const [MAIN_HOST, SPARE_HOST] = SHARE_HOSTS;

/** "Wednesday 2 December at 18:24": a code's last moment, said in full. */
const until = (ms: number) => `${new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} at ${new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

const listed = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What a setup holds, as plain rows. */
function Contents({ summary }: { summary: ShareSummary }) {
  return (
    <dl className="share-facts">
      <div>
        <dt>Addons</dt>
        <dd>{summary.addons}</dd>
      </div>
      <div>
        <dt>{summary.profiles.length === 1 ? 'Profile' : 'Profiles'}</dt>
        <dd>{summary.profiles.join(', ')}</dd>
      </div>
      <div>
        <dt>Collections</dt>
        <dd>{summary.collections}</dd>
      </div>
      <div>
        <dt>API keys and sign-ins</dt>
        <dd>{summary.keys ? 'Included' : 'Not included'}</dd>
      </div>
    </dl>
  );
}

/** The code in its groups of five. It can be selected, and breaks between groups only. */
function CodeText({ code }: { code: string }) {
  const groups = code.split('-');
  return (
    <p className="share-code" aria-label="Your code">
      {groups.map((g, i) => (
        <span key={i}>
          {g}
          {i < groups.length - 1 && '-'}
          <wbr />
        </span>
      ))}
    </p>
  );
}

export function CreateCodeDialog({ open, includeKeys, onClose }: { open: boolean; includeKeys: boolean; onClose: () => void }) {
  const [made, setMade] = useState<CreatedShare | null>(null);
  const [busy, setBusy] = useState<'making' | 'stopping' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) return;
    abort.current?.abort();
    setMade(null);
    setBusy(null);
    setError(null);
  }, [open]);

  const make = async () => {
    const control = new AbortController();
    abort.current = control;
    setBusy('making');
    setError(null);
    try {
      const share = await createShare(includeKeys, control.signal);
      if (!control.signal.aborted) setMade(share);
    } catch (e) {
      if (!control.signal.aborted) setError(shareMessage(e));
    } finally {
      if (!control.signal.aborted) setBusy(null);
    }
  };

  const stop = async () => {
    if (!made) return;
    setBusy('stopping');
    setError(null);
    try {
      await stopSharing(made);
      toast.success('The copy was deleted. That code no longer works.');
      onClose();
    } catch (e) {
      setError(shareMessage(e));
      setBusy(null);
    }
  };

  if (made) {
    return (
      <Dialog
        open={open}
        onClose={() => !busy && onClose()}
        title="Your code"
        width={560}
        footer={
          <>
            <Button variant="primary" disabled={!!busy} onClick={onClose}>
              Done
            </Button>
            {made.deleteToken && (
              <Button variant="ghost" busy={busy === 'stopping'} onClick={() => void stop()}>
                Stop sharing
              </Button>
            )}
          </>
        }
      >
        <CodeText code={made.code} />
        <div className="share-actions">
          <Button variant="secondary" icon={<Copy size={16} />} onClick={() => void navigator.clipboard?.writeText(made.code).then(() => toast.success('Code copied'))}>
            Copy code
          </Button>
        </div>
        <p className="dialog__text">
          Give this code to the person you are sharing with. They enter it in ROVE under Settings → Data → Use a code, or on the first screen of a new install.
        </p>
        <p className="dialog__text">
          The encrypted copy is kept at {made.host.name} until {until(made.expiresAt)}, then deleted, and the code stops working. Only someone with the code can read it
          {made.summary.keys ? ', and whoever has it gets your keys and sign-ins until then: give it only to someone you trust.' : '.'}
        </p>
        <Contents summary={made.summary} />
        {made.deleteToken && <p className="share-small">Stop sharing deletes the copy now. It can only be done from this window, so close it once you are sure.</p>}
        {error && <p className="field__error">{error}</p>}
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Share your setup"
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={!!busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'making'} onClick={() => void make()}>
            Create code
          </Button>
        </>
      }
    >
      <p className="dialog__text">
        ROVE encrypts a copy of your setup on this PC and stores it at {MAIN_HOST.name}, a public service that keeps text it cannot read ({SPARE_HOST.name} is used if that one does not answer). The key is only in the code, so
        only someone with the code can read the copy.
      </p>
      <dl className="share-facts">
        <div>
          <dt>Shared</dt>
          <dd>Addons, profiles, each profile’s settings, Home layout and collections</dd>
        </div>
        <div>
          <dt>Addon links</dt>
          <dd>Shared as they are. A link can carry that addon’s configuration, keys included</dd>
        </div>
        <div>
          <dt>API keys and sign-ins</dt>
          <dd>{includeKeys ? 'Included: whoever has the code gets working keys and sign-ins' : 'Not included'}</dd>
        </div>
        <div>
          <dt>Stays here</dt>
          <dd>Watch history, recent searches, profile PINs and the external player</dd>
        </div>
        <div>
          <dt>Kept for</dt>
          <dd>{includeKeys ? 'One day, then the service deletes it' : 'Up to a week, then the service deletes it'}</dd>
        </div>
      </dl>
      {error && <p className="field__error">{error}</p>}
    </Dialog>
  );
}

/**
 * Takes a code, fetches what it points at, shows what is inside, and only then, on a yes,
 * replaces this PC's setup with it (the same replace as restoring a backup). `firstRun` is the
 * setup screen of a new install, where there is nothing yet to replace.
 */
export function UseCodeDialog({ open, onClose, firstRun }: { open: boolean; onClose: () => void; firstRun?: boolean }) {
  const [text, setText] = useState('');
  const [share, setShare] = useState<FetchedShare | null>(null);
  const [busy, setBusy] = useState<'fetching' | 'applying' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const profiles = useProfiles((s) => s.profiles);
  const addonsHere = useAddons((s) => s.addons.length);

  useEffect(() => {
    if (open) {
      field.current?.focus();
      return;
    }
    abort.current?.abort();
    setText('');
    setShare(null);
    setBusy(null);
    setError(null);
  }, [open]);

  const fetchIt = async () => {
    const control = new AbortController();
    abort.current = control;
    setBusy('fetching');
    setError(null);
    try {
      const got = await fetchShare(text, control.signal);
      if (!control.signal.aborted) setShare(got);
    } catch (e) {
      if (!control.signal.aborted) setError(shareMessage(e));
    } finally {
      if (!control.signal.aborted) setBusy(null);
    }
  };

  const apply = async () => {
    if (!share || busy) return;
    setBusy('applying');
    try {
      const done = await applyShare(share);
      toast.success(`The shared setup is in place: ${count(done.addons, 'addon')} and ${count(done.profiles, 'profile')}. Reloading…`);
      window.setTimeout(() => location.reload(), 900);
    } catch {
      setBusy(null);
      setShare(null);
      toast.error('The setup could not be put in place. Some of it may have been written: use the code again, or restart ROVE.');
    }
  };

  if (share) {
    const s = share.summary;
    const made = s.createdAt ? new Date(s.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
    const going = firstRun ? [] : profilesReplaced(share, profiles);
    return (
      <Dialog
        open={open}
        onClose={() => !busy && onClose()}
        title={firstRun ? 'Use this setup?' : 'Replace your setup with this one?'}
        width={520}
        footer={
          <>
            <Button variant="ghost" disabled={!!busy} onClick={() => setShare(null)}>
              Back
            </Button>
            <Button variant={firstRun ? 'primary' : 'danger'} busy={busy === 'applying'} onClick={() => void apply()}>
              {firstRun ? 'Use this setup' : 'Replace my setup'}
            </Button>
          </>
        }
      >
        <p className="dialog__text">
          {s.sharedBy ? `Shared by ${s.sharedBy}` : 'A shared ROVE setup'}
          {made ? `, made ${made}` : ''}. It came from {share.host.name} and was decrypted on this PC.
        </p>
        <Contents summary={s} />
        {firstRun ? (
          <p className="dialog__text">ROVE is set up with these addons, profiles and settings{s.keys ? ', signed in with the keys and sign-ins that came with them' : ''}.</p>
        ) : (
          <p className="dialog__text">
            The addons, profiles and settings on this PC are replaced with these: {count(addonsHere, 'addon')} and {count(profiles.length, 'profile')} here now.{' '}
            {s.keys ? 'Its keys and sign-ins replace the ones here. ' : 'Your own keys stay. '}
            {going.length
              ? `${listed(going)} ${going.length === 1 ? 'is' : 'are'} not in this setup: ${going.length === 1 ? 'that profile goes' : 'those profiles go'}, and ${going.length === 1 ? 'its' : 'their'} watch history is no longer shown. `
              : 'Watch history on this PC is kept. '}
            This cannot be undone, so back up first (Settings → Data → Back up) if you may want the setup you have now.
          </p>
        )}
      </Dialog>
    );
  }

  const typed = tidyCode(text).length;
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Use a code"
      width={520}
      footer={
        <>
          <Button variant="ghost" disabled={!!busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'fetching'} disabled={!typed} onClick={() => void fetchIt()}>
            Continue
          </Button>
        </>
      }
    >
      <p className="dialog__text">Enter the code a friend made in their ROVE (Settings → Data → Create a code). You see what is in it before anything on this PC changes.</p>
      <textarea
        ref={field}
        className={`share-entry ${error ? 'has-error' : ''}`}
        rows={3}
        value={text}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        aria-label="Code"
        aria-invalid={!!error}
        placeholder={groupCode('X'.repeat(15)) + '-…'}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (typed && !busy) void fetchIt();
          }
        }}
      />
      {error ? (
        <p className="field__error">{error}</p>
      ) : (
        <p className="field__hint">{typed ? `${typed} of ${CODE_LENGTH} letters and digits. Capitals, spaces and hyphens do not matter.` : `${CODE_LENGTH} letters and digits. Capitals, spaces and hyphens do not matter.`}</p>
      )}
    </Dialog>
  );
}
