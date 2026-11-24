// The Stremio addon protocol, as documented in stremio-addon-sdk/docs.

export type ContentType = 'movie' | 'series' | 'channel' | 'tv' | 'anime' | string;

export interface ManifestExtra {
  name: string;
  isRequired?: boolean;
  options?: string[];
  optionsLimit?: number;
}

export interface ManifestCatalog {
  type: ContentType;
  id: string;
  name: string;
  extra?: ManifestExtra[];
  /** Older form of `extra`. */
  extraSupported?: string[];
  extraRequired?: string[];
  genres?: string[];
  showInHome?: boolean;
}

export interface ManifestResourceObject {
  name: string;
  types?: ContentType[];
  idPrefixes?: string[];
}

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  logo?: string;
  background?: string;
  types: ContentType[];
  resources: (string | ManifestResourceObject)[];
  catalogs: ManifestCatalog[];
  idPrefixes?: string[];
  addonCatalogs?: ManifestCatalog[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean; adult?: boolean; p2p?: boolean };
}

export interface MetaLink {
  name: string;
  category: string;
  url: string;
}

export interface Trailer {
  source?: string;
  type?: string;
  ytId?: string;
}

export interface Video {
  id: string;
  title?: string;
  name?: string;
  released?: string;
  season?: number;
  episode?: number;
  number?: number;
  thumbnail?: string;
  overview?: string;
  description?: string;
  streams?: Stream[];
  available?: boolean;
  runtime?: string | number;
  rating?: string | number;
}

export interface MetaPreview {
  id: string;
  type: ContentType;
  name: string;
  poster?: string;
  posterShape?: 'square' | 'poster' | 'landscape' | 'regular';
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string | number;
  genres?: string[];
  year?: string | number;
  runtime?: string;
  links?: MetaLink[];
  trailers?: Trailer[];
  trailerStreams?: Stream[];
}

export interface Meta extends MetaPreview {
  videos?: Video[];
  director?: string[] | string;
  cast?: string[];
  writer?: string[];
  country?: string;
  language?: string;
  awards?: string;
  website?: string;
  released?: string;
  app_extras?: { cast?: { name: string; character?: string; photo?: string }[]; certification?: string };
  behaviorHints?: { defaultVideoId?: string; hasScheduledVideos?: boolean };
  /** Some metadata addons put extra ids here. */
  imdb_id?: string;
  moviedb_id?: number;
  tvdb_id?: number;
}

export interface SubtitleRef {
  id?: string;
  url: string;
  lang: string;
}

export interface Stream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  nzbUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: SubtitleRef[];
  sources?: string[];
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
    filename?: string;
    videoSize?: number;
    videoHash?: string;
    countryWhitelist?: string[];
    // AIOStreams extensions
    cached?: boolean;
    service?: string;
    indexer?: string;
    duration?: number;
    [key: string]: unknown;
  };
}

/** A stream with the addon it came from. */
export interface SourcedStream extends Stream {
  addonId: string;
  addonName: string;
  /** Position within its addon's list, which the addon chose (AIOStreams sorts server-side). */
  rank: number;
}

export interface InstalledAddon {
  /** The manifest link, which can carry a configuration secret. */
  url: string;
  manifest: Manifest;
  enabled: boolean;
  /** Resources the user switched off for this addon (e.g. its catalogs). */
  disabledResources?: string[];
  addedAt: number;
}
