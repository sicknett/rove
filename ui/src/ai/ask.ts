// Search → Ask: a request in plain words, answered by the connected assistant and turned into
// real titles through TMDB. One ask runs at a time; a new one, Stop, or leaving the screen ends it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { docs } from '../lib/native';
import { hasTmdb } from '../meta/tmdb';
import { activeProfile, profileDoc } from '../state/profiles';
import { assistantFor, assistantSettings } from './index';
import { MAX_ASK_LENGTH } from './prompt';
import { resolveSuggestions, type AiCard } from './resolve';
import { AiError, isAbort, type AiErrorKind } from './types';

export type AskState =
  | { status: 'idle' }
  /** `finding`: the assistant has answered and its titles are being looked up on TMDB. */
  | { status: 'loading'; text: string; stage: 'asking' | 'finding' }
  /** `suggested` is how many the assistant named; the cards are the ones that exist. */
  | { status: 'done'; text: string; cards: AiCard[]; suggested: number }
  /** The assistant named nothing, or nothing it named is on TMDB. */
  | { status: 'empty'; text: string; why: 'none-suggested' | 'none-found' }
  | { status: 'error'; text: string; kind: AiErrorKind | 'tmdb-key' | 'tmdb'; message: string };

const RECENT_DOC = () => profileDoc('asks');
const RECENT_KEPT = 10;

const savedAsks = (doc: string) => docs.read<string[]>(doc).then((r) => (Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []));

export function useAsk() {
  const [state, setState] = useState<AskState>({ status: 'idle' });
  const [recent, setRecent] = useState<string[]>([]);
  const running = useRef<AbortController | null>(null);

  useEffect(() => {
    void savedAsks(RECENT_DOC())
      .then(setRecent)
      .catch(() => undefined);
    return () => running.current?.abort();
  }, []);

  const remember = (text: string) => {
    const doc = RECENT_DOC();
    // From the saved list, read now, as recent searches do: this copy may not have loaded yet,
    // and writing from it would wipe the list.
    void savedAsks(doc)
      .then((saved) => {
        const next = [text, ...saved.filter((r) => r.toLowerCase() !== text.toLowerCase())].slice(0, RECENT_KEPT);
        setRecent(next);
        return docs.write(doc, next);
      })
      .catch(() => undefined);
  };

  const submit = useCallback(async (input: string) => {
    const text = input.trim().slice(0, MAX_ASK_LENGTH);
    const settings = assistantSettings();
    if (!text || !settings) return;
    running.current?.abort();
    const run = new AbortController();
    running.current = run;
    const show = (next: AskState) => {
      if (running.current === run) setState(next);
    };
    try {
      // Checked first: without TMDB no answer could be shown, and the ask would be paid for nothing.
      if (!hasTmdb()) return show({ status: 'error', text, kind: 'tmdb-key', message: 'Ask looks every suggestion up on TMDB, and there is no TMDB key. Add one in Settings → Accounts.' });
      show({ status: 'loading', text, stage: 'asking' });
      const suggestions = await assistantFor(settings).suggest({ kind: 'ask', text, kids: !!activeProfile()?.kids }, run.signal);
      if (!suggestions.length) return show({ status: 'empty', text, why: 'none-suggested' });
      show({ status: 'loading', text, stage: 'finding' });
      const { cards, failed } = await resolveSuggestions(suggestions, run.signal);
      if (running.current !== run) return;
      if (!cards.length && failed) return show({ status: 'error', text, kind: 'tmdb', message: 'The assistant answered, but TMDB could not be reached to look its titles up.' });
      if (!cards.length) return show({ status: 'empty', text, why: 'none-found' });
      show({ status: 'done', text, cards, suggested: suggestions.length });
      remember(text);
    } catch (e) {
      // Stopped, or replaced by a newer ask: that one owns the screen now.
      if (isAbort(e) || run.signal.aborted) return;
      show({ status: 'error', text, kind: e instanceof AiError ? e.kind : 'network', message: e instanceof AiError ? e.message : 'The assistant could not be asked. Try again.' });
    } finally {
      if (running.current === run) running.current = null;
    }
  }, []);

  /** Stops the ask in flight and goes back to how the screen was before it. */
  const cancel = useCallback(() => {
    if (!running.current) return;
    running.current.abort();
    running.current = null;
    setState({ status: 'idle' });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
    void docs.write(RECENT_DOC(), []).catch(() => undefined);
  }, []);

  return { state, recent, submit, cancel, clearRecent };
}

export type Ask = ReturnType<typeof useAsk>;
