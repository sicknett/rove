# ROVE feature checklist

Everything ROVE must do to match the polish and features of Strand, AIOStreams Desktop, Stremio
and Infuse-class players, on Windows, for anyone who installs it.

- `[x]` built and checked (unit tests, the running app, or both)
- `[~]` built, not yet checked end to end with real stream addons and accounts
- `[ ]` not started

Screenshots: [`docs/screenshots`](docs/screenshots).

## 1. Setup and addons
- [x] First-run setup: paste addon manifest links (each one is fetched and checked), or skip
- [x] Back up and restore: addons, profiles, settings, Home layout, collections, track choices; API keys only when asked; restoring freezes saves until reload so nothing old lands on top
- [x] Addon manager: add, remove (with undo), reorder, enable or disable, per-resource switches (catalogs, metadata, streams, subtitles)
- [~] Open an addon's configure page; refresh every manifest
- [x] Addon links stored encrypted (Windows DPAPI), never logged
- [x] Routing by resource, type and id prefix, falling through to the next addon on empty or error
- [x] `cacheMaxAge` honoured; one network request shared by every caller asking for the same thing
- [x] Catalogs that need a required extra stay off Home; search catalogs feed Search

## 1b. Media servers (like Strand and Infuse)
- [~] Jellyfin and Emby: sign in (password or Quick Connect), libraries as rows and catalogs, direct play, progress reported to the server
- [~] Plex: sign in with a Plex account (PIN link), pick a server, best address found automatically, libraries, direct play, timeline reported to Plex
- [~] Silo, through its Jellyfin-compatible API (user#profile sign-in)
- [~] Servers and addons side by side: one Home, one Continue Watching, one search (server results first), server copies as sources marked "Your server"
- [ ] Transcoding for files the player cannot open directly (direct play covers what mpv plays, which is nearly everything)

## 2. Profiles
- [x] Up to 6 profiles, each with its own Home layout, history, PublicMetaDB account and preferences
- [x] Profile picker (skipped when there is one profile without a PIN, or "open last" is on)
- [~] Four-digit PIN per profile
- [x] Profile photo: upload any image, centre-cropped to a square and shown everywhere the avatar is
- [~] Kids profile: addons marked adult are left out

## 3. Home
- [x] Featured banner: rotating titles with backdrop, logo art, rating, year, genres, overview, Play, Details, Watchlist
- [x] Banner trailers the way streaming services do it: fades in over the art, text steps aside, moves on when it ends; starts by itself or on hover; sound button; no YouTube controls
- [x] Banner source: the rows, Continue Watching or the watchlist
- [x] Continue Watching: resume points plus the next aired episode, newest first, wide cards with logo art
- [~] Remove from Continue Watching (with undo); mark watched from the card menu
- [x] A row per catalog, loaded as it scrolls into view, paging further on scroll
- [~] Collections as rows of folder tiles, opening to tabs or rows of sources (addon or TMDB; TMDB media types read in any case)
- [x] When the metadata addon keeps its catalogs off Home (collection-based setups), Home says why and offers Import collection and Discover
- [x] Home layout editor: turn rows on or off, rename, reorder, choose banner sources, edit a collection's folders, reset
- [x] Row menu on Home (⋯ or right-click the header): move up or down, hide, edit folders
- [x] Rows made for you from your history: Top picks, Because you watched, Trending, numbered Top 10s, New releases, genre rows, Hidden gems, From your watchlist; "Not interested"; one switch for all (seen with a real synced history; ranking quality is for the user to judge)
- [~] Lists as rows or folders from Trakt, MDBList and media servers (public Trakt lists read for real; accounts not yet)
- [~] "For you" row from the AI assistant, refreshed at most daily (stand-in service only)
- [x] Card hover lift and art; keyboard focus rings; right-click menus
- [x] Resting on a poster in a row opens it in place: it widens to a 16:9 preview with the backdrop, then the trailer, the logo, year, age rating, length and genres, and Play, Watchlist, Details and a sound button; one at a time, the banner's trailer waits meanwhile; a setting turns it off (seen in a test copy with a real trailer; how the motion feels is for the user to judge)
- [x] Top 10 rows: each place in its own narrow column beside the poster ("01" to "10"), never over the art
- [x] Rows scroll by round arrow buttons, the wheel or trackpad, or by clicking and dragging with the mouse (a drag carries on a little and rests on a card; it never opens the card it ended on)
- [x] "See all" opens the full catalog

## 4. Search and Discover
- [x] Search before typing: recent searches (remove one, clear all), Trending now, genre tiles for movies or shows that open Discover, popular people this week
- [x] Search as you type (TMDB first, then what addons and media servers add): best match on top with Play, Details and Watchlist; rows for Movies, Shows, People, On your servers, In your library and From your addons; chips for All, Movies, Shows, People; sort by best match, popular, newest or top rated
- [x] A year typed at the end narrows by year ("dune 2021")
- [x] Search by keyboard: arrows move through results, Enter opens the best match, Escape clears and then leaves; typing on a card carries on in the box
- [~] Open an IMDb or TMDB id directly from Search
- [~] Ctrl+K or / to search from anywhere; Alt+←/→ and mouse back/forward buttons
- [~] Ask: describe what you want in plain words and get real titles with reasons (Claude, Gemini or an OpenAI-compatible key; stand-in service only so far); "Nothing found" offers to ask instead
- [x] Discover finds titles by filters: movies or shows, several genres, release years, rating, length, language, where to watch (by country), sort; active filters as removable chips with a count; the filters are part of the page's history, so Back restores them
- [x] Discover starting points (Critically acclaimed, Hidden gems, Under 90 minutes, New this month, …) and Surprise me (a well-rated pick from the current filters, preferring what you have not watched)
- [x] Save a Discover search to Home as a row that stays current
- [x] Discover → Catalogs: every addon catalog with its genres, virtualised grid with infinite scroll
- [ ] Search results from a media server seen with a real server

## 5. Title page
- [x] Backdrop, logo art, rating, year, runtime, age rating, genres, tagline, overview
- [x] Play / Resume with what is next ("Play S1 E3 · …"), Sources, Trailer, Watchlist, More
- [x] Season tabs (a picker when there are many; Specials last; a season's extras after its episodes), episode cards with still, air date, overview, watched tick and progress; one guide shared with the player's episode list, safe against addons that list a video twice
- [x] Mark an episode, everything up to an episode, a season or the whole show watched or unwatched
- [~] Cast with photos, More like this, director and writer (needs a TMDB key)
- [~] Unaired episodes show their air date and do not play
- [x] One id per title: history, watchlist and cards use the IMDb id when it is known; entries stored under `tmdb:` ids are moved over (checked on a copy of a real synced history)

## 6. Sources
- [~] Every stream addon asked at once; results appear as they arrive, each addon's own order kept
- [~] AIOStreams' formatted names and descriptions shown; badges for cached, resolution, HDR/DV, REMUX, codec, audio, size, service
- [~] Filter by resolution and by addon
- [x] Auto-play rules: same release (binge group) as last episode, first source, regex, or always ask (unit tested)
- [~] A working link is reused for a few hours; an expired one is dropped and fresh sources are found
- [~] `proxyHeaders`, user agent and referrer passed to mpv
- [~] Open in an external player (mpv, VLC, MPC-HC); copy link
- [x] Clear message and a way to Settings when no stream addon is installed

## 7. Player
- [x] mpv under a transparent page: Direct3D 11, gpu-next, hardware decoding (picture checked on screen in windowed, maximized and full screen)
- [x] Seek bar with buffered range, chapter ticks and names, skip-segment marks, hover time
- [x] Auto-hiding controls and cursor; click to pause, double-click for fullscreen
- [x] Audio and subtitle menus with language names, codec and channels; subtitle timing and size
- [x] Audio offset for Bluetooth headphones, remembered
- [x] Audio returns after the output device drops, without stopping the picture or re-buffering (simulated outage; real headset not yet tried)
- [~] Resume, start over, or ask
- [~] Next episode card at the credits (or a set time before the end) with countdown; next sources fetched at 80 %
- [~] "Are you still watching?" after N episodes without input
- [~] Skip intro, recap and credits: chapter names, TheIntroDB, IntroDB, PublicMetaDB, AniSkip; button or automatic (merging unit tested)
- [~] Episode list (season picker, descriptions, opens on the playing episode) and source switcher inside the player
- [x] Button names at once on hover; less-used controls in one More menu; Speed and Picture open in its place with a Back heading (Escape goes back one level)
- [~] Subtitles from subtitle addons added as tracks
- [x] Track choice: the show's remembered choice, then preferred languages; forced / foreign-audio / always / off (unit tested)
- [~] Subtitle style: font (seven faces that come with Windows, each shown in its own face), size, colour, outline, shadow or box, bold, position, live preview
- [~] Picture: fit, fill, zoom, 16:9, 4:3, 2.39:1; hardware decoding switch
- [~] Picture in picture: small always-on-top window in the corner, restores exactly
- [~] Windows media controls: media keys, headset buttons, volume flyout with title and poster
- [~] Keyboard shortcuts with a help sheet; mouse-wheel volume; 0–9 to jump; frame step
- [~] Error screen with Retry and Try another source
- [~] Volume boost to 150 %, loudness levelling, passthrough to a receiver
- [ ] Seek-bar thumbnails
- [ ] Screenshot button (the command is ready; no button yet)
- [ ] Upscaler and deband choices

## 8. Tracking
- [x] Continue Watching and watched marks always saved on this PC, with no account needed
- [~] Connect PublicMetaDB or MDBList with an API key (checked first, stored encrypted per profile)
- [~] Two-way sync of resume points and watched history; Continue Watching ordered by activity
- [~] Progress saved on pause and stop and every 5 minutes; watched at 90 %; nothing under 2 %
- [~] Outbox with retries and backoff; sync status and Sync now in Settings
- [~] Watchlist mirrored both ways with the tracker's watchlist (Simkl: plan to watch)
- [x] Local history when no tracker is connected
- [ ] Ratings
- [~] Choose a tracker per profile, like Strand: PublicMetaDB, Trakt, Simkl or MDBList (or none)
- [~] Trakt (device code sign-in, token renewal, rewatch resets) and Simkl (device sign-in, PIN fallback); MDBList (API key). Trakt and Simkl need ROVE's app ids in the build
- [x] Backups carry tracker sign-ins and media servers (when keys are included)
- [~] Trakt lists as collection sources (public lists read for real)

## 9. Library and calendar
- [x] Library: Watchlist (sort, filter), Continue Watching, History, Collections (import, reorder, delete); posters come from TMDB by the title's id first, then from addons, and a poster that fails to load is replaced rather than left blank
- [~] Calendar: coming up and recently aired episodes of shows you watch or saved

## 10. Settings
- [x] Grouped sections: Watching (Playback, Subtitles & languages, Audio), Home and look (Home layout, Appearance), Content (Addons, Media servers, Accounts), This PC (Profiles, Data, About)
- [x] Search every setting (Ctrl+F); rarely changed settings sit under Advanced; each section can be reset, with Undo
- [x] Accent colours, poster size, ratings on posters, reduce motion
- [x] Navigation on the left or across the top
- [~] Open the logs and screenshots folders; clear cache; clear local history (with confirmation)

## 11. App
- [x] Frameless window with ROVE title bar on every screen: drag to move, Snap, double-click to maximize, right-click window menu (WebView2 title-bar regions); resize from every edge including the top (checked with a scripted mouse drag)
- [x] No flicker while resizing: the window paints ROVE's background, never paints over the video and page, and animations and blur pause during the resize
- [x] A test copy can run beside the real one with its own data folder (`ROVE_DATA_DIR`)
- [x] One running copy; a second launch brings the window forward
- [x] Closing saves everything first (up to 2 s) before the app exits
- [~] Window size, position and maximized state remembered
- [x] Recent screens stay loaded: going back is instant and keeps scroll position
- [x] Log file with playback events and mpv errors, never addon links or keys
- [x] Portable build with Start menu and Desktop shortcuts
- [x] Installer: per-user Setup.exe (no admin), Start menu and optional desktop shortcut, Apps list uninstaller, WebView2 check, updates in place keeping your data, uninstall asks before removing data (install, upgrade and uninstall checked silently)
- [ ] Code signing (no SmartScreen warning)
- [x] Update check at start and in Settings → About; the button downloads the new Setup straight through the browser, with no web page to click through (unsigned builds)
- [~] Installing the update from inside the app (signed download, install, reopen): works end to end, but only safe in code-signed builds, so it is a build option that is off for now
