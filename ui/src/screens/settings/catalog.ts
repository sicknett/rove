// Every control in Settings, in one list: where it lives, what it is called, what its hint says
// and the words a person might search for it by. The pages take their labels and hints from
// here, so search, the "changed" counts and "Reset this section" always describe what is on
// screen. An entry's `id` is also the anchor a deep link or a search result scrolls to.

import type { Settings } from '../../state/settings';

export type SectionId = 'playback' | 'languages' | 'audio' | 'home' | 'appearance' | 'addons' | 'servers' | 'accounts' | 'profiles' | 'data' | 'about';

/** A stored preference, as `<part>.<key>` of the settings document. */
export type SettingPath = { [S in keyof Settings]: `${S}.${keyof Settings[S] & string}` }[keyof Settings];

export interface SectionInfo {
  id: SectionId;
  label: string;
  /** Whose the section's choices are: the open profile's, or everyone's on this PC. */
  scope: 'profile' | 'shared' | 'mixed';
  /** Extra words that find the section itself. */
  keywords?: string;
}

/** The sections, grouped by what a person is trying to do, in the order they are listed. */
export const SECTION_GROUPS: { label: string; sections: SectionInfo[] }[] = [
  {
    label: 'Watching',
    sections: [
      { id: 'playback', label: 'Playback', scope: 'profile', keywords: 'player sources streams' },
      { id: 'languages', label: 'Subtitles & languages', scope: 'profile', keywords: 'captions cc' },
      { id: 'audio', label: 'Audio', scope: 'profile', keywords: 'sound volume' },
    ],
  },
  {
    label: 'Home and look',
    sections: [
      { id: 'home', label: 'Home layout', scope: 'profile', keywords: 'rows banner' },
      { id: 'appearance', label: 'Appearance', scope: 'profile', keywords: 'theme look posters' },
    ],
  },
  {
    label: 'Content',
    sections: [
      { id: 'addons', label: 'Addons', scope: 'shared', keywords: 'stremio catalogs streams' },
      { id: 'servers', label: 'Media servers', scope: 'shared', keywords: 'plex jellyfin emby silo' },
      { id: 'accounts', label: 'Accounts', scope: 'mixed', keywords: 'sign in keys services tracker assistant tmdb' },
    ],
  },
  {
    label: 'This PC',
    sections: [
      { id: 'profiles', label: 'Profiles', scope: 'shared', keywords: 'users who is watching' },
      { id: 'data', label: 'Data', scope: 'shared', keywords: 'backup restore share code storage history' },
      { id: 'about', label: 'About', scope: 'shared', keywords: 'version update credits' },
    ],
  },
];

export const SECTIONS: SectionInfo[] = SECTION_GROUPS.flatMap((g) => g.sections);

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

/**
 * Sections that used to exist, and where their controls went. A link to one still lands on the
 * right page, at the right control.
 */
const MOVED: Record<string, { section: SectionId; focus: string }> = {
  sources: { section: 'playback', focus: 'sources.autoPlay' },
};

/** The section a route names (the first one when it names none), and a control to bring into view. */
export function resolveSection(name: string | undefined): { section: SectionId; focus?: string } {
  if (name && SECTION_IDS.has(name)) return { section: name as SectionId };
  if (name && MOVED[name]) return MOVED[name];
  return { section: SECTIONS[0].id };
}

export const sectionInfo = (id: SectionId) => SECTIONS.find((s) => s.id === id)!;

export interface SettingEntry {
  id: string;
  section: SectionId;
  /** The heading it sits under on its page. Empty when its group has none. */
  group: string;
  label: string;
  /** What it does, why you would change it, or what it costs. Whole sentences. */
  hint?: string;
  /** Words people use for it that are in neither the label nor the hint. */
  keywords?: string;
  /** Behind the section's "Advanced" disclosure. */
  advanced?: boolean;
  /** The stored preference behind it, when it is one (reset and "changed" go by this). */
  path?: SettingPath;
}

