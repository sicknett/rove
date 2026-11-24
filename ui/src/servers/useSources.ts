// Addons plus media servers, for screens that list catalogs (Home, Search, Home settings).

import { useMemo } from 'react';
import { useAddons } from '../addons/store';
import type { InstalledAddon } from '../addons/types';
import { serverAsAddon } from '.';
import { useServers } from './store';

export function useCatalogSources(): InstalledAddon[] {
  const addons = useAddons((s) => s.addons);
  const servers = useServers((s) => s.servers);
  return useMemo(() => [...addons, ...servers.filter((s) => s.enabled).map(serverAsAddon)], [addons, servers]);
}
