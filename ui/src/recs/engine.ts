// The rows made from a profile's own history: what each one shows right now.
//
// One place works all of them out, because they depend on each other: a title goes to the first
// row that has it (rank.ts assignRows), so a row cannot be settled alone. The components only
// say which rows are near the screen and read their row from `board`.
//
// What is kept per profile (the `recs` document): the taste profile (seeds and genre leanings),
// today's "Because you watched" titles, the titles marked Not interested, and the TMDB numbers
// looked up for history titles that had none. TMDB's answers are kept apart (cache.ts).

import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { isImdbId, titleKey } from '../addons/ids';
import { pool } from '../lib/http';
import { docs } from '../lib/native';
import { findByImdb, hasTmdb } from '../meta/tmdb';
import { useHistory } from '../state/history';
import { useHomeLayout } from '../state/homeLayout';
import { tmdbKeyId } from '../state/keys';
import { activeProfile, profileDoc, useProfiles } from '../state/profiles';
import { canonicalNow, onIdMapChange, rememberMapping, tmdbFor } from '../tracking/idmap';
import { loadCache, peekCache, putCache } from './cache';
import { assignRows, candidateKey, dayNumber, pickBecause, type Candidate, type RowFeed, type SeedRef } from './rank';
import { isoDay, recipeFor, type Recipe, type RecipeContext, type SavedSeed, type SavedTaste } from './recipes';
import { kidSafe, seedSource, type SeedBundle, type SourceSpec } from './sources';
import { buildTaste, genreAffinities, kindOf, knownTitles, refKey, topLanguages, typeOf, type Kind, type KnownTitles, type TasteSignal } from './taste';

const HOUR = 3600 * 1000;
/** The taste profile is worked out again after this long, or sooner when the seeds are different titles. */
export const TASTE_TTL = 6 * HOUR;
/** After a refresh that TMDB did not answer, Home waits this long before it asks again by itself. */
const RETRY_AFTER_FAILURE = 10 * 60 * 1000;
/** History titles without a TMDB number that are looked up per visit, newest first. Each is asked once, ever. */
export const LOOKUPS_PER_VISIT = 40;
const BECAUSE_ROWS = 3;

interface Hidden {
  at: number;
  name?: string;
}

export interface RecsDoc {
  version: 1;
  taste: SavedTaste | null;
  /** The day (rank.ts dayNumber) and its "Because you watched" titles, by row. */
  because: { day: number; picks: SeedRef[] } | null;
  /** Not interested, by TMDB title (`movie:603`). */
  hidden: Record<string, Hidden>;
  /** History key -> TMDB title (`tv:1396`) for history entries that carry no TMDB number; '' when TMDB has none. */
  tmdbOf: Record<string, string>;
}

const emptyDoc = (): RecsDoc => ({ version: 1, taste: null, because: null, hidden: {}, tmdbOf: {} });

/** A saved document with anything missing or malformed replaced by empty. */
function readDoc(v: unknown): RecsDoc {
  const d = v as Partial<RecsDoc> | null;
  if (!d || typeof d !== 'object') return emptyDoc();
  const obj = <T>(x: unknown): Record<string, T> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, T>) : {});
  const taste = d.taste && Array.isArray(d.taste.seeds) && Array.isArray(d.taste.genres) && typeof d.taste.at === 'number' ? { ...d.taste, languages: Array.isArray(d.taste.languages) ? d.taste.languages : [] } : null;
  const because = d.because && typeof d.because.day === 'number' && Array.isArray(d.because.picks) ? d.because : null;
  return { version: 1, taste, because, hidden: obj(d.hidden), tmdbOf: obj(d.tmdbOf) };
}

export interface BoardRow {
  /**
   * `pending`: loading, or waiting for the rows above it. `none`: the row has nothing to show
   * (its recipe does not apply, or it found too few titles). `error`: TMDB did not answer.
   */
  status: 'pending' | 'none' | 'error' | 'ready';
  items: Candidate[];
}

const NO_ROW: BoardRow = { status: 'none', items: [] };
const PENDING: BoardRow = { status: 'pending', items: [] };

