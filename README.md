# ROVE

A streaming app for Windows that plays from the Stremio addons you choose (for example
AIOMetadata for catalogs and AIOStreams for sources) and keeps your history with PublicMetaDB.
Built to feel like a native, polished media app: smooth, quiet, and fast to start.

![Home](docs/screenshots/home.jpg)

- What it does, and what is checked: [FEATURES.md](FEATURES.md)
- What changed, when: [CHANGELOG.md](CHANGELOG.md)

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

Checks: `npx vitest run` in `ui/`, `cargo test` in `shell/`, and
`tools\smoke.ps1` (starts the debug build muted with a sample stream, then closes it).

## Your data

Everything stays on your PC under `%LOCALAPPDATA%\ROVE`. Addon links and API keys are encrypted
for your Windows account. Network requests go only to your addons, TMDB (when you add a key),
PublicMetaDB (when you connect it) and the community skip-time services.
