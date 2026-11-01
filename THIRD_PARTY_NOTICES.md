# Third-party notices

`spw-folia` is licensed **AGPL-3.0-or-later** and is a derivative work of **Folia** (AGPL-3.0).

This file covers the third-party components **used and redistributed** in the released plugin
(`.spmod`), then the components used at build time only. See [LICENSE](LICENSE) for the full
AGPL-3.0 text, [docs/licensing.md](docs/licensing.md) for the source offer, and
[`packaging/licenses/`](packaging/licenses/) for the notice texts that ship inside the plugin.

## Redistributed components

### Folia (`folia-major`) — AGPL-3.0

- Upstream: https://github.com/chthollyphile/folia-major (author: chthollyphile)
- Version: **0.7.22**
- Tag / commit: `v0.7.22` / `1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe`
- License: **GNU AGPL-3.0**. Copyright belongs to the Folia authors and contributors.
- Redistributed: the production web build of Folia, shipped as `web/` (`web/index.html`,
  `web/assets/`, all 15 lyric styles).
- What we changed: **nothing in the Folia assets**. `web/index.html` is the only patched file — the
  PWA service-worker registration tag and the manifest link are removed, because the service worker
  is not shipped. The patch is reproducible with `packaging/tools/stage-web.mjs`.
- Folia's own build scripts and source are not redistributed.

**Corresponding source.** Folia's source for the shipped build is the upstream repository at tag
`v0.7.22` / commit `1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe`, combined with our build recipe
(`packaging/tools/stage-web.mjs`), which documents exactly how the shipped subset is produced from
an upstream build. See [docs/licensing.md](docs/licensing.md) for the full written source offer
under AGPL-3.0 §6/§13.

**Why the combined work is AGPL-3.0.** The plugin redistributes Folia's web build and builds Folia
AGPL code into the settings UI from a local Folia source checkout, so the plugin, the settings UI
and the native host helper are all distributed under AGPL-3.0-or-later. Folia's license text is
reproduced at [`packaging/licenses/AGPL-3.0.txt`](packaging/licenses/AGPL-3.0.txt).

### Microsoft Edge WebView2 SDK

- Upstream: https://learn.microsoft.com/microsoft-edge/webview2/
- License: Microsoft WebView2 SDK license (BSD-3-Clause style); full texts in
  [`packaging/licenses/WebView2-SDK-LICENSE.txt`](packaging/licenses/WebView2-SDK-LICENSE.txt) and
  [`packaging/licenses/WebView2-SDK-NOTICE.txt`](packaging/licenses/WebView2-SDK-NOTICE.txt).
- Redistributed files (from the `Microsoft.Web.WebView2` NuGet package, in `native/`):
  `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll` and
  `WebView2Loader.dll`.
- The **WebView2 Runtime** itself is not redistributed. It is a system component, preinstalled on
  Windows 11 and otherwise installed by the user.

## Build-time only (not redistributed)

### Salt Player for Windows workshop plugin API

- Upstream: https://github.com/Moriafly/spw-workshop-api (author: Moriafly)
- Used: the Gradle plugin `com.xuncorp.spw.workshop` and the API artifact
  `com.github.Moriafly.spw-workshop-api:spw-workshop-api:0.1.0-dev23`, both resolved from JitPack.
- Declared as `compileOnly` plus `kapt` in `spw-folia/build.gradle.kts`: no API classes are packaged
  into the `.spmod`; Salt Player provides them at runtime.
- License: as published by the upstream project; not restated here because nothing is
  redistributed. The plugin targets Salt Player for Windows 1.19.x.

### PF4J 3.12.0

- Upstream: https://github.com/pf4j/pf4j — Apache-2.0.
- Used for the `@Extension` annotation and kapt extension-index generation (`compileOnly` plus
  `kapt`). The PF4J runtime is provided by Salt Player and is not packaged.

### Kotlin, Compose, Gradle

- Kotlin (JVM plugin 2.4.20) and its standard library, Compose Multiplatform 1.12.1
  (`runtime-desktop`, `foundation-desktop`, `ui-desktop`): Apache-2.0.
