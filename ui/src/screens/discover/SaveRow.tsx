// The filters in force as a row on Home: saved under a name, shown there from then on, and taken
// off again from the same button. The row is the list rows' own kind (state/collections.ts
// `lists`), so Home, its layout settings and "See all" treat it like any imported list.

import { useState } from 'react';
import { BookmarkCheck, BookmarkPlus, House, X } from 'lucide-react';
import { importAsRows } from '../../lists/importing';
import { removeListRow } from '../../lists/ListRow';
import { navigate } from '../../nav/router';
import { sourceKey, useCollections, type CollectionSource } from '../../state/collections';
import { Button, Dialog, Menu, TextField } from '../../ui/controls';
import { toast } from '../../ui/toast';

interface Props {
  /** What the filters ask TMDB for. Two filter sets that ask for the same thing are the same row. */
  source: CollectionSource;
  /** A name for the row, from the filters, to start from. */
  suggested: string;
}

export function SaveRow({ source, suggested }: Props) {
  const key = sourceKey(source);
  const saved = useCollections((s) => s.lists.find((l) => sourceKey(l.source) === key));
  const [naming, setNaming] = useState(false);

  if (saved) {
    return (
      <Menu
        trigger={(p) => (
          <Button {...p} variant="secondary" icon={<BookmarkCheck size={16} />} title={`These filters are the row “${saved.title}” on Home`}>
            On Home
          </Button>
        )}
        items={[
          { label: 'Show on Home', icon: <House size={16} />, onSelect: () => navigate({ name: 'home' }) },
          { label: 'Remove from Home', icon: <X size={16} />, danger: true, onSelect: () => removeListRow(saved.id, saved.title) },
        ]}
      />
    );
  }

  return (
    <>
      <Button variant="secondary" icon={<BookmarkPlus size={16} />} title="Keep these filters as a row on Home" onClick={() => setNaming(true)}>
        Save to Home
      </Button>
      {naming && <NameRow source={source} suggested={suggested} onClose={() => setNaming(false)} />}
    </>
  );
}

function NameRow({ source, suggested, onClose }: Props & { onClose: () => void }) {
  const [name, setName] = useState(suggested);
  const add = () => {
    const title = name.trim() || suggested;
    onClose();
    const r = importAsRows([{ key: sourceKey(source), title, source: { ...source, title } }]);
    if (!r.added) return void toast.info('These filters already have a row on Home.');
    toast.success(`“${title}” added to Home, under Continue Watching.`, { label: 'Show on Home', run: () => navigate({ name: 'home' }) });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save to Home"
      width={480}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={add}>
            Add to Home
          </Button>
        </>
      }
    >
      <p className="dialog__text">A row on Home that always shows what these filters find, in the order chosen here. It can be moved, renamed or removed in Settings → Home layout.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <TextField label="Row name" value={name} onChange={setName} data-autofocus maxLength={80} />
      </form>
    </Dialog>
  );
}