const entry = (section: SectionId, group: string, advanced = false) => (id: string, label: string, hint?: string, keywords?: string, path?: SettingPath): SettingEntry => ({
  id,
  section,
  group,
  label,
  hint,
  keywords,
  advanced: advanced || undefined,
  path,
});

/** An entry whose id is the stored preference it controls. */
const pref = (section: SectionId, group: string, advanced = false) => (path: SettingPath, label: string, hint?: string, keywords?: string): SettingEntry => entry(section, group, advanced)(path, label, hint, keywords, path);

export const ENTRIES: SettingEntry[] = [
  // ---------- Playback ----------
  pref('playback', 'Starting')('playback.resume', 'A title you stopped partway', 'What Play does when you come back to something unfinished.', 'resume continue start over saved position where I left off'),
  pref('playback', 'Starting')(
    'sources.autoPlay',
    'Choosing the source',
    'Which stream starts when you press Play: the best match, the first one, one that fits your rule, or none until you pick from the list.',
    'autoplay stream quality picker source list ask sources',
  ),
  pref('playback', 'Episodes')('playback.autoPlayNext', 'Play the next episode automatically', 'After a countdown when the credits start. Off shows the next episode and waits for you.', 'autoplay binge up next continuous'),
  pref('playback', 'Episodes')('playback.nextCountdownSec', 'Countdown before the next episode', 'How long the next-episode card counts down before it plays.', 'timer seconds up next'),
  pref('playback', 'Episodes')(
    'playback.stillWatchingAfter',
    'Ask “Are you still watching?”',
    'Counts episodes that started by themselves while you touched nothing, then pauses until you answer.',
    'sleep asleep idle pause binge',
  ),
  pref('playback', 'Skipping')('playback.skipIntro', 'Intros', 'Offer a Skip Intro button, skip by itself, or leave intros alone.', 'skip intro opening theme'),
  pref('playback', 'Skipping')('playback.skipRecap', 'Recaps', 'Offer a Skip Recap button, skip by itself, or leave recaps alone.', 'skip recap previously on'),
  pref('playback', 'Skipping')(
    'playback.skipCredits',
    'Credits',
    'On an episode with another one after it, Automatic starts the next episode straight away, and otherwise the next-episode card takes the button’s place.',
    'skip credits outro ending',
  ),
  pref('playback', 'Controls')('playback.seekStepSec', 'Skip back and forward by', 'The left and right arrow keys, and the two buttons beside Play.', 'seek rewind fast forward jump step seconds'),
  pref('playback', 'Sources', true)(
    'sources.preferBingeGroup',
    'Stay with the same release between episodes',
    'Follows the release your addon reports for the last episode, so a season keeps one quality and one group.',
    'binge group quality consistent same stream',
  ),
  pref('playback', 'Sources', true)(
    'sources.regex',
    'Your rule',
    'A regular expression tested against each source’s name and description, for example 2160p.*(DV|HDR). The first source that fits plays.',
    'regex regular expression filter pattern 4k 1080p hdr dv quality auto-pick',
  ),
  pref('playback', 'Sources', true)(
    'sources.reuseLinkHours',
    'Reuse a link that worked for',
    'Coming back to a title then starts at once, without asking your addons again. Debrid links stop working after a while, so longer is not always better.',
    'cache remember stream debrid expire hours',
  ),
  pref('playback', 'Episodes', true)(
    'playback.nextLeadSec',
    'Show the next episode this long before the end',
    'Only for episodes whose credits are not marked. Reaching this point also counts the episode as watched.',
    'up next lead time credits seconds',
  ),
  pref('playback', 'Player', true)(
    'sources.externalPlayer',
    'External player',
    'The full path to another player, for example C:\\Program Files\\VideoLAN\\VLC\\vlc.exe. Each source then gets an “Open in” button. ROVE’s own player stays the default.',
    'vlc mpv mpc potplayer open in program path exe',
  ),
  pref('playback', 'Player', true)(
    'playback.hwdec',
    'Hardware decoding',
    'Decodes video on the graphics card. Turn it off only if a video shows blocks or a green picture: the processor then does the work, and 4K may stutter.',
    'gpu graphics card hwdec decoder software artefacts artifacts',
  ),

  // ---------- Subtitles & languages ----------
  pref('languages', 'Languages')('languages.audio', 'Audio languages', 'In order of preference: the first one a title has is played.', 'dub dubbed original spoken language'),
  pref('languages', 'Languages')('languages.subtitles', 'Subtitle languages', 'The languages you read, in order of preference. Audio in one of them counts as understood.', 'language'),
  pref('languages', 'Subtitles')(
    'languages.subtitleMode',
    'Turn subtitles on',
    'When subtitles come on by themselves: for foreign lines only, whenever the audio is in another language, always, or never.',
    'forced signs default automatic foreign',
  ),
  pref('languages', 'Subtitles')(
    'languages.stripSdh',
    'Prefer subtitles without sound descriptions',
    'Puts SDH tracks, the ones with [door slams] and speaker names, last when there is a choice.',
    'sdh hearing impaired hi deaf',
  ),
  pref('languages', 'Subtitle look')('subtitleStyle.size', 'Size', 'S, M, L and XL are the sizes the player’s subtitle menu offers.', 'subtitle text bigger smaller font size'),
  pref('languages', 'Subtitle look')('subtitleStyle.color', 'Text colour', 'Soft white is the easiest on the eyes in a dark room. Yellow stands out on bright pictures.', 'subtitle color yellow white'),
  pref('languages', 'Subtitle look')(
    'subtitleStyle.background',
    'Behind the text',
    'Shadow and Outline both draw an outline around the letters. Box sets them on a dark panel instead.',
    'subtitle background shadow outline box border style',
  ),
  pref('languages', 'Subtitle look')('subtitleStyle.font', 'Font', 'A few good subtitle faces that come with Windows, so the player always has them.', 'subtitle typeface family lettering'),
  pref('languages', 'Subtitle look', true)('subtitleStyle.bold', 'Bold', 'Heavier letters, easier to read over a busy picture.', 'subtitle weight thick'),
  pref('languages', 'Subtitle look', true)('subtitleStyle.outlineSize', 'Outline width', 'A wider outline keeps letters readable on bright scenes. 0 removes it.', 'subtitle border thickness stroke'),
  pref('languages', 'Subtitle look', true)('subtitleStyle.outlineColor', 'Outline colour', 'Black suits every text colour. The others soften the edge.', 'subtitle border color stroke'),
  pref('languages', 'Subtitle look', true)(
    'subtitleStyle.marginY',
    'Distance from the bottom',
    'Raise it to keep subtitles clear of a soundbar, or of the black bars of a wide film.',
    'subtitle position margin height raise lower',
  ),

  // ---------- Audio ----------
  pref('audio', 'Volume')('playback.rememberVolume', 'Remember the volume', 'Each title starts at the volume you last used.', 'loudness level sound'),
  pref('audio', 'Volume')('audio.volumeMax', 'Volume boost', 'Lets the volume go past 100 % for quiet films. Loud scenes can distort.', 'louder amplify quiet maximum'),
  pref('audio', 'Volume')(
    'audio.normalize',
    'Even out loud and quiet scenes',
    'Brings dialogue up and explosions down. Good for late nights.',
    'normalize night mode dynamic range compression loudness dialogue voices',
  ),
  pref('audio', 'Timing')(
    'audio.delayMs',
    'Audio offset',
    'Raise it when Bluetooth headphones play behind the picture: the video waits to match. The player’s audio menu changes the same value while you watch.',
    'bluetooth lip sync delay lag latency headphones out of sync',
  ),
  pref('audio', 'Output', true)(
    'audio.passthrough',
    'Send surround sound untouched to a receiver',
    'Dolby and DTS go out over HDMI as they are, and ROVE keeps the audio device to itself while it plays. Leave it off for headphones, speakers and most TVs.',
    'passthrough bitstream dolby dts atmos truehd hdmi soundbar avr exclusive spdif',
  ),

  // ---------- Home layout ----------
  pref('home', 'Banner')('appearance.heroEnabled', 'Show the banner', 'The large rotating feature at the top of Home.', 'hero featured billboard spotlight'),
  pref('home', 'Banner')('appearance.heroSource', 'The banner features', 'Titles from the rows you starred, from Continue Watching, or from your watchlist.', 'hero source featured starred watchlist'),
  pref('home', 'Banner')(
    'appearance.heroTrailers',
    'Play trailers in the banner',
    'The trailer fades in over the picture, and the banner moves on when it ends. It stays silent until you turn the sound on from the banner.',
    'hero trailer video autoplay youtube',
  ),
  pref('home', 'Banner')('appearance.heroTrailerStart', 'Banner trailers start', 'By themselves after a moment on a title, or only while the pointer rests on the banner.', 'hero trailer autoplay hover'),
  pref('home', 'Rows')('appearance.landscapeContinueWatching', 'Wide Continue Watching cards', 'Episode stills in place of posters.', 'landscape thumbnails stills'),
  pref('home', 'Rows')(
    'appearance.smartRows',
    'Rows made for you',
    'Top picks, Because you watched, Trending, the Top 10s, New releases and your genres. Worked out on this PC from what you watch and looked up on TMDB, with no account and no AI key. Each one can be moved, renamed or switched off in the list below.',
    'recommendations suggestions personal smart for you',
  ),
  entry('home', 'Rows')('home.notInterested', 'Titles marked Not interested', 'Kept out of the rows made for you until you allow them again.', 'hidden hide blocked'),
  entry('home', 'Row order')('home.rows', 'Rows on Home', 'Switch rows on or off, rename them, move them, and star the ones the banner takes titles from.', 'reorder rename hide catalogs order move star collections lists'),
  entry('home', 'Row order')('home.import', 'Import lists', 'Adds lists from Trakt, MDBList, TMDB or a media server as rows of their own.', 'trakt mdblist tmdb letterboxd list import'),
  entry('home', 'Row order')('home.resetRows', 'Reset rows', 'Every row back on, under its own name, in the order Home first gave them.', 'default layout restore'),

  // ---------- Appearance ----------
  pref('appearance', 'App')('appearance.accent', 'Accent colour', 'Tints switches, sliders and whatever is selected.', 'theme color sage mist sand rose sky'),
  pref('appearance', 'App')('appearance.navPosition', 'Navigation', 'Home, Search and the rest down the left edge, or across the top so pages get the full width.', 'sidebar menu top bar tabs position'),
  pref('appearance', 'App')('appearance.reduceMotion', 'Reduce motion', 'Cuts animations and transitions short. ROVE also follows the same setting in Windows. Trailers have their own switches.', 'animation accessibility transitions'),
  pref('appearance', 'Posters')('appearance.cardSize', 'Poster size', 'Wherever posters appear: Home, Search, Discover and the Library.', 'card zoom bigger smaller grid'),
  pref('appearance', 'Posters')('appearance.showRatings', 'Ratings on posters', 'A small score in the corner of each poster.', 'imdb score stars rating'),
  pref('appearance', 'Posters')('appearance.hoverPreview', 'Preview on hover', 'A poster in a row widens into a preview and plays the title’s trailer when the pointer rests on it.', 'trailer expand autoplay peek video'),

  // ---------- Addons ----------
  entry('addons', 'Add an addon')('addons.install', 'Add an addon', 'Paste the manifest link from the addon’s configure page.', 'install manifest stremio link url torrentio aiostreams aiometadata cinemeta'),
  entry('addons', 'Installed')('addons.installed', 'Installed addons', 'Switch an addon or one of its parts off, change the order, configure, refresh or remove it.', 'order enable disable remove configure refresh catalogs streams metadata subtitles'),

  // ---------- Media servers ----------
  entry('servers', 'Your servers')('servers.list', 'Your servers', 'Switch a server off, read its libraries again, or remove it.', 'plex jellyfin emby silo library libraries refresh remove'),
  entry('servers', 'Add a server')('servers.add', 'Add a server', 'Jellyfin, Emby, Silo or Plex.', 'plex jellyfin emby silo quick connect sign in address'),

  // ---------- Accounts ----------
  entry('accounts', 'Tracking')('accounts.tracker', 'Tracker', 'Keeps history, progress and your watchlist in step with PublicMetaDB, Trakt, Simkl or MDBList.', 'trakt simkl mdblist publicmetadb pmdb sync watch history watchlist scrobble sign in connect'),
  entry('accounts', 'AI assistant')('accounts.assistant', 'AI assistant', 'Powers Ask in Search and the For you row, with your own key.', 'ai claude gemini openai chatgpt ollama openrouter groq ask for you recommendations api key model'),
  entry('accounts', 'TMDB')('accounts.tmdb', 'TMDB key', 'Logo art, cast, trailers, recommendations and collections come from TMDB.', 'themoviedb api key artwork cast trailers metadata'),

  // ---------- Profiles ----------
  entry('profiles', '')('profiles.list', 'Profiles', 'Add a profile, or change one’s name, photo, colour, PIN and Kids setting.', 'user name photo avatar picture colour pin lock kids children add delete who is watching'),
  entry('profiles', 'Starting ROVE')('profiles.autoOpenLast', 'Open the last profile when ROVE starts', 'Skips the “Who’s watching?” screen, unless that profile has a PIN.', 'startup picker who is watching launch'),

  // ---------- Data ----------
  entry('data', 'Back up and move')('data.backupKeys', 'Put sign-ins and keys in the backup', 'Adds your tracker and media server sign-ins and your TMDB, MDBList and AI assistant keys. Keep that file like a password.', 'secrets passwords api keys'),
  entry('data', 'Back up and move')('data.backup', 'Back up', 'Saves one .json file you can copy to another PC.', 'export save move transfer another pc'),
  entry('data', 'Back up and move')('data.restore', 'Restore a backup', 'Replaces the addons, profiles and settings on this PC with the backup’s.', 'import load move transfer'),
  entry('data', 'Share your setup')('data.shareKeys', 'Include API keys and sign-ins', 'Anyone who has the code gets working keys and sign-ins until it runs out, so such a code lasts one day.', 'secrets passwords api keys tracker'),
  entry('data', 'Share your setup')('data.shareCreate', 'Create a code', 'Makes a code a friend types into their ROVE to get your addons, profiles, settings, Home layout and collections.', 'share code friend send give export setup invite'),
  entry('data', 'Share your setup')('data.shareUse', 'Use a code', 'Gets the setup a friend shared. You see what is in it and confirm before anything on this PC changes.', 'share code friend enter redeem import receive setup'),
  entry('data', 'Storage')('data.cache', 'Cached catalogs and details', 'Clearing makes everything load again from your addons. History and settings stay.', 'cache clear refresh stale'),
  entry('data', 'Storage')('data.logs', 'Logs', 'For reporting a problem: playback events and errors, never addon links or keys.', 'log report problem bug troubleshooting folder'),
  entry('data', 'Storage')('data.screenshots', 'Screenshots', 'Pictures you saved from the player.', 'pictures capture folder'),
  entry('data', 'Remove')('data.clearHistory', 'Clear this profile’s watch history on this PC', 'Removes progress, watched marks and the local watchlist.', 'delete history progress watched erase wipe'),

  // ---------- About ----------
  entry('about', '')('about.update', 'Updates', 'ROVE looks for a new version when it starts, and whenever you ask here.', 'version new release upgrade check download install'),
  entry('about', 'Built with')('about.credits', 'What ROVE is built with', 'mpv, WebView2, TMDB and the community skip-time databases.', 'credits licence license mpv tmdb third party'),
];

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

export function entryOf(id: string): SettingEntry | undefined {
  return BY_ID.get(id);
}

/** The stored preferences a section's page controls. */
export function sectionPaths(section: SectionId, only?: 'advanced'): SettingPath[] {
  return ENTRIES.filter((e) => e.section === section && e.path && (only !== 'advanced' || e.advanced)).map((e) => e.path!);
}
