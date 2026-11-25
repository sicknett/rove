# Privacy

ROVE is a desktop app. It has no server of its own and collects nothing: there are no accounts
with ROVE, no analytics, no telemetry and no advertising.

## What stays on your PC

Everything you set up lives in `%LOCALAPPDATA%\ROVE` on your own computer: profiles, addons,
media servers, Home layout, collections, watch history, Continue Watching, watchlist and
settings. Addon links, API keys and sign-in tokens are stored encrypted for your Windows account
(Windows DPAPI). The log file records playback events and errors, never addon links, keys or
tokens. Uninstalling asks whether to remove this folder.

## What leaves your PC, and to whom

ROVE talks only to services you add or switch on, and sends each one only what that feature
needs:

- **Your addons and media servers**: catalog, metadata, source and subtitle requests for the
  titles you browse and play, to the addresses you entered. Media servers also receive playback
  progress for what you play from them.
- **TMDB**: lookups for artwork, cast, trailers, recommendations and the built-in Home rows.
- **Your tracker** (PublicMetaDB, Trakt, Simkl or MDBList), only if you connect one: your watch
  progress, watched marks and watchlist, synced both ways with your account there.
- **Imported lists**, only if you import some: requests for those lists to Trakt, MDBList or your
  server.
- **AI assistant**, only if you connect one with your own API key: the request you type in Ask,
  and for the "For you" row a list of titles from your history and watchlist, sent to the
  provider you chose (Anthropic, Google or the OpenAI-compatible address you entered).
- **Skip-time services** (TheIntroDB, IntroDB, PublicMetaDB, AniSkip): the id of the episode or
  film being played, to fetch intro and credits times.
- **YouTube**, only when a trailer plays.
- **GitHub**: a check for a newer ROVE release, and its download when you choose to update.

Each of those services has its own privacy policy, which applies to what it receives.

## Trakt

When you sign in to Trakt, ROVE stores the access token Trakt issues, encrypted on your PC, and
uses it only to read and update your own Trakt data (history, playback progress, watchlist,
lists) from your computer. ROVE's developers never receive your token or your Trakt data.
Disconnecting in Settings → Accounts deletes the token from your PC; you can also revoke ROVE at
trakt.tv under Settings → Connected Apps.

## Contact

Questions and requests: open an issue at https://github.com/sicknett/rove/issues.
