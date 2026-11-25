// Search: one box over everything that can be found. Before anything is typed it is a page to
// start from (Landing); as text is typed it becomes the results for that text (Results); with an
// AI assistant connected the same box can be switched to Ask.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search as SearchIcon, Sparkles, X } from 'lucide-react';
import { fetchMeta } from '../../addons/client';
import { assistantName, useAssistantSettings } from '../../ai';
import { useAsk } from '../../ai/ask';
import { AskResults } from '../../ai/AskResults';
import { docs } from '../../lib/native';
import { findByImdb } from '../../meta/tmdb';
import { navigate, useNav, useScreen } from '../../nav/router';
import { profileDoc, useProfiles } from '../../state/profiles';
import { Button, Segmented, Spinner } from '../../ui/controls';
import { arrowNav } from '../shared/keynav';
import { useTmdbKeyId } from '../shared/parts';
import { Landing } from './Landing';
import { addRecent, isSettled, latestOnly, MIN_QUERY, readQuery, removeRecent, tidy, type Sort } from './logic';
import { useSearchModel } from './model';
import { Results, ResultsSkeleton, ResultTabs, type Tab } from './Results';

/** How long the box rests before its text is searched for. Short enough to feel live, long enough that a word typed at speed is one search and not five. */
const SETTLE_MS = 250;
/** A search that stays on screen this long was worth remembering. Opening a result remembers it at once. */
const REMEMBER_MS = 2500;

const HISTORY_DOC = () => profileDoc('searches');

const savedSearches = (doc: string) => docs.read<string[]>(doc).then((r) => (Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []));

/**
 * Movie or show, for an IMDb id typed into Search. TMDB knows directly; without it, whichever
 * type a metadata addon answers for (a movie when that does not settle it).
 */
async function typeOfImdbId(id: string): Promise<'movie' | 'series'> {
  const known = await findByImdb(id).catch(() => null);
  if (known) return known.kind === 'tv' ? 'series' : 'movie';
  const [movie, series] = await Promise.all([fetchMeta('movie', id).catch(() => null), fetchMeta('series', id).catch(() => null)]);
  const types = [movie?.type, series?.type];
  return types.includes('series') && !types.includes('movie') ? 'series' : 'movie';
}

