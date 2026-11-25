# ROVE on Apple devices: handoff

Status: **not started**. This note is what someone needs to begin an iPhone and iPad build of
ROVE on a Mac, in this same repository. Windows work continues on the Windows PC; nothing here
changes the Windows app.

Written 2026-11-25, at ROVE 0.3.0. Where something below was read from documentation and not
tried, it says so.

## What is decided

- **Same repository, new folder.** The Apple app lives in `apple/` beside `shell/` (the Windows
  shell). Both use the one interface in `ui/`. It is not a fork.
- **iPhone and iPad first.** Apple TV comes later and is a larger job: tvOS has no web views, so
  it needs a native interface over the shared logic.
- **No remux or transcoding server.** The app carries its own player engine, as the Windows app
  carries mpv, and plays addon streams and Jellyfin, Plex and Emby directly.
- **Player engine: AetherEngine**, <https://github.com/superuser404notfound/AetherEngine>, with
  mpv (MPVKit) as the fallback if it cannot do the job. Read from its README and docs, not yet
  tried:
  - no interface of its own: the host gets one view (`AetherPlayerSurface`) and async methods;
  - FFmpeg reads the file, VideoToolbox decodes, AVPlayer presents and passes Dolby Atmos through;
  - HDR10, HDR10+, HLG, Dolby Vision profiles 5, 7 and 8; text, ASS and PGS subtitles that
    survive AirPlay and picture in picture;
  - request headers through `LoadOptions.httpHeaders` (documented for live playlists and DASH;
    confirm for a plain file link, with a user agent and a referrer);
  - needs iOS 18 or newer; installed as a Swift package;
  - LGPL-3.0 with an App Store exception; its FFmpeg is the LGPL build. Shipping it means showing
    its dependencies' notices, including the FFmpeg licence texts, pointing to the exact tag built
    against, keeping the FFmpeg frameworks dynamically embedded, and publishing any change made to
    the engine itself. Read `docs/licensing.md` in its repository before the first build that
    leaves the Mac.
- **Not for the App Store.** It is for the owner and friends: installed from Xcode, by Ad Hoc
  distribution, or through TestFlight's internal testers. See "Getting it onto devices".

## How ROVE is built today

```
shell/      Windows shell (Rust): window, WebView2, libmpv, the page's local service
ui/         The interface (React + TypeScript + Vite). Nearly all of ROVE's logic is here:
            addons, sources, tracking, lists, recommendations, assistant, settings, player UI
installer/  Windows Setup (Inno Setup)
tools/      Windows build, release and test scripts (PowerShell)
docs/       Audits, screenshots, signing notes, this note
FEATURES.md What ROVE does and what has been checked
CHANGELOG.md What changed, when
```

The page never touches the system directly. A shell gives it four things, and an Apple shell
has to give it the same four.

### 1. The bridge: `window.rove`

Injected before the page's scripts (`shell/src/bridge.js`):

```
window.rove = { platform: 'windows', send(message), subscribe(fn) }
```

`send` takes one of the `Outbound` messages and `subscribe` receives `Inbound` ones; both are
defined at the top of `ui/src/bridge.ts`. Outbound: `command`, `set`, `window`, `fullscreen`,
`pip`, `video`, `ready`, `open-external`, `open-external-player`, `log`, `close-ready`,
`now-playing`, `open-folder`, `install-update`. Inbound: `props`, `event`, `window`, `closing`,
`media-key`, `open`, `external-player`.

Without `window.rove` the page still runs (that is how `npm run dev` works in a browser), with
documents in `localStorage` and no player.

### 2. The local service: `/__api/…`

Served by the shell on the page's own origin (`shell/src/api.rs`):

- `POST /__api/fetch` with `{url, method?, headers?, body?, timeoutMs?}` answers
  `{status, url, headers, body}` or `{error}`. Every addon, tracker and metadata request goes
  through this, so the page is never limited by CORS. Text bodies only.
- `GET`, `PUT`, `DELETE /__api/store/<name>`: JSON documents (settings, history, addons, …).
  A missing document is 404; one that exists but cannot be read is 500, and the page then
  refuses to write over it (`ui/src/lib/native.ts`).
- `GET`, `PUT`, `DELETE /__api/secret/<name>`: the same, encrypted at rest. On Windows that is
  DPAPI; on Apple devices it should be the Keychain.
- `GET /__api/update/progress` answers `{selfUpdate: false}` on a build that does not install
  its own updates. An Apple build answers the same.

### 3. The player, spoken to in mpv's words

The page drives the player with mpv's vocabulary: `{t:'command', args:[…]}` and
`{t:'set', name, value}` out, `{t:'props', v:{…}}` and `{t:'event', name}` back.

- Commands the Windows shell accepts (`allowed_command` in `shell/src/main.rs`): `loadfile`
  (web addresses only, optional `start=`), `sub-add`, `audio-add`, `sub-remove`, `sub-reload`,
  `seek`, `stop`, `cycle`, `frame-step`, `frame-back-step`, `screenshot`, `playlist-next`,
  `playlist-clear`, `ao-reload`.
