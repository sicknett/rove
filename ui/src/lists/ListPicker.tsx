// Choosing lists from a provider: its own sections (yours, popular, a search, a pasted link) as
// tabs over one list of tickable rows. Used by the Import lists dialog and by a folder's
// "add a source". What is ticked is kept by the caller, so it survives a change of tab.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Search as SearchIcon } from 'lucide-react';
import { tmdbKeyId, useKeys } from '../state/keys';
import { mdblistValidate } from '../tracking/adapters/mdblist';
import { Button, Dialog, Skeleton, TextField } from '../ui/controls';
import { toast } from '../ui/toast';
import { findListByLink, LIST_PROVIDER_NAMES, listSections, loadLists, mdblistKey, useListProviders, type ListProviderStatus, type ListSetup } from './providers';
import type { ListChoice, ListProviderId } from './types';

export type Picked = ReadonlyMap<string, ListChoice>;

/** Ticks or unticks one choice. */
export function toggled(picked: Picked, c: ListChoice): Map<string, ListChoice> {
  const next = new Map(picked);
  if (!next.delete(c.key)) next.set(c.key, c);
  return next;
}

function ListRows({ lists, picked, onToggle, taken }: { lists: ListChoice[]; picked: Picked; onToggle: (c: ListChoice) => void; taken?: (c: ListChoice) => string | undefined }) {
  return (
    <ul className="pick-list">
      {lists.map((c) => {
        const on = picked.has(c.key);
        const already = taken?.(c);
        return (
          <li key={c.key}>
            <button type="button" role="checkbox" aria-checked={on} disabled={!!already} className={`pick-row ${on ? 'is-on' : ''}`} onClick={() => onToggle(c)}>
              <span className="pick-row__tick" aria-hidden>
                {(on || already) && <Check size={14} strokeWidth={3} />}
              </span>
              <span className="pick-row__text">
                <span className="pick-row__title">{c.title}</span>
                {(already || c.detail) && <span className="pick-row__detail">{already ?? c.detail}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function LoadingRows() {
  return (
    <ul className="pick-list" aria-label="Loading lists">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="pick-row pick-row--loading">
          <Skeleton className="pick-row__tick" />
          <Skeleton className="pick-row__bar" style={{ width: `${46 - i * 4}%` }} />
        </li>
      ))}
    </ul>
  );
}

/** A reason a provider's answer did not arrive, in the provider's own words when it gave any. */
const failureText = (e: unknown, name: string) => (e instanceof Error && e.message ? e.message : `${name} did not answer.`);

interface BrowserProps {
  provider: ListProviderId;
  setup: ListSetup;
  picked: Picked;
  onToggle: (c: ListChoice) => void;
  /** Lists that are already where these would go: a few words saying so, and the row cannot be ticked. */
  taken?: (c: ListChoice) => string | undefined;
}

/** The sections of one provider that is ready, and the lists of the one that is open. */
export function ListBrowser({ provider, setup, picked, onToggle, taken }: BrowserProps) {
  const sections = listSections(provider, setup);
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [finding, setFinding] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [found, setFound] = useState<ListChoice[]>([]);
  const name = LIST_PROVIDER_NAMES[provider];

  // A search waits for a pause in the typing.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  // Whose lists these are is part of the key: another account's are never shown for this one.
  const who = provider === 'trakt' ? setup.tracker?.username ?? '' : provider === 'mdblist' ? tmdbKeyId(mdblistKey()) : '';
  const searching = section?.kind === 'search';
  const q = useQuery({
    queryKey: ['lists', provider, section?.id, searching ? query : '', who],
    queryFn: () => loadLists(provider, section!.id, searching ? query : ''),
    enabled: !!section && section.kind !== 'link' && (!searching || query.length >= 2),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const find = async () => {
    if (!link.trim() || finding) return;
    setFinding(true);
    setLinkError(null);
    try {
      const c = await findListByLink(provider, link);
      setFound((prev) => [c, ...prev.filter((x) => x.key !== c.key)]);
      if (!picked.has(c.key) && !taken?.(c)) onToggle(c);
      setLink('');
    } catch (e) {
      setLinkError(failureText(e, name));
    } finally {
      setFinding(false);
    }
  };

  if (!section) return null;
  return (
    <div className="pick">
      {sections.length > 1 && (
        <div className="chips pick__tabs" role="tablist" aria-label={`${name} lists`}>
          {sections.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === section.id} className={`chip chip--sm ${s.id === section.id ? 'is-on' : ''}`} onClick={() => setSectionId(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {section.kind === 'search' && <TextField value={text} onChange={setText} placeholder={section.placeholder} aria-label={section.placeholder} trailing={<SearchIcon size={16} className="field__icon" />} />}
      {section.kind === 'link' && (
        <div className="inline-form">
          <TextField value={link} onChange={(v) => (setLink(v), setLinkError(null))} placeholder={section.placeholder} aria-label="List link" error={linkError} onKeyDown={(e) => e.key === 'Enter' && void find()} />
          <Button variant="secondary" busy={finding} disabled={!link.trim()} onClick={() => void find()}>
            Find list
          </Button>
        </div>
      )}
      <div className="pick__body">
        {section.kind === 'link' ? (
          found.length ? (
            <ListRows lists={found} picked={picked} onToggle={onToggle} taken={taken} />
          ) : (
            <p className="pick__note">Paste the address of a list from your browser. It is added to what you have chosen.</p>
          )
        ) : searching && query.length < 2 ? (
          <p className="pick__note">Type at least two letters of a list’s name.</p>
        ) : q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <p className="pick__note">
            {failureText(q.error, name)}
            <button type="button" className="row__more" onClick={() => void q.refetch()}>
              Try again
            </button>
          </p>
        ) : !q.data?.length ? (
          <p className="pick__note">{searching ? `No ${name} list is named like that.` : section.empty}</p>
        ) : (
          <ListRows lists={q.data} picked={picked} onToggle={onToggle} taken={taken} />
        )}
      </div>
    </div>
  );
}

/** Saves an MDBList key for lists, once MDBList has accepted it. */
function MdblistKeyForm() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const value = key.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await mdblistValidate(value)) {
        await useKeys.getState().setMdblistApiKey(value);
        toast.success('MDBList key saved');
      } else setError('MDBList did not accept that key.');
    } catch {
      setError('MDBList could not be reached. The key was not saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-form">
      <TextField secret value={key} onChange={(v) => (setKey(v), setError(null))} placeholder="MDBList API key" aria-label="MDBList API key" error={error} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      <Button variant="primary" busy={busy} disabled={!key.trim()} onClick={() => void save()}>
        Save key
      </Button>
    </div>
  );
}

const SETTINGS_NAMES = { accounts: 'Accounts', servers: 'Media servers' } as const;

/**
 * What a provider that cannot be used is missing, with the way to put it right: the MDBList key
 * is entered here; the rest is done in Settings, which `onSettings` opens (left out where leaving
 * would throw away unsaved work, and then the sentence alone says where to go).
 */
export function ProviderMissing({ status, onSettings }: { status: ListProviderStatus; onSettings?: (section: 'accounts' | 'servers') => void }) {
  return (
    <div className="pick__missing">
      <p className="pick__missing-title">{status.missing}</p>
      {status.hint && <p className="pick__note">{status.hint}</p>}
      {status.id === 'mdblist' && <MdblistKeyForm />}
      {status.section && onSettings && (
        <div>
          <Button variant={status.id === 'mdblist' ? 'ghost' : 'secondary'} size="sm" onClick={() => onSettings(status.section!)}>
            Open Settings → {SETTINGS_NAMES[status.section]}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The line under a ready provider's lists: who is signed in, or which key is used (with a way to drop a saved one). */
export function ProviderNote({ status, setup, onSettings }: { status: ListProviderStatus; setup: ListSetup; onSettings?: (section: 'accounts' | 'servers') => void }) {
  if (!status.hint) return null;
  const savedKeyInUse = status.id === 'mdblist' && setup.tracker?.provider !== 'mdblist' && !!setup.savedMdblistKey;
  return (
    <p className="pick__note pick__note--foot">
      {status.hint}
      {savedKeyInUse && (
        <button type="button" className="row__more" onClick={() => void useKeys.getState().setMdblistApiKey(null)}>
          Remove key
        </button>
      )}
      {status.section && onSettings && !savedKeyInUse && (
        <button type="button" className="row__more" onClick={() => onSettings(status.section!)}>
          Open {SETTINGS_NAMES[status.section]}
        </button>
      )}
    </p>
  );
}

/**
 * Picks lists from one provider, for a folder's sources. It opens over the folder editor, whose
 * unsaved changes a trip to Settings would lose, so nothing here leaves the page.
 */
export function ListPickerDialog({ provider, onAdd, onClose, has }: { provider: ListProviderId; onAdd: (lists: ListChoice[]) => void; onClose: () => void; has: (key: string) => boolean }) {
  const { setup, providers } = useListProviders();
  const status = providers.find((p) => p.id === provider)!;
  const [picked, setPicked] = useState<Picked>(new Map());
  const title = provider === 'server' ? 'Add a server list' : provider === 'mdblist' ? 'Add an MDBList list' : 'Add a Trakt list';
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      width={560}
      footer={
        <>
          <span className="dialog__count">{picked.size ? `${picked.size} chosen` : ''}</span>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked.size} onClick={() => (onAdd([...picked.values()]), onClose())}>
            {picked.size > 1 ? `Add ${picked.size} lists` : 'Add list'}
          </Button>
        </>
      }
    >
      {status.ready ? (
        <>
          <ListBrowser provider={provider} setup={setup} picked={picked} onToggle={(c) => setPicked((p) => toggled(p, c))} taken={(c) => (has(c.key) ? 'Already in this folder' : undefined)} />
          <ProviderNote status={status} setup={setup} />
        </>
      ) : (
        <ProviderMissing status={status} />
      )}
    </Dialog>
  );
}