export function Search({ q: initial }: { q?: string }) {
  const screen = useScreen();
  const hasKey = !!useTmdbKeyId();
  const kids = useProfiles((s) => !!s.profiles.find((p) => p.id === s.activeId)?.kids);
  const [text, setText] = useState(initial ?? '');
  const [query, setQuery] = useState(tidy(initial ?? ''));
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<Sort>('relevance');
  const [recent, setRecent] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opens = useRef(latestOnly());
  // Ask: the same box, answered by the AI assistant connected in Settings → Accounts. Without one
  // there is no Ask. While asking, `query` stays empty, so nothing of normal search draws or loads.
  const assistant = useAssistantSettings();
  const [askMode, setAskMode] = useState(false);
  const asking = askMode && !!assistant;
  const askName = assistant ? assistantName(assistant) : '';
  const ask = useAsk();
  const askBusy = asking && ask.state.status === 'loading';

  /** Writes the query into this screen's own place in history, when that is the page on show. */
  const toRoute = (q: string) => {
    const nav = useNav.getState();
    if (nav.stack[nav.index].key === screen.key) nav.replace({ name: 'search', q: q || undefined });
  };

  const switchMode = (toAsk: boolean, keep = false) => {
    if (toAsk === asking) return;
    // What was typed for one is not meant for the other: a sentence is no search, a name no
    // request. Unless the search found nothing and the same words are handed to Ask (`keep`).
    setAskMode(toAsk);
    if (!keep) setText('');
    setQuery('');
    toRoute('');
    input.current?.focus();
  };

  useEffect(() => {
    void savedSearches(HISTORY_DOC())
      .then(setRecent)
      .catch(() => undefined);
  }, []);

  // The box takes the keyboard whenever Search comes on show (first time, or back from another
  // tab), and on Ctrl+K or "/" while it already is.
  useEffect(() => {
    if (!screen.active) return;
    const focus = () => (input.current?.focus(), input.current?.select());
    input.current?.focus();
    window.addEventListener('rove:focus-search', focus);
    return () => window.removeEventListener('rove:focus-search', focus);
  }, [screen.active]);

  const settle = (q: string) => {
    setQuery(q);
    toRoute(q);
  };

  useEffect(() => {
    // Only while this screen is the one on show. `replace` rewrites whichever page is current,
    // so a timer that outlived a click on a result would turn that title's page into Search.
    // And not while asking: the assistant is asked on Enter, never as the text changes.
    if (!screen.active || asking) return;
    const q = tidy(text);
    // Emptied: back to the start page at once, there is nothing to wait for.
    if (!q) return settle('');
    const t = window.setTimeout(() => settle(q), SETTLE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, screen.active, screen.key, asking]);

  const typed = tidy(text);
  const read = useMemo(() => readQuery(query, new Date().getFullYear()), [query]);
  const settled = isSettled(text, query);
  const searching = !asking && query.length >= MIN_QUERY && settled;
  const model = useSearchModel(read, screen.active && searching, { kids });
  // An id is not a search to come back to: it is pasted, opened and done with.
  const found = searching && !read.id && !model.loading && !model.empty;
  // People are not offered without TMDB or to a Kids profile, and an id has no kinds to choose between.
  const people = hasKey && !kids;
  const shownTab: Tab = read.id || (tab === 'people' && !people) ? 'all' : tab;

  // A search is remembered once it has found something and either stayed on screen a moment or
  // been left for one of its results.
  useEffect(() => {
    if (!found) return;
    const doc = HISTORY_DOC();
    const remember = () => {
      // From the saved list, read now: this screen can start with a query before its own copy has
      // loaded (it is empty then), and writing from that copy would wipe the list.
      void savedSearches(doc)
        .then((saved) => {
          if (saved[0] === query) return;
          const next = addRecent(saved, query);
          setRecent(next);
          return docs.write(doc, next);
        })
        .catch(() => undefined);
    };
    if (!screen.active) return remember();
    const t = window.setTimeout(remember, REMEMBER_MS);
    return () => window.clearTimeout(t);
  }, [found, query, screen.active]);

  const changeRecent = (next: string[]) => {
    setRecent(next);
    void docs.write(HISTORY_DOC(), next).catch(() => undefined);
  };

  const openImdb = async (id: string) => {
    // Typing on while the id is looked up must not end with its page opening over the new search.
    const current = opens.current.start();
    setOpening(true);
    try {
      const type = await typeOfImdbId(id);
      if (current() && useNav.getState().stack[useNav.getState().index].key === screen.key) navigate({ name: 'title', type, id });
    } finally {
      if (current()) setOpening(false);
    }
  };

  const clear = () => {
    opens.current.cancel();
    setOpening(false);
    setText('');
    setTab('all');
  };

  const onEnter = () => {
    if (asking) return void ask.submit(text);
    if (typed.length < MIN_QUERY) return;
    // Not searched yet: Enter does not wait for the pause.
    if (!settled) return settle(typed);
    if (read.id?.startsWith('tt')) return void openImdb(read.id);
    // Searched and answered: Enter opens the best match.
    const top = model.top;
    if (top?.kind === 'title') navigate({ name: 'title', type: top.hit.type, id: `tmdb:${top.hit.tmdbId}` });
    else if (top) navigate({ name: 'person', id: top.person.id, label: top.person.name });
  };

  const landing = !asking && typed.length < MIN_QUERY;

  return (
    <div className="screen-pad search" onKeyDown={(e) => arrowNav(e, input.current)}>
      <div className="search-field">
        {asking ? <Sparkles size={22} className="search-field__icon" /> : <SearchIcon size={22} className="search-field__icon" />}
        <input
          ref={input}
          className="search-field__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={asking ? `Ask ${askName} what to watch, in your own words` : hasKey ? 'Movies, shows and people, or an IMDb id' : 'Movies and shows, or an IMDb id'}
          spellCheck={asking}
          aria-label={asking ? `Ask ${askName}` : 'Search'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter();
            else if (e.key === 'Escape') {
              // First what was typed goes; with the box already empty the keyboard leaves it, so
              // the app's own keys (Backspace to go back) work again.
              if (text) clear();
              else input.current?.blur();
            }
          }}
        />
        {((searching && model.loading) || askBusy || opening) && <Spinner size={20} />}
        {text ? (
          <button className="ibtn ibtn--sm" aria-label="Clear" onClick={() => (clear(), input.current?.focus())}>
            <X size={18} />
          </button>
        ) : (
          <kbd className="search-field__key" aria-hidden>
            Ctrl K
          </kbd>
        )}
        {asking &&
          (askBusy ? (
            <Button variant="secondary" size="sm" onClick={ask.cancel}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon={<ArrowRight size={16} />} disabled={!text.trim()} aria-label={`Ask ${askName}`} title="Ask (Enter)" onClick={() => void ask.submit(text)} />
          ))}
        {assistant && (
          <Segmented
            label="Search or ask"
            value={asking ? 'ask' : 'search'}
            onChange={(v) => switchMode(v === 'ask')}
            options={[
              { value: 'search', label: 'Search' },
              { value: 'ask', label: 'Ask' },
            ]}
          />
        )}
      </div>

      {asking && <AskResults ask={ask} assistant={askName} onPick={(t) => (setText(t), void ask.submit(t))} />}

      {landing && (
        <>
          {typed.length === 1 && <p className="s-empty">Search starts at two letters.</p>}
          <Landing
            active={screen.active && landing}
            hasKey={hasKey}
            canSearch={hasKey || model.hasTargets}
            kids={kids}
            recent={recent}
            onPick={(r) => (setText(r), input.current?.focus())}
            onRemove={(r) => changeRecent(removeRecent(recent, r))}
            onClear={() => changeRecent([])}
          />
        </>
      )}

      {!asking && !landing && (
        <>
          {/* An id is opened, not sifted: there are no kinds of result to choose between. */}
          {!(settled && read.id) && <ResultTabs tab={shownTab} onTab={setTab} sort={sort} onSort={setSort} people={people} />}

          {settled &&
            read.id &&
            (read.id.startsWith('tt') ? (
              <button data-nav className="id-jump" disabled={opening} onClick={() => void openImdb(read.id!)}>
                {opening ? `Opening ${read.id}…` : `Open ${read.id} directly`}
              </button>
            ) : (
              // A TMDB number can be a movie and a show at once: the user says which.
              <div className="chips">
                <button data-nav className="id-jump" onClick={() => navigate({ name: 'title', type: 'movie', id: read.id! })}>
                  Open {read.id} as a movie
                </button>
                <button data-nav className="id-jump" onClick={() => navigate({ name: 'title', type: 'series', id: read.id! })}>
                  Open {read.id} as a show
                </button>
              </div>
            ))}

          {!settled ? (
            // The box holds newer text than the results answer: they are not shown under it.
            <ResultsSkeleton featured={hasKey && shownTab === 'all'} />
          ) : read.id && (model.loading || model.empty) ? null : (
            <Results model={model} tab={shownTab} onTab={setTab} sort={sort} active={screen.active} assistant={assistant ? askName : undefined} onAsk={() => switchMode(true, true)} />
          )}
        </>
      )}
    </div>
  );
}
