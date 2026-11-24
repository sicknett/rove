// Writes every pending document now (before closing, switching profile or restoring a backup).

import { flushAddons } from '../addons/store';
import { flushIdMap } from '../tracking/idmap';
import { flushLinks } from '../player/session';
import { flushTrackMemory } from '../player/prefs';
import { flushCollections } from './collections';
import { flushHistory } from './history';
import { flushHomeLayout } from './homeLayout';
import { flushSettings } from './settings';

export async function flushAll() {
  await Promise.all(
    [flushSettings(), flushHistory(), flushHomeLayout(), flushCollections(), flushLinks(), flushTrackMemory(), flushIdMap(), flushAddons()].map((p) => p.catch(() => undefined)),
  );
}