- Properties it may set (`SETTABLE`, same file): `pause`, `volume`, `mute`, `aid`, `sid`,
  `speed`, `audio-delay`, `sub-delay`, the `sub-*` style properties, `http-header-fields`,
  `user-agent`, `referrer`, `video-aspect-override`, `panscan`, `video-zoom`, `hwdec`, `af`,
  and a few more.
- Properties it follows (`OBSERVED` in `shell/src/mpv.rs`): `pause`, `time-pos`, `duration`,
  `paused-for-cache`, `cache-buffering-state`, `demuxer-cache-time`, `seeking`, `core-idle`,
  `idle-active`, `eof-reached`, `track-list`, `aid`, `sid`, `volume`, `mute`, `media-title`,
  `audio-delay`, `sub-delay`, `speed`, `current-ao`, `hwdec-current`, `video-params`,
  `chapter-list`.
- Events: `start-file`, `file-loaded`, `seek`, `playback-restart`, `end-file` (with a reason
  and, on failure, an error).

With mpv as the Apple engine this passes straight through. With AetherEngine the Apple shell
needs a small adapter that turns this vocabulary into the engine's calls and reports its state
back under the same property names. Keep the adapter in the shell, so the page stays the same
on both systems; where the engine has no equivalent (an audio filter, `hwdec`), ignore the
request and have the page hide that control by `window.rove.platform`.

### 4. A see-through page over the picture

The video is drawn by the player, under the page. While something plays the page asks for
`{t:'video', visible:true}` and the shell makes the web view's background transparent; the page
then draws only its controls. On Apple devices that is a non-opaque `WKWebView` over the
player's view.

## Things to settle early on the Mac

- **The page's origin.** On Windows it is `http://rove.localhost`. The banner and card trailers
  are YouTube embeds, and YouTube refuses an embed whose page has no ordinary web origin. Check
  that trailers still play from whatever origin the Apple shell serves the page on, before
  building on it.
- **Request bodies reaching the local service.** `/__api/fetch` and document writes are `POST`
  and `PUT` with a body. Confirm the bodies arrive whichever way the page is served (a custom
  scheme handler or a loopback server); if they do not, carry those calls over the message
  bridge instead.
- **Touch.** Nothing hovers on a phone: the poster previews, button tips and row arrows are
  pointer features. The layout is built for a wide window. Rows already scroll by touch.
- **Build-time keys.** `ui/.env.local` holds `VITE_TMDB_API_KEY` and `VITE_TRAKT_CLIENT_ID`. It
  is not in the repository and must never be committed; copy it to the Mac by hand.

## Suggested order

1. **Toolchain.** Xcode, Node 22, this repository. `cd ui && npm ci && npm run dev` should show
   the interface in a browser.
2. **One-day player test.** A bare iOS app with AetherEngine that plays, on a real iPhone, an
   HDR MKV from a real stream address that needs a user agent or other headers. Judge picture,
   HDR, sound, subtitles, seeking, and battery and heat over twenty minutes. If it falls short,
   repeat with MPVKit. Write down what was seen.
3. **The shell.** `apple/`: the web view with the bridge, the local service (documents on disk,
   secrets in the Keychain, requests through `URLSession`), and the player adapter. Goal: Home
   loads, a title opens, a source plays with the page's own controls over it.
4. **Touch layout** for iPhone, then iPad.
5. **Getting it onto devices** (below), then Apple TV as its own project.

## Getting it onto devices

- From Xcode with a free Apple account: the app runs for 7 days, then needs installing again.
- With the Apple Developer Program (99 USD a year): apps last a year; **Ad Hoc** builds install
  on up to 100 registered devices of each kind; **TestFlight internal testers** (people added to
  the team in App Store Connect) need no review. TestFlight's external testers do go through
  Apple's beta review.
- The App Store is not planned.

## House rules (they apply on the Mac too)

- Keep `FEATURES.md` and `CHANGELOG.md` current, and mark honestly what was seen working and
  what was not. A feature is checked when it has been seen on a device, not when the logs look
  right.
- No tool, assistant or model names in branches, commits, changelogs or documentation, and no
  attribution lines in commits.
- Commits use the GitHub no-reply address already set for this repository's owner, never a
  personal email address.
- Never commit `ui/.env.local`, signing keys, certificates, provisioning profiles or anything
  under a `*.local` name.
- Strand and other apps are references for features only: no code, artwork or wording from them.
- Do not change `shell/`, `installer/` or `tools/` from the Mac unless the change is needed by
  both systems; say so in the commit when it is.

## Open questions

- Whether AetherEngine plays plain file links with a custom user agent and referrer.
- What ROVE's own licence should be once an Apple build exists (the repository is GPL-3.0 today;
  the owner holds all of ROVE's own code).
- How a setup moves between a PC and a phone. Share-your-setup codes are being built on Windows
  and should work here unchanged, since they live in `ui/`.
