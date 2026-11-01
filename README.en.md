# spw-folia — a Folia lyric visualizer plugin for Salt Player for Windows

Brings the [Folia](https://github.com/chthollyphile/folia-major) lyric visualizer into **Salt Player
for Windows (SPW)**: the `Folia` entry in the mini player's **More** menu opens a borderless,
fullscreen mode that shows lyrics with Folia's own 15 lyric styles, driven by whatever is playing —
and you can also float the lyrics transparently over the desktop.

[![Release](https://img.shields.io/github/v/release/azkbzxf/spw-folia)](https://github.com/azkbzxf/spw-folia/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)](#compatibility)
[![Site](https://img.shields.io/badge/promo%20site-azkbzxf.github.io%2Fspw--folia-ffb545)](https://azkbzxf.github.io/spw-folia/)

[中文](README.md) | **English**

<p align="center"><img src="docs/images/style-lumiere.jpg" width="92%" alt="The Lumiere style: golden stardust and glowing lyrics"></p>

## Features

- **It runs Folia itself, not an imitation** — the plugin embeds the browser-side rendering build of
  Folia 0.7.22, so the animation, glow, per-character timing and transitions of all 15 styles come
  from Folia's own code.
- **15 styles, a click away** — Sonnet · Tempera · Lumiere · Hanabi · Luminous · Mindscape ·
  Partita · Fume · Tilt · Claddagh · Monet · Pendolo · Cappella · Diorama · Still. Tick a few of
  them into a random pool and each song gets a different style without repeating back to back; the
  dice button on the playback bar rerolls on the spot.
- **It follows the music** — per-character lyrics and translation subtitles stay in sync through
  play / pause / seek / speed changes, and the picture also reacts to how loud the music is.
- **A playback bar you can actually click** — play / pause, previous / next, dragging the progress
  bar, shuffle / repeat, plus a play queue you can click to switch tracks.
- **The settings page is Folia's own UI** — it reuses Folia's components, and the large preview on
  the left shows the real song, lyrics, background and transparency state; drag any slider and you
  see the result immediately.
- **Custom fonts and subtitles** — import a font pack (`.ttf` / `.otf` / `.woff` / `.woff2`, up to
  50 MB each) or pick from the system fonts; weight, size, auto-weight, overall opacity, subtitle
  style and background, upcoming-lyric blur and more are all adjustable.
- **Cover colour theming** — theme, background and accent colours derive from the current track's
  cover art and change as the song changes.
- **Transparent desktop overlay** — the round button panel at the bottom right of the fullscreen
  page turns on **transparent playback page**: only lyrics and effects stay on top of the desktop or
  other windows, which suits live streaming / OBS overlays. A second row, **mouse passthrough**,
  appears with it so you can keep using the computer while the lyrics stay put. **Ctrl+Alt+B**
  restores opacity at any time.
- **Re-bindable shortcuts** — SPW's shortcut manager lists three actions: `Open / close Folia
  lyrics` (default **Ctrl+Alt+F**), `Transparent playback page: on / off` (default **Ctrl+Alt+G**)
  and `Transparent playback page + mouse passthrough: on / off` (default **Ctrl+Alt+Shift+G**).
  Turn on the action's **global** switch to use it while the window has focus.
- **Entries wherever you need them** — open / close from the mini player's **More → Folia** or by
  right-clicking the tray icon after minimising; the window opens on the screen where the SPW
  window is, and **Alt + left-click** drags it to another screen and fills it. An optional
  cover-coloured fade-in on opening is available (off by default, see SPW's **Mod management →
  Config**).
- **Something to go on when it breaks** — SPW's **Mod management → Config → Support & feedback →
  Something's wrong** (the life-buoy button at the top right of the playback page does the same)
  checks .NET / WebView2 / plugin files / permissions / writable directories item by item and names
  whichever is missing; when the environment is complete it opens a feedback page pre-filled with
  environment info and logs, with the log file selected. See
  [docs/logging-and-diagnostics.md](docs/logging-and-diagnostics.md).
- **No network, no uploads** — no network requests at runtime; data only travels between the plugin
  and its local helper process. Only playback state and the current track / lyrics / cover art are
  read; your music library is never written to.

## Screenshots

<p align="center">
  <img src="docs/images/fullscreen-chrome.jpg" width="49%" alt="Fullscreen playback page with the gear that opens settings">
  <img src="docs/images/settings-ui.jpg" width="49%" alt="Folia settings page with a live renderer preview">
</p>
<p align="center">
  <img src="docs/images/transparent-background.jpg" width="49%" alt="Transparent playback page: lyrics composited onto the desktop">
  <img src="docs/images/style-grid.png" width="49%" alt="All lyric styles at a glance">
</p>
<div align="center"><sub>Fullscreen page · Folia settings · Transparent playback page · Lyric styles (style grid shot on v0.3.x, still missing Hanabi)</sub></div>

> Want the whole tour at once? The [**promo site**](https://azkbzxf.github.io/spw-folia/) has the
> scrolling demo, every style at full size, and a
> [48-second recorded walkthrough](https://azkbzxf.github.io/spw-folia/#film) — all footage rendered
> by the plugin itself.

## Install & usage

1. Download the latest `.spmod` package from
   [Releases](https://github.com/azkbzxf/spw-folia/releases); you can also subscribe on the
   [Steam Workshop](https://steamcommunity.com/sharedfiles/filedetails/?id=3825012802) (the Steam
   build installs itself after subscribing).
2. SPW → **Settings → Plugins / Workshop → Import plugin**, pick the downloaded `.spmod` and enable
   it, then grant the three permissions listed under **Permissions** below when asked (a missed one
   can also be granted later on the plugin's permission page, followed by an SPW restart).
3. Restart SPW when the plugin manager asks.
4. Play a song, open the mini player's **More** (…) menu → **Folia**.

<p align="center"><img src="docs/images/menu-folia.png" width="240" alt="The Folia entry in SPW's More menu"></p>

**Inside the playback page**: ⚙ at the top right or **F1** opens / closes settings; **ESC** closes
settings first and then the window. Settings are stored in SPW's plugin data directory.

**To float the lyrics over the desktop**: the round button panel at the bottom right of the
fullscreen page → turn on **transparent playback page**; turn on **mouse passthrough** as well when
you want to keep using the computer. **Ctrl+Alt+B** restores opacity, and both toggles can be bound
to your own keys (see Features).

## Compatibility

**Requires**: Windows 10/11 x64 · **Salt Player for Windows 1.19.0 or newer** (confirmed on 1.19.0,
1.19.2 and 1.19.3) · WebView2 Runtime (bundled on Windows 11; install "Microsoft Edge WebView2
Runtime" on Windows 10) · .NET Framework 4.8 (bundled since Windows 10 1903). The full dependency
matrix and crash troubleshooting live in [docs/runtime-requirements.md](docs/runtime-requirements.md).

**Permissions**:

| Permission | Purpose | Without it |
| --- | --- | --- |
| `class-transform` | Insert the Folia entry into the **More** menu | No Folia in the menu |
| `library-read` | Read the current track's cover art and lyrics | Nothing to render or colour from |
| `key-bindings` | Register the summon and transparency shortcuts | Everything else works, just no shortcuts |

### Known limitations

- **No "smart beat" beat effects** — beat detection runs in Folia's desktop main process, while the
  plugin uses its browser-side rendering part and therefore gets no beat events. Effects that depend
  on beats (push-in on the beat, ripples, the Pendolo drum head, Hanabi blooming on the beat, etc.)
  do not trigger; a style's own animation is unaffected. All controls that would have no effect have
  been removed from the settings page — for what remains see
  [docs/known-inert-settings.md](docs/known-inert-settings.md).
- **Windows only** — the helper process depends on WebView2 and the Windows audio interfaces.
- **Transparency is colour keying, not an alpha channel** — what shows through is the desktop or
  other windows, so it is not suitable as a transparent source for OBS (for an OBS scene, use
  Folia's browser source or window capture directly). The Monet style and light-theme Lumiere
  contain large areas that cannot be keyed out, so turning one of them on turns transparency off
  automatically.
- **The window follows SPW** — the fullscreen window opens on the screen where the SPW window is;
  use **Alt + left-click** to drag it to another screen and fill that one.
- **It follows SPW versions** — the host class names for the menu hook are resolved at runtime:
  known versions hit directly, unknown ones are cached after scanning the structure of the host jar,
  so a renamed SPW build usually does not need a plugin update — but if the host restructures the
  flyout itself, a re-adapter is still needed. Anything below `1.19.0` is explicitly refused and
  logged (see [docs/hook-target.md](docs/hook-target.md)).
- Only playback state and the current track / lyrics / cover art are read; your music library is
  never written to.

## Versions

Currently **v0.4.6**. The install package, SHA-256 checksum and release notes for every version are
on [GitHub Releases](https://github.com/azkbzxf/spw-folia/releases).

## Build from source

Toolchain: JDK 25, Gradle 9.8 (wrapper included), Kotlin 2.4.20, Node 24 + pnpm (settings UI), and
the Windows-bundled `csc.exe` (.NET Framework 4.8) for the native helper. No .NET SDK and no Android
SDK required. Packaging also needs the browser-side build of upstream Folia 0.7.22 under
`poc/webview/dist/dist`.

```bat
:: 1) Plugin (Kotlin, via the official SPW workshop Gradle plugin)
cd spw-folia
gradlew.bat plugin          :: -> build/libs/plugin-dev.spw.folia-0.4.6.spmod

:: 2) Native helper (C# + WebView2)
cd ..\poc\webview\host
bash build.sh               :: -> build/spw-folia-host.exe (+ WebView2 dlls)

:: 3) Settings UI (React)
cd ..\..\settings-ui
pnpm install && pnpm build  :: -> dist/settings-ui.js

:: 4) Assemble the distributable .spmod (plugin classes + staged web bundle + native process + licenses)
bash packaging/build-package.sh     :: stages packaging/{web,native,licenses} + SHA256SUMS
python packaging/tools/assemble-release.py ^
    --spmod spw-folia/build/libs/plugin-dev.spw.folia-0.4.6.spmod ^
    --staging packaging --out dist/release --name spw-folia-0.4.6.spmod
```

The full pipeline, payload inventory, size budget and release checklist are in
[docs/release.md](docs/release.md).

## Documentation

[Architecture](docs/architecture.md) · [Protocol](docs/protocol.md) · [Native host](docs/host-app.md) ·
[Audio & timeline](docs/audio-timeline.md) · [Settings UI](docs/settings-ui-impl.md) ·
[Transparency mechanism](docs/live-transparency.md) · [Folia spec](docs/folia-spec/) ·
[Packaging & release](docs/release.md) · [Runtime requirements](docs/runtime-requirements.md) ·
[Logging & diagnostics](docs/logging-and-diagnostics.md) · [Licensing](docs/licensing.md)

## Links & feedback

- [GitHub repository](https://github.com/azkbzxf/spw-folia) — source, docs,
  [Releases](https://github.com/azkbzxf/spw-folia/releases) and
  [Issues](https://github.com/azkbzxf/spw-folia/issues).
- [Promo site](https://azkbzxf.github.io/spw-folia/) — scrolling demo, every style at full size and
  the 48-second recorded walkthrough.
- Community group (QQ): **1075038382**.
- When reporting a problem, please include your SPW version, plugin version and steps to reproduce.

## Credits

- [Folia](https://github.com/chthollyphile/folia-major) by chthollyphile (AGPL-3.0) — the whole
  visualizer, settings UI and web bundle come from Folia's work (v0.7.22).
- The [Salt Player for Windows](https://saltplayer.com/) workshop plugin API, by Moriafly.
- [spw-island (Dynamic Lyrics Island for SPW)](https://github.com/gaboron/spw-island) — used as a
  behavioural reference only (GPL-3.0); no code was copied.
- Microsoft Edge WebView2 SDK, .NET Framework, Kotlin/Compose, React/Vite.

## License

AGPL-3.0-or-later. Not affiliated with Folia or Salt Player; this repository contains a derivative
work of Folia and is distributed in the hope that it will be useful, but without any warranty. See
[LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the source-offer notes in
[docs/licensing.md](docs/licensing.md).
