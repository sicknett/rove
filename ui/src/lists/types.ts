// Lists from outside ROVE (Trakt, MDBList, a media server) that can be a source in a collection
// folder or a row of their own on Home.

import type { MetaPreview } from '../addons/types';
import type { CollectionSource } from '../state/collections';

/** A title on a list. `tmdbId` is kept next to an IMDb id so its poster can be looked up. */
export interface ListItem extends MetaPreview {
  tmdbId?: number;
}

/**
 * One page of a list. `next` is what to ask for to get the page after it (a page number or an
 * offset, as the provider counts), or null when this was the last.
 */
export interface ListPage {
  items: ListItem[];
  next: number | null;
}

export type ListProviderId = 'trakt' | 'mdblist' | 'server';

/** A list the user can pick: what to call it, a line about it, and the source that reads it. */
export interface ListChoice {
  /** The source's key (see sourceKey): the same list offered twice is one choice. */
  key: string;
  title: string;
  detail?: string;
  source: CollectionSource;
}