interface RecsState {
  /** The profile everything here belongs to; null until its document has been read. */
  profileId: string | null;
  doc: RecsDoc;
  /** `loading` only while there is no profile to show yet: a later refresh keeps the rows that are there. */
  tasteStatus: 'idle' | 'loading' | 'failed';
  /** Row key -> what the row shows on Home. */
  board: Record<string, BoardRow>;
  /** Row key -> the row's whole list, for "See all" (only for rows that were opened). */
  full: Record<string, BoardRow>;
  load: (profileId: string) => Promise<void>;
  /** The query client the sources are fetched through (its cache is what makes a second visit free). */
  bind: (client: QueryClient) => void;
  /** A row came near the screen, or left Home. */
  setNear: (key: string, near: boolean) => void;
  /** "See all" for a row was opened, or closed. */
  setOpen: (key: string, open: boolean) => void;
  /** Home is on show: refresh what is due. Asks for nothing that is still fresh. */
  visit: () => void;
  retry: (key: string) => void;
  /** Not interested: the title leaves every row, now and from then on. */
  hide: (c: Pick<Candidate, 'kind' | 'id' | 'name'>) => void;
  unhide: (key: string) => void;
  clearHidden: () => void;
}

// ---------- What is not shown to components ----------

interface SourceState {
  status: 'loading' | 'ok' | 'error';
  data?: unknown;
  /** When `data` was fetched. */
  at?: number;
  failedAt?: number;
}

let client: QueryClient | null = null;
const sources = new Map<string, SourceState>();
const inflight = new Map<string, Promise<unknown>>();
const near = new Set<string>();
const open = new Set<string>();
/** The rows switched on in Home layout, top to bottom. */
let order: string[] = [];
let known: KnownTitles = { keys: new Set(), tmdb: new Set(), unnumbered: [] };
/** TMDB titles the lookups matched to history titles that carry no number. */
let looked = new Set<string>();
let refreshing: Promise<void> | null = null;
let lookingUp = false;
let tasteFailedAt = 0;
let lookupFailedAt = 0;
let queued = false;
let subscribed = false;
let loadSeq = 0;
let lastVisit = 0;
/** Calls to `visit` closer together than this are the same look at Home. */
const VISIT_GAP = 1500;

const current = (profileId: string | null) => !!profileId && useRecs.getState().profileId === profileId && useProfiles.getState().activeId === profileId;

function save() {
  const { profileId, doc } = useRecs.getState();
  if (!profileId) return;
  docs.write(profileDoc('recs', profileId), doc).catch((e) => console.error('recommendations: not saved', e));
}

function setDoc(patch: Partial<RecsDoc>) {
  useRecs.setState({ doc: { ...useRecs.getState().doc, ...patch } });
  save();
}

export function recipeContext(): RecipeContext {
  const { doc } = useRecs.getState();
  return { taste: doc.taste, because: doc.because?.picks ?? [], kids: !!activeProfile()?.kids, today: isoDay(Date.now()) };
}

function rebuildKnown() {
  const h = useHistory.getState();
  known = knownTitles(h);
  const { tmdbOf } = useRecs.getState().doc;
  looked = new Set(known.unnumbered.map((u) => tmdbOf[u.key]).filter((ref): ref is string => !!ref));
}

function rebuildOrder() {
  order = [...useHomeLayout.getState().items]
    .filter((i) => i.enabled && !!recipeFor(i.key))
    .sort((a, b) => a.order - b.order)
    .map((i) => i.key);
}

/** Whether a title may be shown: not seen, started, listed or dismissed, and fit for the profile. */
function shows(c: Candidate, hidden: Record<string, Hidden>, kids: boolean): boolean {
  const key = candidateKey(c);
  if (hidden[key] || known.tmdb.has(key) || looked.has(key)) return false;
  // A history entry under the IMDb id, for a title whose mapping the id map has learned.
  const type = typeOf(c.kind);
  if (known.keys.has(titleKey(canonicalNow(`tmdb:${c.id}`, type), type))) return false;
  return !kids || kidSafe(c);
}

/**
 * The rows that have to be loaded: every row near the screen, every row above the lowest of
 * them (the rows above choose their titles first), and the charts, wherever they are, as soon as
 * any other row is wanted (what a chart shows is kept out of the other rows).
 */
function neededRows(): string[] {
  let lowest = -1;
  order.forEach((key, i) => {
    if (near.has(key) && !recipeFor(key)?.chart) lowest = i;
  });
  return order.filter((key, i) => near.has(key) || i < lowest || (lowest >= 0 && !!recipeFor(key)?.chart));
}

