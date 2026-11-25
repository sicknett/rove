# ROVE

A streaming app for Windows that plays from the Stremio addons and media servers you choose (for
example AIOMetadata for catalogs, AIOStreams for sources, or your own Jellyfin or Plex) and keeps
your history with the tracker you pick: PublicMetaDB, Trakt, Simkl or MDBList. Built to feel like
a native, polished media app: smooth, quiet, and fast to start.

ROVE plays what your own addons and servers provide. It includes no content and no sources.

![Home](docs/screenshots/home.jpg)

- What it does, and what is checked: [FEATURES.md](FEATURES.md)
- What changed, when: [CHANGELOG.md](CHANGELOG.md)

## Installing

Run `ROVE-Setup-<version>.exe`. It installs for your Windows account only (no administrator
prompt) into `%LOCALAPPDATA%\Programs\ROVE`, adds ROVE to the Start menu (and the desktop if you
tick it), and appears in Settings → Apps for uninstalling. Running a newer Setup over an
installed ROVE updates it and keeps everything you set up; close ROVE first.

The installer is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC":
choose **More info → Run anyway**. ROVE needs Microsoft Edge WebView2, which Windows 11 and
current Windows 10 already have; Setup says so and opens Microsoft's download page if it is
missing.

Uninstalling asks whether to also remove your profiles, history, addons and sign-ins; by default
they are kept for a later install.

### Updates

ROVE looks for a new release when it starts, and Settings → About has **Check for updates**.
In the current builds, which are not code-signed yet, the button opens the download page: close
ROVE, run the Setup you download, and everything you set up stays in place.

Code-signed builds can install the update themselves (the `self-update` build option): the app
downloads the Setup, checks it against a release signature made with a key only the publisher
holds (`shell/src/update.rs`), installs and reopens. That path is off for unsigned builds because
Windows Defender treats an unsigned program that fetches and runs an installer as malware.

## How it is put together

```
┌──────────────────────── ROVE window (Rust: tao + wry) ────────────────────────┐
│  WebView2, transparent: the whole interface (React + TypeScript, ui/)          │
│      ▲ JSON messages (player commands, window actions, media keys)             │
│      │ local service at rove.localhost/__api (HTTP, encrypted storage)          │
│  child window: mpv draws the video with Direct3D 11 (gpu-next, libplacebo)     │
└────────────────────────────────────────────────────────────────────────────────┘
```

- `shell/` — the Rust app: window, mpv (loaded at runtime), the bridge, picture in picture,
  Windows media controls, DPAPI-encrypted secrets, save-before-close.
- `ui/` — the interface: addons (Stremio protocol), TMDB, PublicMetaDB sync, Continue Watching,
  source choice, skip segments, track choice, every screen.
- `assets/brand/` — the ROVE logo, icon and wallpaper. `tools/` — packaging and checks.

## Building

Needs Windows 10 or 11, Rust (MSVC), Node 20+, and the Visual Studio C++ build tools. Put
`libmpv-2.dll` (mpv 0.40 or newer) in `vendor/mpv/`.

```powershell
cd ui; npm install; npm run build; cd ..
cd shell; cargo build --release; cd ..
powershell -ExecutionPolicy Bypass -File tools\package.ps1   # dist\ROVE plus Start menu shortcut
```

The installer: install Inno Setup 6 (`winget install JRSoftware.InnoSetup`), then

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-installer.ps1   # dist\ROVE-Setup-<version>.exe
```

It builds everything, makes the wizard art from the brand assets, and compiles
`installer\rove.iss`. The version comes from `shell\Cargo.toml`. Optional build-time settings go
in `ui\.env.local` (never committed): `VITE_TMDB_API_KEY`, `VITE_TRAKT_CLIENT_ID`,
`VITE_SIMKL_CLIENT_ID`.

A release for the Update button: raise the version in `shell\Cargo.toml`, then

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-release.ps1 -Notes "What changed" -Publish
```

It builds the Setup, signs it with the release key (`%USERPROFILE%\.rove\update-signing-key.pem`,
never in the repository) and publishes both files as a GitHub release. A fork that publishes its
own releases needs its own key pair, with the public half in `shell/src/update.rs`.

Checks: `npx vitest run` in `ui/`, `cargo test` in `shell/`, and
`tools\smoke.ps1` (starts the debug build muted with a sample stream, then closes it).

## Your data

Everything stays on your PC under `%LOCALAPPDATA%\ROVE`. Addon links and API keys are encrypted
for your Windows account. Network requests go only to your addons, TMDB, the tracker you
connect (PublicMetaDB, Trakt, Simkl or MDBList), the media servers you add, and the community
skip-time services.

Optional pieces send only what they need, and only when you switch them on: an AI assistant
(your request text, and titles from your history for the "For you" row, to the provider whose key
you entered) and list imports (requests to Trakt, MDBList or your server). Details:
[PRIVACY.md](PRIVACY.md).

## Credits and notices

- The built-in Home is [Kaptain's Collection](https://kaptain.stream/), a community-made set of
  rows. All credit for its curation goes to Kaptain.
- Playback is [mpv](https://mpv.io/) (libmpv). The window and page run on tao, wry and Microsoft
  Edge WebView2.
- This product uses the TMDB API but is not endorsed or certified by TMDB.
- This product uses the Trakt API but is not endorsed or certified by Trakt.
- Skip times come from TheIntroDB, IntroDB, PublicMetaDB and AniSkip community data.

## Code signing policy

Releases are built from this repository by the workflow in `.github/workflows/build.yml` on
GitHub-hosted machines; nothing built anywhere else is signed. The bundled player library
(`libmpv-2.dll`) is an unmodified upstream build of [mpv](https://mpv.io/), fetched by a pinned
hash.

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org). *(Applied for; releases are unsigned until it is
granted.)*

Team roles:

- Committers and reviewers: [sicknett](https://github.com/sicknett)
- Approvers (each release's signing request): [sicknett](https://github.com/sicknett)

Privacy: ROVE has no server of its own and collects nothing. It contacts only the services you
add or switch on, and each of those can be switched off in Settings; the details are in
[PRIVACY.md](PRIVACY.md).

## Licence

ROVE is free software under the [GNU General Public License v3.0](LICENSE) or later.
