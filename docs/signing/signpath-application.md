# SignPath Foundation application: prepared answers

The form is at https://signpath.org/apply. It asks for the applicant's own name and email and
has a human check, so the maintainer submits it. Everything about the project is below.

| Field | Answer |
|---|---|
| Project Name | ROVE |
| Repository URL | https://github.com/sicknett/rove |
| Homepage URL | https://github.com/sicknett/rove |
| Download URL | https://github.com/sicknett/rove/releases/latest |
| Privacy Policy URL | https://github.com/sicknett/rove/blob/main/PRIVACY.md |
| Wikipedia URL | (none) |
| Tagline | A streaming app for Windows that plays from your own Stremio addons and media servers, with mpv. |
| Category | Multimedia (or the closest offered) |
| Description | ROVE is a native Windows media player and library front end. It shows catalogs and plays streams from the Stremio-protocol addons and the Jellyfin, Emby or Plex servers the user adds, keeps watch history on the user's PC, and can sync it with a tracker the user connects (PublicMetaDB, Trakt, Simkl, MDBList). Playback is libmpv; the interface is a WebView2 page in a Rust shell. It ships no content and no sources of its own. |
| Reputation | See the note below: this is the weak point of the application today. |
| Maintainer Type | Individual |
| Build System | GitHub Actions (`.github/workflows/build.yml`, GitHub-hosted runners) |
| Primary Discovery Channel | Web search |

## Reputation

SignPath asks for "links or information showing that your project is widely used or trusted"
(media coverage, download statistics, GitHub insights, community discussions) and states that it
requires "a certain verifiable reputation". The repository was created on 2026-11-25 and has no
stars, downloads or coverage yet, so an application made now is likely to be declined. It is
better made once there is something to point at: release download counts, stars, a community
thread where people use it.

## What is already in place for their terms

- OSI licence (GPL-3.0), public repository, released builds.
- Builds from this repository on GitHub-hosted runners, with the one bundled upstream binary
  (libmpv) pinned by hash.
- "Code signing policy" section and team roles in the README; privacy policy linked.
- Product name and version set on the program file.

## Still to do before applying

- Two-factor sign-in on the maintainer's GitHub account (their rule for every team member).
- Show the privacy note during installation, and a switch for every request the app makes
  without being asked (the update check; TMDB lookups; skip-time lookups).
- Mention SignPath on the release page text once signing is granted.