const sameRow = (a: BoardRow | undefined, b: BoardRow) => !!a && a.status === b.status && a.items.length === b.items.length && a.items.every((c, i) => c === b.items[i] || (c.id === b.items[i].id && c.kind === b.items[i].kind));

/** The first taste profile is on its way, and this recipe is made from it: nothing to show or ask for yet. */
const awaitsTaste = (recipe: Recipe, ctx: RecipeContext, tasteLoading: boolean) => tasteLoading && !ctx.taste && (recipe.personal || !!recipe.usesTaste);

/** A recipe's list from what has loaded: `pending` while anything it needs is still on its way. */
function feedOf(key: string, ctx: RecipeContext, wide: boolean, tasteLoading: boolean, hidden: Record<string, Hidden>): Candidate[] | 'pending' | 'none' | 'error' {
  const recipe = recipeFor(key);
  if (!recipe) return 'none';
  if (awaitsTaste(recipe, ctx, tasteLoading)) return 'pending';
  const specs = recipe.plan(ctx, wide);
  if (!specs) return 'none';
  const states = specs.map((s) => sources.get(s.key));
  if (states.some((s) => !s || (s.status === 'loading' && s.data === undefined))) return 'pending';
  if (states.length && states.every((s) => s!.status === 'error')) return 'error';
  return recipe.build(ctx, states.map((s) => s!.data), wide).filter((c) => shows(c, hidden, ctx.kids));
}

function recompute() {
  queued = false;
  const state = useRecs.getState();
  if (!state.profileId) return;
  const ctx = recipeContext();
  const tasteLoading = state.tasteStatus === 'loading';
  const hidden = state.doc.hidden;
  const feeds: RowFeed[] = order.map((key) => {
    const recipe = recipeFor(key)!;
    return { key, items: feedOf(key, ctx, false, tasteLoading, hidden), limit: recipe.limit, min: recipe.min, chart: recipe.chart };
  });
  const assigned = assignRows(feeds);
  const board: Record<string, BoardRow> = {};
  let changed = Object.keys(state.board).length !== order.length;
  for (const key of order) {
    const r = assigned.get(key)!;
    const row: BoardRow = r.status === 'ready' ? { status: 'ready', items: r.items } : r.status === 'none' ? NO_ROW : r.status === 'pending' ? PENDING : { status: 'error', items: [] };
    // The same row object while it shows the same titles: its cards do not render again.
    board[key] = sameRow(state.board[key], row) ? state.board[key] : row;
    if (board[key] !== state.board[key]) changed = true;
  }
  const full: Record<string, BoardRow> = {};
  let fullChanged = Object.keys(state.full).length !== open.size;
  for (const key of open) {
    const items = feedOf(key, ctx, true, tasteLoading, hidden);
    const row: BoardRow = Array.isArray(items) ? { status: 'ready', items } : items === 'none' ? NO_ROW : items === 'pending' ? PENDING : { status: 'error', items: [] };
    full[key] = sameRow(state.full[key], row) ? state.full[key] : row;
    if (full[key] !== state.full[key]) fullChanged = true;
  }
  if (changed || fullChanged) useRecs.setState({ board: changed ? board : state.board, full: fullChanged ? full : state.full });
}

/** Many things change at once (25 answers, 40 learned ids): the board is worked out once for all of them. */
function queueRecompute() {
  if (queued) return;
  queued = true;
  queueMicrotask(recompute);
}

/**
 * A source's answer: the one already here while it is fresh, else fetched. A fetch goes through
 * the query client (which holds it for its stale time) and lands in the saved cache. An answer
 * that could not be refreshed stays on show.
 */
