// A list as a row of posters on Home (a list imported "as a row"), and taking one off again.

import { useState } from 'react';
import { asMediaType, flatItems } from '../data/hooks';
import { blockerMessage, sourceBlocker, useSourceItems, type SourceBlocker } from '../data/sources';
import { Row, RowRetry, useNearViewport } from '../media/Row';
import { PosterCard } from '../media/cards';
import { navigate, useNav } from '../nav/router';
import { useCollections, type ListRow } from '../state/collections';
import type { MenuItem } from '../ui/controls';
import { toast } from '../ui/toast';
import { ImportListsDialog } from './ImportLists';

/** Takes a list's row off Home, with an undo that puts it back in its place. */
export function removeListRow(id: string, title: string) {
  const removed = useCollections.getState().removeList(id);
  if (!removed) return;
  // Its "See all" page leaves history with it, so Back never lands on a list that is gone.
  useNav.getState().drop((r) => r.name === 'list' && r.id === id);
  toast.info(`${title} removed from Home`, { label: 'Undo', run: () => useCollections.getState().restoreList(removed.row, removed.index) });
}

/** Why a read failed, in the provider's own words when it gave any. */
export const loadFailure = (e: unknown) => (e instanceof Error && e.message ? e.message : 'This list did not load.');

/**
 * The way out of a blocker, as a small text button: Settings where that puts it right, and for a
 * missing MDBList key the Import lists dialog, which is where a key for lists is entered.
 */
export function BlockerAction({ blocker, className = 'row__more' }: { blocker: SourceBlocker; className?: string }) {
  const [addingKey, setAddingKey] = useState(false);
  const { section } = blockerMessage(blocker);
  if (blocker === 'mdblist-key') {
    return (
      <>
        <button className={className} onClick={() => setAddingKey(true)}>
          Add a key
        </button>
        {addingKey && <ImportListsDialog start="mdblist" onClose={() => setAddingKey(false)} />}
      </>
    );
  }
  if (!section) return null;
  return (
    <button className={className} onClick={() => navigate({ name: 'settings', section })}>
      Open Settings
    </button>
  );
}

export function ListHomeRow({ list, title, menu }: { list: ListRow; title: string; menu: () => (MenuItem | 'divider')[] }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const blocker = sourceBlocker(list.source);
  const q = useSourceItems(list.source, near);
  const items = flatItems(q.data?.pages);
  // An empty list draws nothing, like an empty catalog. One that cannot be read says why: the
  // user put it here, and a row that silently went missing would look like a fault.
  if (!blocker && q.isSuccess && items.length === 0) return <div ref={ref} />;
  const why = blocker ? blockerMessage(blocker) : null;
  return (
    <div ref={ref}>
      <Row
        title={title}
        menu={menu}
        loading={!blocker && (!near || q.isLoading)}
        onNearEnd={() => q.hasNextPage && !q.isFetchingNextPage && !q.isFetchNextPageError && void q.fetchNextPage()}
        action={
          !blocker && (
            <button className="row__more" onClick={() => navigate({ name: 'list', id: list.id })}>
              See all
            </button>
          )
        }
      >
        {why && blocker && (
          <div className="row__note">
            {why.title}
            <BlockerAction blocker={blocker} />
          </div>
        )}
        {!blocker && q.isLoadingError && <RowRetry onRetry={() => void q.refetch()}>{loadFailure(q.error)}</RowRetry>}
        {!blocker &&
          items.map((m) => (
            <PosterCard
              key={m.id}
              title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo, rating: m.imdbRating }}
              progress={(m as { progress?: number }).progress}
            />
          ))}
        {q.isFetchingNextPage && <div className="row__more-spinner" />}
        {q.isFetchNextPageError && !q.isFetchingNextPage && <RowRetry onRetry={() => void q.fetchNextPage()} />}
      </Row>
    </div>
  );
}
