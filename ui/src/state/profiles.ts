// Profiles: up to six, each with its own settings, home layout, history and tracker account.

import { create } from 'zustand';
import { docs, secrets } from '../lib/native';

export const AVATAR_COLORS = ['#9eb7a4', '#8ba7c7', '#c7a07a', '#b48ead', '#d08770', '#a3be8c', '#88c0d0', '#e5c07b'];
export const MAX_PROFILES = 6;

export interface Profile {
  id: string;
  name: string;
  color: string;
  /** Four digits, or none. Kept locally only; it is a household lock, not security. */
  pin?: string;
  kids?: boolean;
  /** A small square photo (JPEG data URL), chosen by the user. */
  image?: string;
  createdAt: number;
}

interface ProfilesDoc {
  profiles: Profile[];
  lastActiveId?: string;
  /** Skip the picker and open the last profile. */
  autoOpenLast?: boolean;
}

interface ProfilesState {
  loaded: boolean;
  profiles: Profile[];
  activeId: string | null;
  autoOpenLast: boolean;
  load: () => Promise<void>;
  activate: (id: string) => void;
  signOut: () => void;
  create: (p: Omit<Profile, 'id' | 'createdAt'>) => Profile;
  update: (id: string, patch: Partial<Omit<Profile, 'id'>>) => void;
  remove: (id: string) => void;
  setAutoOpenLast: (v: boolean) => void;
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Everything kept per profile, by the base name given to `profileDoc`: settings, Home layout,
 * collections (and that they were seeded), watch history, track choices, remembered links, recent
 * searches; and, encrypted, the tracker sign-in (`pmdb` is its older form). A new per-profile
 * document belongs in this list, or it outlives its profile.
 */
export const PROFILE_DOCS = ['settings', 'home', 'collections', 'collections-seeded', 'history', 'tracks', 'links', 'searches'] as const;
export const PROFILE_SECRETS = ['tracker', 'pmdb'] as const;

/** Removes a deleted profile's files. */
async function deleteProfileData(id: string, wasActive: boolean) {
  // The profile that is open may still have a save waiting. It goes out first, or it would
  // write a file back after the file was deleted.
  if (wasActive) await import('./flushAll').then((m) => m.flushAll()).catch(() => undefined);
  const gone = [...PROFILE_DOCS.map((name) => docs.remove(profileDoc(name, id))), ...PROFILE_SECRETS.map((name) => secrets.remove(profileDoc(name, id)))];
  await Promise.all(gone.map((p) => p.catch((e) => console.error(e))));
}

function save(state: ProfilesState) {
  const doc: ProfilesDoc = { profiles: state.profiles, lastActiveId: state.activeId ?? undefined, autoOpenLast: state.autoOpenLast };
  docs.write('profiles', doc).catch((e) => console.error(e));
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  loaded: false,
  profiles: [],
  activeId: null,
  autoOpenLast: true,

  async load() {
    const doc = await docs.read<ProfilesDoc>('profiles').catch(() => null);
    let profiles = doc?.profiles ?? [];
    if (profiles.length === 0) {
      profiles = [{ id: 'p1', name: 'Me', color: AVATAR_COLORS[0], createdAt: Date.now() }];
    }
    const autoOpenLast = doc?.autoOpenLast ?? true;
    const last = profiles.find((p) => p.id === doc?.lastActiveId) ?? profiles[0];
    // One profile without a PIN, or "open last" chosen: go straight in.
    const straightIn = (profiles.length === 1 || autoOpenLast) && !last.pin;
    set({ profiles, loaded: true, autoOpenLast, activeId: straightIn ? last.id : null });
    if (!doc) save(get());
  },

  activate(id) {
    set({ activeId: id });
    save(get());
  },

  signOut() {
    set({ activeId: null });
  },

  create(p) {
    const profile: Profile = { ...p, id: newId(), createdAt: Date.now() };
    set({ profiles: [...get().profiles, profile].slice(0, MAX_PROFILES) });
    save(get());
    return profile;
  },

  update(id, patch) {
    set({ profiles: get().profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
    save(get());
  },

  remove(id) {
    if (get().profiles.length <= 1) return;
    const profiles = get().profiles.filter((p) => p.id !== id);
    const wasActive = get().activeId === id;
    set({ profiles, activeId: wasActive ? null : get().activeId });
    save(get());
    void deleteProfileData(id, wasActive);
  },

  setAutoOpenLast(v) {
    set({ autoOpenLast: v });
    save(get());
  },
}));

export function activeProfile(): Profile | undefined {
  const s = useProfiles.getState();
  return s.profiles.find((p) => p.id === s.activeId);
}

/** Document name for something kept per profile. */
export function profileDoc(base: string, profileId = useProfiles.getState().activeId) {
  return `${base}-${profileId ?? 'none'}`;
}