function ensureSource<T>(spec: SourceSpec<T>): Promise<T> {
  const running = inflight.get(spec.key);
  if (running) return running as Promise<T>;
  const now = Date.now();
  let state = sources.get(spec.key);
  if (!state) {
    const saved = peekCache(spec.key);
    state = saved ? { status: 'ok', data: saved.value, at: saved.at } : { status: 'loading' };
    sources.set(spec.key, state);
  }
  const fresh = state.status === 'ok' && state.at !== undefined && now >= state.at && now - state.at < spec.ttlMs;
  if (fresh) return Promise.resolve(state.data as T);
  // It has an answer, the refresh of it just failed: not again on every look at Home.
  if (state.data !== undefined && state.failedAt && now - state.failedAt < RETRY_AFTER_FAILURE) return Promise.resolve(state.data as T);
  if (state.status === 'error') sources.set(spec.key, { status: 'loading' });
  const fetched = client ? client.fetchQuery({ queryKey: ['recs', spec.key, tmdbKeyId()], queryFn: spec.fetch, staleTime: spec.ttlMs, gcTime: 24 * HOUR }) : spec.fetch();
  const p = fetched
    .then((data) => {
      sources.set(spec.key, { status: 'ok', data, at: Date.now() });
      putCache(spec.key, data);
      return data;
    })
    .catch((e) => {
      const prev = sources.get(spec.key);
      sources.set(spec.key, prev?.data !== undefined ? { ...prev, status: 'ok', failedAt: Date.now() } : { status: 'error', failedAt: Date.now() });
      throw e;
    })
    .finally(() => {
      inflight.delete(spec.key);
      queueRecompute();
    });
  inflight.set(spec.key, p);
  return p;
}

/** Asks for what the rows near the screen (and the lists that are open) need. */
function plan() {
  if (!useRecs.getState().profileId || !hasTmdb()) return;
  const ctx = recipeContext();
  const tasteLoading = useRecs.getState().tasteStatus === 'loading';
  const wanted: SourceSpec[] = [];
  const want = (key: string, wide: boolean) => {
    const recipe = recipeFor(key);
    if (recipe && !awaitsTaste(recipe, ctx, tasteLoading)) wanted.push(...(recipe.plan(ctx, wide) ?? []));
  };
  for (const key of neededRows()) want(key, false);
  for (const key of open) want(key, true);
  for (const spec of wanted) void ensureSource(spec).catch(() => undefined);
  queueRecompute();
}

const parseRef = (ref: string | undefined): { kind: Kind; id: number } | null => {
  const m = /^(movie|tv):(\d+)$/.exec(ref ?? '');
  return m ? { kind: m[1] as Kind, id: Number(m[2]) } : null;
};

/**
 * The TMDB title for a history title: a ref, null when TMDB has none, undefined when it could
 * not be asked. Whatever is found is also told to the id map, so cards and history line up.
 */
async function lookUp(metaId: string, type: 'movie' | 'series'): Promise<{ kind: Kind; id: number } | null | undefined> {
  // The id map first: it may know already, and it asks PublicMetaDB for ids TMDB cannot look up.
  const mapped = await tmdbFor(metaId, type).catch(() => null);
  if (mapped) return mapped;
  if (!isImdbId(metaId)) return undefined;
  try {
    // The id map does not say whether it found nothing or could not ask. This does (and is answered from memory if the map just asked).
    const found = await findByImdb(metaId);
    if (found) rememberMapping(metaId, found);
    return found;
  } catch {
    return undefined;
  }
}

/**
 * History titles that carry no TMDB number are looked up, so a recommendation can be recognised
 * as already watched. Newest first, a bounded number per visit, each remembered for good.
 */
async function lookUpUnnumbered() {
  const profileId = useRecs.getState().profileId;
  if (lookingUp || !profileId || !hasTmdb()) return;
  if (lookupFailedAt && Date.now() - lookupFailedAt < RETRY_AFTER_FAILURE) return;
  const asked = useRecs.getState().doc.tmdbOf;
  const todo = known.unnumbered.filter((u) => isImdbId(u.metaId) && !(u.key in asked)).slice(0, LOOKUPS_PER_VISIT);
  if (!todo.length) return;
  lookingUp = true;
  try {
    const found = await pool(todo, 4, async (u) => ({ u, ref: await lookUp(u.metaId, u.type) }));
    if (!current(profileId)) return;
    const learned: Record<string, string> = {};
    for (const { u, ref } of found) if (ref !== undefined) learned[u.key] = ref ? refKey(ref.kind, ref.id) : '';
    if (found.some((f) => f.ref === undefined)) lookupFailedAt = Date.now();
    if (!Object.keys(learned).length) return;
    setDoc({ tmdbOf: { ...useRecs.getState().doc.tmdbOf, ...learned } });
    rebuildKnown();
    queueRecompute();
  } finally {
    lookingUp = false;
  }
}