- All of the above are `compileOnly`: Salt Player owns the Compose runtime and the Kotlin stdlib at
  runtime, and nothing is packaged into `classes/` or `lib/` — the released `.spmod` has no `lib/`
  directory.
- The Gradle wrapper (Apache-2.0) is used to build only.

### .NET Framework 4.8

- The native helper is compiled with the in-box `csc.exe` and links only framework assemblies
  (`System.dll`, `System.Core.dll`, `System.Windows.Forms.dll`, `System.Drawing.dll`,
  `System.Web.Extensions.dll`). No framework binaries are shipped; .NET Framework 4.8 is an OS
  component.

### Settings UI npm dependencies

The settings UI (`poc/settings-ui/`, shipped as `web/settings/`) is built with Vite from both its own
source and Folia's React components, and resolves Folia's bare imports against this project's
`node_modules` (`dedupe` in `poc/settings-ui/vite.config.ts`). Declared versions are pinned in
[`poc/settings-ui/pnpm-lock.yaml`](poc/settings-ui/pnpm-lock.yaml) and listed in
[`poc/settings-ui/package.json`](poc/settings-ui/package.json). Licenses of that dependency set:

- **MIT**: React and React DOM, `@react-three/fiber`, `@react-three/drei`,
  `@react-three/postprocessing`, `three`, `pixi.js`, `twgl.js`, `@chenglou/pretext`,
  `framer-motion`, `i18next`, `react-i18next`, `i18next-browser-languagedetector`,
  `react-colorful`, `react-window`, `zustand`, `wanakana`, `blueimp-md5`, `opencc-js`.
- **Apache-2.0**: `dexie`.
- **ISC**: `lucide-react`.

Build-only tooling (`vite`, `typescript`, `tailwindcss`, `@tailwindcss/vite`,
`@vitejs/plugin-react`, `puppeteer-core`, the `@types/*` packages) is not redistributed. Neither are
the Folia React components the settings UI imports from a local Folia checkout at build time — those
are covered by the Folia entry above.

## Not redistributed

- **Folia model weights** (`beat_this-wgsl.bin`, `htdemucs-wgsl.bin`): these live in the Folia
  desktop installation only. No model weights are shipped in this repository or in the `.spmod`.
- **Fonts**: no font files are bundled — the release artifact contains no `.woff`/`.woff2`/`.ttf`/
  `.otf` file. The UI uses the user's system fonts. Do not bundle commercial fonts.

## Acknowledgements

These projects informed our design but are **not** part of the distributed plugin and contributed
no code:

- [spw-island (Dynamic Lyrics Island for SPW)](https://github.com/gaboron/spw-island) by gaboron,
  **GPL-3.0** — used as a **behavioural reference only**, for patterns a workshop plugin can use
  (spawning a native helper, shaped-region click-through). No source code was copied, and spw-island
  is not distributed with spw-folia.

## Original code in this repository

Everything not listed above is original to this project and licensed **AGPL-3.0-or-later**, except
the WASAPI analyzer noted below:

- the Kotlin plugin (`spw-folia/`);
- the native host helper (`poc/webview/host/`, C#);
- the settings UI (`poc/settings-ui/`), apart from the Folia components it imports at build time.

**WASAPI loopback analyzer.** The native host compiles in an original, clean-room WASAPI loopback +
FFT analyzer (source: `poc/webview/host/audio/`, with a copy under `poc/audio/native/`). Those files
carry `SPDX-License-Identifier: MIT` headers and are **MIT licensed** — Copyright (C) 2026 the
spw-folia contributors, full text in
[`packaging/licenses/AUDIO-MIT.txt`](packaging/licenses/AUDIO-MIT.txt), which ships inside the
`.spmod` as `licenses/AUDIO-MIT.txt`. MIT is compatible with AGPL-3.0, and the compiled helper
executable is distributed under AGPL-3.0 as a whole. It uses no third-party audio library — no
NAudio, no FFTW. This is our own code, not a third-party component: the MIT notice is kept because
the sources and their shipped notice say so, not because anything external is bundled.
