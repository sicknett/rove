// What Search shows in Ask mode, under the box: ways to start, the wait, the picks, or what went
// wrong and what to do about it.

import { Clock, Sparkles } from 'lucide-react';
import { PosterCard } from '../media/cards';
import { navigate } from '../nav/router';
import { Button, Empty, Skeleton, Spinner } from '../ui/controls';
import type { Ask, AskState } from './ask';

const EXAMPLES = ['90s heist movies with a twist', 'Something like Severance but funnier', 'What should I watch tonight, under 2 hours', 'Slow-burn sci-fi series with a real ending'];

/** Errors the user fixes in Settings → Accounts (the key, the model, the account) and not by asking again. */
const IN_ACCOUNTS = new Set<Extract<AskState, { status: 'error' }>['kind']>(['auth', 'billing', 'model', 'tmdb-key']);

const ERROR_TITLE: Record<Extract<AskState, { status: 'error' }>['kind'], string> = {
  auth: 'The API key was not accepted',
  billing: 'The account is out of credit',
  model: 'That model is not available',
  'rate-limit': 'Too many requests for now',
  refusal: 'The assistant declined',
  truncated: 'The answer was cut off',
  network: 'The assistant did not answer',
  server: 'The assistant is having trouble',
  'bad-response': 'The answer could not be read',
  request: 'The request was rejected',
  'tmdb-key': 'This needs a TMDB key',
  tmdb: 'The titles could not be looked up',
};

export function AskResults({ ask, assistant, onPick }: { ask: Ask; assistant: string; onPick: (text: string) => void }) {
  const { state, recent } = ask;

  if (state.status === 'idle') {
    return (
      <>
        {recent.length > 0 && (
          <section className="recent-searches">
            <h2 className="eyebrow">Recent asks</h2>
            <div className="chips">
              {recent.map((r) => (
                <button key={r} className="chip" title={r} onClick={() => onPick(r)}>
                  <Clock size={13} /> <span className="chip__text">{r}</span>
                </button>
              ))}
              <button className="chip chip--ghost" onClick={ask.clearRecent}>
                Clear
              </button>
            </div>
          </section>
        )}
        <section className="recent-searches">
          <h2 className="eyebrow">Try asking</h2>
          <div className="chips">
            {EXAMPLES.map((e) => (
              <button key={e} className="chip" onClick={() => onPick(e)}>
                <Sparkles size={13} /> {e}
              </button>
            ))}
          </div>
        </section>
        <p className="s-empty">
          Describe what you feel like watching and press Enter. {assistant} suggests titles, and ROVE shows the ones it can find. Only your request is sent.
        </p>
      </>
    );
  }

  if (state.status === 'loading') {
    return (
      <>
        <p className="ask-status" role="status">
          <Spinner size={18} />
          {state.stage === 'asking' ? `Asking ${assistant}…` : 'Finding the titles…'}
        </p>
        <div className="ask-grid" aria-hidden>
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="card card--poster">
              <Skeleton className="card__frame card__frame--skeleton" />
              <Skeleton className="card__caption-skeleton" />
            </div>
          ))}
        </div>
      </>
    );
  }

  if (state.status === 'empty') {
    return state.why === 'none-suggested' ? (
      <Empty title="No titles came back">{assistant} had nothing to suggest for that. Try describing it another way.</Empty>
    ) : (
      <Empty title="None of the suggestions could be found">{assistant} answered, but ROVE could not match any of its titles on TMDB. Try asking again, or more specifically.</Empty>
    );
  }

  if (state.status === 'error') {
    return (
      <Empty
        title={ERROR_TITLE[state.kind]}
        action={
          IN_ACCOUNTS.has(state.kind) ? (
            <Button variant="secondary" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
              Open Accounts
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void ask.submit(state.text)}>
              Try again
            </Button>
          )
        }
      >
        {state.message}
      </Empty>
    );
  }

  const missing = state.suggested - state.cards.length;
  return (
    <section className="search-section">
      <h2 className="row__title">
        {assistant}’s picks <span className="row__count">{state.cards.length}</span>
      </h2>
      <p className="ask-for">For “{state.text}”</p>
      <div className="ask-grid">
        {state.cards.map((c) => (
          <div key={`${c.type}:${c.tmdbId}`} className="ask-card">
            <PosterCard title={{ metaId: c.metaId, type: c.type, name: c.name, poster: c.poster, background: c.background, year: c.year, rating: c.rating }} />
            {c.reason && (
              <p className="ask-card__reason" title={c.reason}>
                {c.reason}
              </p>
            )}
          </div>
        ))}
      </div>
      {missing > 0 && (
        <p className="ask-note">
          {missing === 1 ? 'One more suggestion was' : `${missing} more suggestions were`} left out: ROVE could not find {missing === 1 ? 'it' : 'them'} on TMDB.
        </p>
      )}
    </section>
  );
}