/** Today's "Because you watched" titles: chosen once a day, then only added to. */
function ensureBecause(now = Date.now()) {
  const { doc } = useRecs.getState();
  if (!doc.taste) return;
  const day = dayNumber(now);
  const kept = doc.because?.day === day ? doc.because.picks : [];
  const picks = pickBecause(
    doc.taste.seeds.filter((s) => !!s.name),
    day,
    BECAUSE_ROWS,
    kept,
  );
  if (doc.because?.day === day && picks.length === kept.length) return;
  setDoc({ because: { day, picks } });
}

/**
 * Works the taste profile out again when it is due: none saved yet, older than its lifetime, or
 * the history's strongest titles are no longer the ones it was made from. One request per seed
 * (answered from the cache for seeds that were there before).
 */
function refreshTaste(): Promise<void> {
  if (refreshing) return refreshing;
  const profileId = useRecs.getState().profileId;
  const history = useHistory.getState();
  if (!profileId || !history.loaded || !hasTmdb()) return Promise.resolve();
  const now = Date.now();
  const base = buildTaste(history, now);
  const saved = useRecs.getState().doc.taste;
  const candidates = [...base.seeds.movies, ...base.seeds.shows];
  if (!candidates.length) {
    // Nothing to go on (any more): no personal rows.
    if (saved) setDoc({ taste: null, because: null });
    if (useRecs.getState().tasteStatus !== 'idle') useRecs.setState({ tasteStatus: 'idle' });
    queueRecompute();
    return Promise.resolve();
  }
  // A clock set back makes the saved profile look newer than now: that counts as old.
  const fresh = !!saved && now >= saved.at && now - saved.at < TASTE_TTL && saved.fingerprint === base.fingerprint;
  if (fresh) return Promise.resolve();
  if (tasteFailedAt && now - tasteFailedAt < RETRY_AFTER_FAILURE) return Promise.resolve();
  if (!saved) useRecs.setState({ tasteStatus: 'loading' });

  refreshing = (async () => {
    const numbered = await pool(candidates, 4, async (s: TasteSignal) => {
      if (s.tmdbId) return { s, ref: { kind: kindOf(s.type), id: s.tmdbId } };
      const asked = parseRef(useRecs.getState().doc.tmdbOf[s.key]);
      return { s, ref: asked ?? (await lookUp(s.metaId, s.type)) ?? null };
    });
    const withRef = numbered.filter((x): x is { s: TasteSignal; ref: { kind: Kind; id: number } } => !!x.ref);
    let failed = 0;
    const answered = await pool(withRef, 4, async ({ s, ref }) => {
      const bundle = await ensureSource(seedSource(ref.kind, ref.id)).catch(() => (failed++, null));
      return { s, ref, bundle: bundle as SeedBundle | null };
    });
    if (!current(profileId)) return;
    if (withRef.length > 0 && failed === withRef.length) {
      // TMDB did not answer at all: what was saved stays, and Home asks again later.
      tasteFailedAt = Date.now();
      useRecs.setState({ tasteStatus: saved ? 'idle' : 'failed' });
      return;
    }
    const seeds: SavedSeed[] = answered.map(({ s, ref, bundle }) => ({ key: s.key, kind: ref.kind, id: ref.id, name: s.name ?? bundle?.name, weight: s.weight, depth: s.depth, at: s.at, watched: s.watched }));
    const answers = answered.filter((a) => !!a.bundle);
    const genres = genreAffinities(answers.map((a) => ({ kind: a.ref.kind, weight: a.s.weight, genres: a.bundle!.genres })));
    const languages = topLanguages(answers.map((a) => ({ weight: a.s.weight, language: a.bundle!.language })));
    tasteFailedAt = 0;
    useRecs.setState({ tasteStatus: 'idle' });
    setDoc({ taste: { at: Date.now(), fingerprint: base.fingerprint, seeds, genres, languages } });
    ensureBecause();
  })()
    .catch((e) => {
      console.error('recommendations: taste profile not refreshed', e);
      tasteFailedAt = Date.now();
      if (current(profileId)) useRecs.setState({ tasteStatus: useRecs.getState().doc.taste ? 'idle' : 'failed' });
    })
    .finally(() => {
      refreshing = null;
      // Whatever came of it, the rows that waited for the profile are asked for now.
      plan();
    });
  return refreshing;
}

