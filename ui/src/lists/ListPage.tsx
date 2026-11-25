// "See all" for a list that is a row on Home: every title of the list in a grid.

import { flatItems } from '../data/hooks';
import { blockerMessage, sourceBlocker, sourceOrigin, useSourceItems } from '../data/sources';
import { paging, PosterGrid } from '../media/Grid';
import { listRowKey, useCollections, type CollectionSource } from '../state/collections';
import { useHomeLayout } from '../state/homeLayout';
import { Button, Empty } from '../ui/controls';
import { BlockerAction, loadFailure } from './ListRow';

function ListGrid({ source }: { source: CollectionSource }) {
  const q = useSourceItems(source);
  const items = flatItems(q.data?.pages);
  const blocker = sourceBlocker(source);
  if (blocker) {
    const why = blockerMessage(blocker);
    return (
      <Empty title={why.title} action={<BlockerAction blocker={blocker} className="btn btn--secondary btn--md" />}>
        {why.text}
      </Empty>
    );
  }
  if (q.isLoadingError) {
    return (
      <Empty
        title="This list did not load"
        action={
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Try again
          </Button>
        }
      >
        {loadFailure(q.error)}
      </Empty>
    );
  }
  if (!q.isLoading && !items.length) return <Empty title="Nothing here">This list has no movies or shows right now.</Empty>;
  return <PosterGrid items={items} {...paging(q)} progressOf={(m) => (m as { progress?: number }).progress} />;
}

export function ListPage({ id }: { id: string }) {
  const list = useCollections((s) => s.lists.find((l) => l.id === id));
  // The name it was given in Settings → Home layout, as its row on Home shows it.
  const renamed = useHomeLayout((s) => s.items.find((i) => i.key === listRowKey(id))?.customTitle);
  if (!list) return <Empty title="This list is no longer on Home">It was removed. Lists can be added again with Import lists in Library → Collections.</Empty>;
  return (
    <div className="screen-pad">
      <header className="page-head">
        <h1 className="page-title">{renamed || list.title}</h1>
        <span className="page-sub">{sourceOrigin(list.source)}</span>
      </header>
      <div className="page-body">
        <ListGrid key={list.id} source={list.source} />
      </div>
    </div>
  );
}
