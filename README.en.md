# spw-folia — Folia lyric visualizer for Salt Player for Windows

Brings the [Folia](https://github.com/chthollyphile/folia-major) lyric visualizer into **Salt Player
for Windows (SPW)**: the `Folia` entry in the mini player's **More** menu opens a borderless,
fullscreen mode that runs Folia's **own** rendering code (all 15 lyric styles), driven by whatever
SPW is playing — plus a desktop transparent overlay, a frame-accurate Folia settings page and cover
colour theming.

[![Release](https://img.shields.io/github/v/release/azkbzxf/spw-folia)](https://github.com/azkbzxf/spw-folia/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)](#compatibility)
[![Site](https://img.shields.io/badge/promo%20site-azkbzxf.github.io%2Fspw--folia-ffb545)](https://azkbzxf.github.io/spw-folia/)

[中文](README.md) | **English**

<p align="center"><img src="docs/images/style-lumiere.jpg" width="92%" alt="The lumiere style: golden stardust and glowing lyrics"></p>

## Features

- **Real Folia, not a re-implementation** — the plugin embeds Folia 0.7.22's production OBS browser
  source output, so all 15 styles are Folia's original code: motion, glow, per-character timing,
  backgrounds and transitions match Folia pixel for pixel.
- **15 styles, one click away** — Sonnet · Tempera · Lumiere · Hanabi · Classic · Cadenza · Partita ·
  Fume · Tilt · Claddagh · Monet · Pendolo · Cappella · Diorama · Still. Check several of them into a
  random pool and each song gets a different style (no repeats back to back); the dice button on the
  playback bar rerolls on the spot.
- **Perfectly in sync with the player** — per-character lyrics, translation subtitles, play / pause /
  seek / speed, plus WASAPI loopback analysis that makes the visuals react to the music.
- **A playback bar you can actually use** — every button works: play / pause, previous / next,
  seeking, shuffle / repeat, and a queue panel you can click to jump around.
- **Settings page, 1:1 with Folia** — the "Lyric Style" window reuses Folia's own React components;
  the large preview on the left mirrors the player page **frame by frame**: the same same-origin
  iframe renderer, the same player-page config and the same real clock, including the transparent
  state; every slider is reflected live.
- **Custom fonts and subtitles** — import a font pack (`.ttf` / `.otf` / `.woff` / `.woff2`, up to
  50 MB each) or pick from system fonts; weight, size, auto-weight, overall opacity, subtitle style
  and background, upcoming-lyric blur and more are all adjustable.
- **Cover colour theming** — theme, background and accent colours derive from the current track's
  cover art and change as the song changes.
- **Desktop transparency overlay** — the round button panel at the bottom right of the fullscreen
  page toggles **transparent playback page**: the window becomes genuinely transparent and leaves
  only lyrics and effects composited over the desktop or other windows — ideal for streaming or OBS
  overlays. The second row, **mouse passthrough**, lets you keep working while the lyrics stay on
  screen, and **Ctrl+Alt+B** restores opacity at any time.
- **Transparency shortcuts** — two re-bindable actions in SPW's shortcut manager, `Toggle transparent
  playback page` (default **Ctrl+Alt+G**) and `Toggle transparent playback page + mouse passthrough`
  (default **Ctrl+Alt+Shift+G**). They act immediately while the window is open; enable the action's
  *global* switch to use it while the Folia window has focus.
- **Entries and multi-monitor** — open / close from the mini player's **More → Folia** or by
  right-clicking the tray icon; multi-monitor aware, **Alt + left-click** drags the window across
  screens, and the summon shortcut is configurable. An optional cover-coloured open transition is
  available (off by default).
- **No network, no uploads** — there is no HTTP server and no external request; data only travels
  between the plugin and its local helper process over stdin/stdout. Playback state, current track,
  lyrics and cover art are read, never written.

## Screenshots

<p align="center">
  <img src="docs/images/fullscreen-chrome.jpg" width="49%" alt="Fullscreen playback page with the gear that opens settings">
  <img src="docs/images/settings-ui.jpg" width="49%" alt="Folia settings page with a live renderer preview">
</p>
<p align="center">
  <img src="docs/images/transparent-background.jpg" width="49%" alt="Transparent playback page: lyrics composited onto the desktop">
  <img src="docs/images/style-grid.png" width="49%" alt="All 15 lyric styles at a glance">
</p>
<div align="center"><sub>Fullscreen page · Folia settings · Transparent playback page · 15 lyric styles (style grid shot on v0.3.x, still missing Hanabi)</sub></div>

> Want the whole tour at once? The [**promo site**](https://azkbzxf.github.io/spw-folia/) has the
> scrolling demo, every style at full size, and a
> [48-second recorded walkthrough](https://azkbzxf.github.io/spw-folia/#film) — all footage rendered
> by the plugin itself.

## Usage

1. Download `spw-folia-0.4.2.spmod` from [Releases](https://github.com/azkbzxf/spw-folia/releases);
   you can also subscribe on the [Steam Workshop](https://steamcommunity.com/sharedfiles/filedetails/?id=3825012802)
   (the Steam build installs itself after subscribing).
2. SPW → **Settings → Plugins / Workshop → Import plugin**, pick the file and enable it. Grant the
   **class-transform** ("hook") permission when asked — the menu hook needs it; also grant
   **key-bindings** ("shortcuts") for the transparency shortcuts (you can grant it later on the
   plugin's permission page and restart SPW).
3. Restart SPW when the plugin manager asks.
4. Play a song, open the mini player's **More** (…) menu → **Folia**.

The first run opens the Folia settings window; afterwards the visualizer opens directly (⚙ opens
settings, ESC closes settings first and then the window). Settings are stored in SPW's plugin data
directory.

To float the lyrics over the desktop: the round button panel at the bottom right of the fullscreen
page → turn on **transparent playback page**; turn on **mouse passthrough** as well when you want to
keep using the computer, and press **Ctrl+Alt+B** to restore opacity. Both toggles can be bound to
your own keys in SPW's shortcut manager (defaults **Ctrl+Alt+G** / **Ctrl+Alt+Shift+G**).

<p align="center"><img src="docs/images/menu-folia.png" width="240" alt="The Folia entry in SPW's More menu"></p>

## Compatibility

**Requires**: Windows 10/11 x64 · **Salt Player for Windows 1.19.0 or newer** (1.19.0 and 1.19.2 are
accepted) · WebView2 Runtime (bundled on Windows 11; install "Microsoft Edge WebView2 Runtime" on
Windows 10) · .NET Framework 4.8 (bundled since Windows 10 1903). The full dependency matrix and crash
troubleshooting live in [docs/runtime-requirements.md](docs/runtime-requirements.md).

**Permissions**: enabling the plugin asks for **class-transform** (menu hook) and **key-bindings**
(transparency shortcuts); if you miss one, grant it on the plugin's permission page and restart SPW.

### Known limitations

- **No smart-beat beat effects** — Folia's OBS interface does not expose beat events, and the beat
  model (~133 MB) lives in Folia's Electron main process, not in its web bundle. With smart beat off
  (Folia's default) every style renders exactly as it does in Folia. All inert settings controls have
  been removed; the list of what remains is in
  [docs/known-inert-settings.md](docs/known-inert-settings.md).
- **Windows only** — the helper depends on WebView2 and Windows WASAPI.
- **Follows SPW patch releases** — the menu hook resolves the host class names at runtime (built-in
  profiles for known builds, a structural scan of the host jar plus a per-version cache for unknown
  ones), so 1.19.x patch releases work without a plugin update; anything below 1.19.0 is refused
  explicitly and logged (see [docs/hook-target.md](docs/hook-target.md)).
- Read-only with respect to your library: playback state, current track, lyrics and cover art are
  read, never written.

## Versions

Currently **v0.4.2**. The `.spmod` and its SHA-256 checksum for every release are on
[GitHub Releases](https://github.com/azkbzxf/spw-folia/releases); per-version notes and acceptance
evidence are archived in [docs/archive/](docs/archive/) rather than repeated here.

The v0.3.1 artifact was accepted end to end on Windows 11 against a real SPW 1.19.0 **and 1.19.2**:
menu entry → fullscreen rendering, 0 page errors, 0 external network requests, a 16-minute soak,
persisted settings and no orphaned helper processes. v0.4.0 brings the style count to **15** (with
Hanabi) plus the random style pool, custom fonts and the tray entry. v0.4.1 turns the settings-page
preview into a frame-accurate mirror of the player page (real song/lyrics/background/transparency
plus the real playback clock) and removes the “preview text” option. v0.4.2 fixes three known
issues: word-by-word lyrics now use SPW's real per-cell timeline, 凝彩 (tempera) no longer covers the
whole screen in a transparent window, and a 「出现问题」 environment self-check with one-click
feedback was added (see [docs/logging-and-diagnostics.md](docs/logging-and-diagnostics.md)).

## Build from source

Toolchain: JDK 25, Gradle 9.8 (wrapper included), Kotlin 2.4.20, Node 24 + pnpm (settings UI), and
the Windows-bundled `csc.exe` (.NET Framework 4.8) for the native helper. No .NET SDK and no Android
SDK required.

```bat
:: 1) Plugin (Kotlin, via the official SPW workshop Gradle plugin)
cd spw-folia
gradlew.bat plugin          :: -> build/libs/plugin-dev.spw.folia-0.4.1.spmod

:: 2) Native helper (C# + WebView2)
cd ..\poc\webview\host
bash build.sh               :: -> build/spw-folia-host.exe (+ WebView2 dlls)

:: 3) Settings UI (React)
cd ..\..\settings-ui
pnpm install && pnpm build  :: -> dist/settings-ui.js

:: 4) Assemble the distributable .spmod (plugin classes + staged web bundle + native process + licenses)
bash packaging/build-package.sh     :: stages packaging/{web,native,licenses} + SHA256SUMS
python packaging/tools/assemble-release.py ^
    --spmod spw-folia/build/libs/plugin-dev.spw.folia-0.4.1.spmod ^
    --staging packaging --out dist/release --name spw-folia-0.4.2.spmod
```

The full pipeline, payload inventory, size budget and release checklist are in
[docs/release.md](docs/release.md).

## Documentation

[Architecture](docs/architecture.md) · [Protocol](docs/protocol.md) · [Native host](docs/host-app.md) ·
[Audio & timeline](docs/audio-timeline.md) · [Settings UI](docs/settings-ui-impl.md) ·
[Transparency mechanism](docs/live-transparency.md) · [Folia spec](docs/folia-spec/) ·
[Packaging & release](docs/release.md) · [Runtime requirements](docs/runtime-requirements.md) ·
[Licensing](docs/licensing.md)

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
- The Salt Player for Windows workshop plugin API, by Moriafly.
- [spw-island (Dynamic Lyrics Island for SPW)](https://github.com/gaboron/spw-island) — used as a
  behavioural reference only (GPL-3.0); no code was copied.
- Microsoft Edge WebView2 SDK, .NET Framework, Kotlin/Compose, React/Vite.

## License

AGPL-3.0-or-later. Not affiliated with Folia or Salt Player; this repository contains a derivative
work of Folia and is distributed in the hope that it will be useful, but without any warranty. See
[LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the source-offer notes in
[docs/licensing.md](docs/licensing.md).