/** History, the Home layout and the id map all change what the rows show. Listened to once. */
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  useHistory.subscribe((s, prev) => {
    // Positions are saved every few seconds while something plays. Only a title coming or going matters here.
    if (s.watched === prev.watched && s.library === prev.library && (s.progress === prev.progress || Object.keys(s.progress).length === Object.keys(prev.progress).length)) return;
    rebuildKnown();
    queueRecompute();
  });
  useHomeLayout.subscribe((s, prev) => {
    if (s.items === prev.items) return;
    rebuildOrder();
    plan();
  });
  onIdMapChange(queueRecompute);
}

export const useRecs = create<RecsState>((set, get) => ({
  profileId: null,
  doc: emptyDoc(),
  tasteStatus: 'idle',
  board: {},
  full: {},

  async load(profileId) {
    if (get().profileId === profileId) return;
    const seq = ++loadSeq;
    set({ profileId: null, doc: emptyDoc(), tasteStatus: 'idle', board: {}, full: {} });
    sources.clear();
    tasteFailedAt = 0;
    lookupFailedAt = 0;
    lastVisit = 0;
    const [stored] = await Promise.all([docs.read(profileDoc('recs', profileId)).catch(() => null), loadCache(profileId)]);
    // Another profile was picked while this one was being read.
    if (seq !== loadSeq || useProfiles.getState().activeId !== profileId) return;
    subscribe();
    const doc = readDoc(stored);
    // A history with something to go on and no profile yet: the personal rows are on their way, not absent.
    const history = useHistory.getState();
    const waiting = !doc.taste && hasTmdb() && history.loaded && buildTaste(history, Date.now()).fingerprint !== '';
    set({ profileId, doc, tasteStatus: waiting ? 'loading' : 'idle' });
    rebuildKnown();
    rebuildOrder();
    ensureBecause();
    recompute();
  },

  bind(c) {
    client = c;
  },

  setNear(key, isNear) {
    if (near.has(key) === isNear) return;
    if (isNear) near.add(key);
    else near.delete(key);
    plan();
  },

  setOpen(key, isOpen) {
    if (open.has(key) === isOpen) return;
    if (isOpen) open.add(key);
    else open.delete(key);
    plan();
  },

  visit() {
    const now = Date.now();
    // Every row on Home reports the same visit; it is one.
    if (!get().profileId || now - lastVisit < VISIT_GAP) return;
    lastVisit = now;
    void refreshTaste();
    // Nothing is on its way after all (no TMDB key, or it was asked moments ago and failed): the personal rows are absent, not loading.
    if (!refreshing && get().tasteStatus === 'loading') set({ tasteStatus: get().doc.taste ? 'idle' : 'failed' });
    void lookUpUnnumbered();
    ensureBecause();
    plan();
  },

  retry(key) {
    const recipe = recipeFor(key);
    if (!recipe) return;
    const specs = recipe.plan(recipeContext(), open.has(key)) ?? [];
    for (const spec of specs) {
      // Asked again now, whatever the wait after a failure says: the user asked.
      const state = sources.get(spec.key);
      if (state?.failedAt) sources.set(spec.key, { ...state, failedAt: undefined });
      void ensureSource(spec).catch(() => undefined);
    }
    queueRecompute();
  },

  hide(c) {
    setDoc({ hidden: { ...get().doc.hidden, [candidateKey(c)]: { at: Date.now(), name: c.name } } });
    recompute();
  },

  unhide(key) {
    const hidden = { ...get().doc.hidden };
    if (!(key in hidden)) return;
    delete hidden[key];
    setDoc({ hidden });
    recompute();
  },

  clearHidden() {
    if (!Object.keys(get().doc.hidden).length) return;
    setDoc({ hidden: {} });
    recompute();
  },
}));

/** For tests: back to nothing loaded, nothing fetched. */
export function resetRecs() {
  client = null;
  sources.clear();
  inflight.clear();
  near.clear();
  open.clear();
  order = [];
  known = { keys: new Set(), tmdb: new Set(), unnumbered: [] };
  looked = new Set();
  refreshing = null;
  lookingUp = false;
  tasteFailedAt = 0;
  lookupFailedAt = 0;
  queued = false;
  lastVisit = 0;
  loadSeq++;
  useRecs.setState({ profileId: null, doc: emptyDoc(), tasteStatus: 'idle', board: {}, full: {} });
}
