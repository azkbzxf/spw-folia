# spw-folia — packaging & release pipeline

Status: **complete** (task-8). `packaging/` holds the exact payload of the final `.spmod`; the
assembly script, checksums, size budget and a scripted packaged-layout acceptance test are included.

**Version state (read this first):** the last **published** release is **v0.4.13** (GitHub Releases,
2026-11-03). Before it, v0.4.6 (2026-10-30) was the last published one; everything in between —
v0.4.6.1, v0.4.7, v0.4.8, v0.4.9, v0.4.10, v0.4.11 and v0.4.12 — was built and tested locally only
and was **never published**, so their changes ship inside v0.4.13. Do not point users at the tags of
those intermediate versions.

Last verified: 2026-11-03 (v0.4.13 assembled from a fresh `packaging/` staging and gated with
`verify-all.mjs` → 10/10). The v0.4.5/v0.4.6 bytes, entry counts and sha256 below were recomputed
from the actual downloaded assets, not copied from notes. Payload numbers quoted for the host exe
(`spw-folia-host.exe` 164,864 B) and WebView2 150.0.4078.83 are the v0.4.5/v0.4.6 measurements and
still hold (v0.4.13 did not touch `native/`).

## 1. What ships

```
packaging/
  web/                         # -> .spmod/web/            (the page the host loads offline)
    index.html                 #    Folia OBS browser-source entry (PWA tags removed)
    assets/…                   #    complete Folia web chunk graph incl. every lazy per-style chunk
    preview.html               #    generated: live-preview iframe entry (patched index.html + preview shim)
    _host/preview-shim.js      #    generated: child-document shim that stubs EventSource for the preview
    settings/settings-ui.js    # -> injected settings island (task-5 build)
    settings/styles/           #    inlined CSS is in the JS; these are extra assets
    settings/thumbs/*.jpg      #    real Folia style thumbnails (14 staged as of v0.3.0; 15 with 花火)
    _host/shim.js, overlay.js  #    audit copies of the scripts embedded in the exe
  native/                      # -> .spmod/native/ (plugin resolveHelper also accepts lib/)
    spw-folia-host.exe         #    C# .NET Framework 4.8 helper (164,864 B in v0.4.5/v0.4.6)
    spw-folia-host.exe.config  #    PerMonitorV2 DPI + supportedRuntime v4.8
    Microsoft.Web.WebView2.Core.dll
    Microsoft.Web.WebView2.WinForms.dll
    WebView2Loader.dll
  licenses/                    # -> .spmod/licenses/
    AGPL-3.0.txt               #    full AGPL text (Folia + our code)
    NOTICE.md / SOURCE-OFFER.md / THIRD-PARTY.md
    AUDIO-MIT.txt              #    WASAPI analyzer (MIT)
    WebView2-SDK-LICENSE.txt / WebView2-SDK-NOTICE.txt
  tools/                       # build + verification tooling (never shipped)
    stage-web.mjs              # complete-dist staging (all chunks; SW/PWA excluded, guarded; settings dedupe)
    apply-image-overrides.mjs  # overlay packaging/image-overrides/ onto the staged web tree
    make-image-overrides.py    # regenerate the overrides from the upstream dist (needs Pillow)
    size-report.mjs            # size budget + top files
    verify-layout.mjs          # packaged end-to-end acceptance test
  image-overrides/             # committed size-optimized copies of upstream images (never shipped as a tree)
    MANIFEST.md
    assets/…                   # 256-colour palette PNG / q88 JPEG, same names+formats as upstream
    preview/…                  # the two generated preview covers
  testdata/default-settings.json  # settings tree fixture for the smoke test
  web-stage-report.json        # what was staged/excluded (audit)
  size-report.json             # size budget result
  SHA256SUMS.txt               # sha256 of every shipped file
  out/                         # verification evidence (screenshots, reports, fps log)
```

Payload of the last published artifact (**v0.4.6**), measured directly from the downloaded
`spw-folia-0.4.6.spmod` (uncompressed sizes inside the zip):

| area | files | size |
| --- | --- | --- |
| `web/` (complete Folia dist + settings island + 2 host-script copies) | 3,820 | 24.90 MiB (26,112,116 B) |
| `native/` (exe 164,864 B + config + 3 dlls) | 5 | 1.05 MiB (1,097,142 B) |
| `licenses/` | 7 | 0.05 MiB (49,370 B) |
| `classes/` (Gradle-built plugin classes + metadata JSONs) | 80 | 0.60 MiB (626,269 B) |
| **total** | **3,912** | **26.59 MiB** (27,884,897 B uncompressed) |

The shipped `.spmod` compresses that to **12,476,192 B (11.90 MiB)**; the v0.4.5 artifact was
**12,227,007 B** with the same `web/` and `native/` bytes (only `classes/` differed — 62 files /
493,078 B). The staging tree that feeds `assemble-release.py` is uncompressed and text-heavy, so it
runs over the historical 25 MB staging guard while the artifact users download does not; treat
`packaging/size-report.json`'s `budgetMB` as a rough staging-bloat guard, not an artifact limit.
The size growth versus v0.3.0 comes from upstream Folia 0.7.22 (19.54 → 20.01 MB of `assets/`) and
the settings island pulling the whole visualizer registry (1,950 files in `settings/assets`); two
extra passes compensate ~7.3 MB: **settings-asset dedupe** (29 files / 4.00 MB shared with
`web/assets/` are replaced by `/assets/…` references, see below) and **image overrides**
(4.67 MB → 1.39 MB of illustrations/avatars/covers).

The shipped web tree is the **complete** Folia production dist (every lazy chunk included), because
Folia dynamic-imports per-style renderers on demand (`assets/VisualizerTempera-*.js`, …). An earlier
subset built from the cold-start offline closure caused a black window on non-default styles
(`Failed to fetch dynamically imported module`), caught by task-13. `packaging/tools/stage-web.mjs`
now copies the whole `poc/webview/dist/dist` tree and hard-fails if no per-style lazy chunk is present.
Excluded only: the PWA/service-worker trio (`registerSW.js`, `sw.js`, `workbox-*`, `manifest.webmanifest`;
the registration tag is removed from `index.html`) and local `.bak` backups. It also generates
`preview.html` + `_host/preview-shim.js` (the settings live-preview iframe) and performs the
settings-asset dedupe described above.

## 2. Rebuild the package

Prerequisites (all already produced by the other tasks; rebuild only when an input changed):

```bash
cd D:/输出目录/dsh2
bash poc/webview/host/build.sh          # -> poc/webview/host/build/  (host exe + dlls)
cd poc/settings-ui && pnpm build && cd ../..   # -> poc/settings-ui/dist/ (settings-ui.js + thumbs)
```

Then assemble:

```bash
bash packaging/build-package.sh
```

The script (idempotent, ~20 s) does: stage-web → image overrides → stage native → stage licenses
(copies AGPL from `work/folia/folia-major-main/LICENSE`, extracts WebView2 `LICENSE.txt`/`NOTICE.txt`
from the NuGet package) → `size-report.json` → `SHA256SUMS.txt`. It fails loudly if an input is
missing; stale image overrides are reported as warnings (they only cover files that still exist).

Staging rule of record: `packaging/tools/stage-web.mjs` copies the **whole**
`poc/webview/dist/dist` tree (see §1) instead of a cold-start closure, patches `index.html`
(removes the PWA service-worker `<script>` and `manifest` link), generates `preview.html` +
`_host/preview-shim.js`, copies the settings island and embedded-script audit copies, and dedupes
the settings assets whose bytes match `web/assets/` (rewriting those URLs to `/assets/…`; the host
consequently injects the settings island from the bundle origin so a root-absolute `/assets/` path
resolves — see `HostForm.cs` `settingsInsideBundle` branch). `apply-image-overrides.mjs` then
replaces the heavy illustrations/covers with the committed `packaging/image-overrides/` variants.
If the Folia dist changes, re-run `python packaging/tools/make-image-overrides.py` (needs Pillow)
and re-stage.

## 3. Assembling the final `.spmod`

The Zig/`spw-folia` plugin project (task-1/task-7, owner hook-poc) produces the SPW metadata and
the JVM side. This packaging tree supplies only the payload. Mapping:

| packaging | `.spmod` (unpacked plugin dir) |
| --- | --- |
| `packaging/native/*` | `lib/` (next to the plugin jar/metadata; `WebView2Loader.dll` must stay beside the exe) |
| `packaging/web/*` | `web/` |
| `packaging/licenses/*` | `licenses/` |

So the installed plugin directory looks like:

```
%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia\
  enabled.txt
  permissions.json
  <plugin metadata + jar>        # from spw-folia/ project (not staged here)
  lib\spw-folia-host.exe
  lib\spw-folia-host.exe.config
  lib\Microsoft.Web.WebView2.Core.dll
  lib\Microsoft.Web.WebView2.WinForms.dll
  lib\WebView2Loader.dll
  web\index.html
  web\assets\…
  web\settings\settings-ui.js
  licenses\…
```

Do **not** ship `packaging/tools/`, `packaging/out/`, `packaging/testdata/` or any reports inside the
`.spmod`; they are build/audit artifacts only.

Scripted assembly (Lead-owned, `docs/protocol.md` order-independent):

```bash
cd spw-folia && ./gradlew.bat plugin        # 1. plugin classes/ (+ lib/ if any runtime deps)
cd .. && bash packaging/build-package.sh     # 2. re-stage web/native/licenses + checksums
python packaging/tools/assemble-release.py --spmod spw-folia/build/libs/plugin-dev.spw.folia-<version>.spmod --staging packaging --out dist/release --name spw-folia-<version>.spmod  # 3. merge into dist/release
node packaging/tools/verify-layout.mjs       # 4. packaged-layout acceptance on a clean unpack
```

`packaging/tools/assemble-release.py` copies the Gradle-built `classes/` verbatim, maps `packaging/native/` → `native/`,
`packaging/web/` → `web/`, `packaging/licenses/` → `licenses/`, adds top-level `LICENSE`/`README.md`,
and fails if required files are missing or dev paths leak in. The plugin's `resolveHelper()` accepts the
helper under `native/` and `lib/` (plus dev-only fallbacks), so either layout spawns from the installed payload.

**Compatibility-only releases** (v0.3.1): when a release touches nothing but `classes/`, do **not**
re-stage `packaging/` — the checkout's `native/` and `web/settings/settings-ui.js` can be older than
what shipped, which would silently regress the helper and the settings island. Splice the new classes
onto the previous *published* artifact instead and assert the payload is byte-identical:

```bash
gh release download v0.3.0 -p spw-folia-0.3.0.spmod -O dist/release/spw-folia-0.3.0-ref.spmod
python packaging/tools/splice-compat-release.py     # -> dist/release/spw-folia-0.3.1.spmod + .json
```

The script keeps every non-`classes/` entry as-is and fails if any payload CRC changed.

Per-version artifact records (byte sizes, payload hashes, changed-entry lists) are no longer kept
inline; see the release-artifact ledger at the end of this document, and `docs/archive/` for the
historical release notes and verification reports.


## 4. Plugin → host spawn contract

The JVM plugin starts the helper as a child process (working directory = the plugin directory, so
**relative paths are used and verified**):

```text
lib\spw-folia-host.exe --bundle web --settings-dir web\settings --settings-entry settings-ui.js [--open-settings]
```

- `--bundle web` — local Folia subset, mapped to `https://spw-folia.local/` inside WebView2. No HTTP
  server, no port, no network.
- `--settings-dir web\settings --settings-entry settings-ui.js` — injected after the Shim from
  `https://spw-folia-settings.local/settings-ui.js`.
- `--open-settings` — first run only: open the settings overlay once the island reports
  `bridgeReady` (fallback 2.5 s after navigation). Persisted-settings detection lives in the plugin.
- `--fullscreen` is the default; add `--window WxH` only for debugging. `--force-dsf 1` is
  **debug-only** (see §7).
- stdin/stdout: UTF-8 JSON lines, protocol v1 (`docs/protocol.md`). Plugin sends `hello`, `settings`,
  then `state` every ~100 ms plus `lyrics` / `track` / `config` on change. Host emits `ready`,
  `log`, `closed` and `fps` lines.
- Singleton: one host process per open Folia mode; if the window already exists, forward the action
  to it instead of spawning a second one. On plugin disable send `quit`, wait for exit, kill after 2 s.
- A stray `spw-folia-host.exe` holding the exe open makes the next build fail (`CS0016`): kill the
  process before rebuilding (`Stop-Process -Name spw-folia-host`).

Measured on this machine (windowed 1600×900, packaged payload): ready at **636–815 ms** after spawn
(WebView2 runtime version 150.0.4078.83), page interactive immediately, 120 fps median once started.

## 5. Interaction contract (protocol §7.5)

- The settings island owns the overlay: it registers `window.__SPW_FOLIA__.ui`
  (`isSettingsOpen/openSettings/closeSettings`) and consumes ESC itself while open (capture phase +
  `stopPropagation`).
- Host commands are forwarded by the Shim into the island: `{"t":"command","command":"open-settings"}`
  and `"close-settings"` call `__SPW_FOLIA__.ui.openSettings()/closeSettings()`.
- ESC with the overlay **closed** reaches the host (`{type:"key",key:"Escape"}`) → host closes the
  window, emits `{"t":"closed","reason":"user"}` and exits 0.
- `--open-settings` opens the overlay through the same path once (`bridgeReady`, timer fallback).

Verified end-to-end in `packaging/tools/verify-layout.mjs` (see §6, `packaging/out/verify-report.json`):
`settingsAutoOpened`, `closeSettingsCommand`, `openSettingsCommand`, `escClosedSettingsOnly`,
`closedUser`, `exitedZero` all true.

## 6. Packaged-layout acceptance test

```bash
node packaging/tools/verify-layout.mjs          # ~16 s, exits 0 on pass
```

What it does: spawns `packaging/native/spw-folia-host.exe` with `--bundle packaging/web`
(+ `--settings-dir web/settings`, `--open-settings`, windowed 1600×900, isolated user-data dir),
streams `hello/settings/lyrics/track` + 100 ms `state` lines, then:

1. probes the page at 4.2 s: bridge + `__SPW_FOLIA__.ui` present, 3 canvases, settings island
   injected from the virtual host, overlay open;
2. screenshot `packaging/out/packaged-firstrun-settings.png` (歌词样式 overlay over live sonnet);
3. sends `close-settings` → probe closed; sends `open-settings` → probe open (host↔page routing);
4. dispatches ESC → settings island closes the overlay only; window still alive (probe);
5. screenshot `packaging/out/packaged-visualizer.png` (visualizer, lyrics + translation);
6. dispatches ESC again → host emits `{"t":"closed","reason":"user"}`, exits 0.

Latest result: **PASS** — all 10 checks true, 0 console errors, 3 canvases, 116 fps median
(min 91 / max 120), heap ≤ 93.8 MB, `ready.startedAtMs 503` (spawn→ready), screenshots
755 KB / 968 KB. Re-verified after the task-9 spawn-hardening rebuild (see `docs/host-app.md` §9).

Relative-path spawn test (plugin install layout), run from `packaging/` itself:

```bash
cd packaging && ./native/spw-folia-host.exe --bundle web --settings-dir web/settings \
  --settings-entry settings-ui.js --window 800x450 --duration 6500 --open-settings --demo \
  --screenshot out/relcwd-shot.png --shot-at 5000
# -> nav-done at 560 ms, open-settings requested auto=true, screenshot 228 KB, exit 0
```

## 7. DPI / DSF caveat

- The production host runs fullscreen at the monitor's device scale factor (DSF). On the reference
  machine (3200×2000 @ 180 % scaling) the page CSS viewport is ~1778×1111 and both the visualizer and
  the full-viewport settings overlay lay out correctly (verified; the overlay is responsive).
- `--force-dsf 1` forces `--force-device-scale-factor=1`, which gives a 1600×1000 window a 1600×1000
  CSS viewport. Use it **only** for small-window smoke tests where Folia's `lg:` breakpoint matters
  (the settings window is designed for ≥1240×780 CSS px). Do not default it on: it bypasses the
  user's Windows scaling and would render small on high-DPI screens.

## 8. Offline / no-network guarantee

The packaged page performs no network requests: verified with a blocked-network browser run —
99 requests, all same-origin/local, 0 external, 0 failed; the aistudiocdn `importmap` in the Folia
`index.html` is inert for the OBS surface; no fonts are fetched from the network (no font files are
shipped either); the service worker is removed. The only external dependency is the machine's
WebView2 Runtime (system component).

## 9. Licensing (AGPL-3.0) — required reading for release

- Folia's web build is **AGPL-3.0**; our plugin reuses its code/components. Therefore the plugin and
  everything we distribute (including `web/`, the settings island and this packaging) are released
  **AGPL-3.0-or-later**. `licenses/AGPL-3.0.txt`, `NOTICE.md`, `SOURCE-OFFER.md` and
  `THIRD-PARTY.md` are shipped inside the plugin directory and must be kept there.
- `web/` is the **unmodified** upstream Folia production build except two removed PWA tags in
  `index.html` (documented in `NOTICE.md`; reproducible via `packaging/tools/stage-web.mjs`).
- The WASAPI analyzer is MIT (copyright ours); the WebView2 SDK DLLs are redistributed under the
  Microsoft WebView2 SDK license (texts shipped). No fonts, no model weights, no Folia binary
  assets are redistributed beyond the web build.
- Before publishing: confirm the exact upstream Folia source URL/tag to cite in `NOTICE.md`
  (currently "folia-major 0.7.22 as distributed in the Folia desktop application"; the release owner
  should add the upstream repository link + commit hash).

## 10. Release checklist (owner: Lead)

1. Build inputs fresh: host build, settings UI build, Folia dist + offline dependency report.
2. `bash packaging/build-package.sh` → staging clean, `size-report.json` within budget,
   `SHA256SUMS.txt` regenerated.
3. **Run the self-check on the real machine** (v0.4.11 onward — the 「出现问题」 report is part of the
   artifact, so it is verified like one):
   - `cd spw-folia && ./gradlew runDiagnostics` → exit 0 and no `FAIL` row on a healthy machine
     (each row prints `VERDICT  label  detail` + `evidence:`; `UNKNOWN` is allowed, see
     `docs/logging-and-diagnostics.md` §3.0);
   - `node packaging/tools/verify-diagnostics.mjs` → exit 0, no false `FAIL` on the page side;
   - or just run the whole gate in one shot: `node packaging/tools/verify-all.mjs` → `10/10 gate
     checks` (static contract + self-check + both switch suites; `--static` skips the browser).
   Any `FAIL` on a healthy machine blocks the release — that is exactly the v0.4.2–v0.4.6 bug class.
4. `node packaging/tools/verify-layout.mjs` → PASS (keep `packaging/out/verify-report.json` +
   screenshots as release evidence).
5. Copy the three payload areas into the assembled `.spmod` per §3; keep `licenses/` inside.
6. Smoke-test the assembled `.spmod` in a real SPW install (menu item → fullscreen visualizer,
   first-run settings, ESC, track change, pause/seek).
7. Record versions in the release notes: plugin version, host exe sha256, Folia version
   (`folia-major 0.7.22`), WebView2 SDK/NuGet version and tested WebView2 Runtime version
   (150.0.4078.83), settings island build.
8. No secrets in the artifact (`packaging/` contains no credentials).

## Appendix: release-artifact ledger

Only the current release needs its payload hashes checked. The ledger below is the compact record of
what each published `.spmod` was, kept so a downloaded artifact can still be verified against the
repository; per-version change essays and full payload breakdowns live in
[`docs/archive/`](archive/) (and in the GitHub Releases bodies, which ship `SHA256SUMS.txt` next to
every `.spmod`).

**The last published release is v0.4.13.** v0.4.6.1, v0.4.7, v0.4.8, v0.4.9, v0.4.10, v0.4.11 and
v0.4.12 were built and tested locally only — they have **no** GitHub release and **no** tag, so they
must not be presented as downloadable; their changes ship inside v0.4.13. (The version numbers
written inside the code were stale for a while — `build.gradle.kts` / `FoliaPlugin.PLUGIN_VERSION`
still said `0.4.7` until the 0.4.10 cleanup, which is why some local build artifacts carry a "0.4.7"
name.)

| Version | `.spmod` bytes | entries | sha256 | released |
| --- | --- | --- | --- | --- |
| v0.1.0 | 12,443,495 | 1,937 | `8c265dc1aca7ee5ee378b65f5b045ccba7e51536e812e399b0d9cf6bd9d46838` | 2026-10-18 |
| v0.1.1 | 12,450,886 | 1,938 | `9c4d206911eebc43869af2c0aae074efa8f672e081586946e022d7b4c89dac21` | 2026-10-19 |
| v0.1.2 | 12,450,848 | 1,938 | `2dc2f46b8635bd4918f45b65e9cd36d814c876e8c9f5a7827da4d0621174a0b9` | 2026-10-19 |
| v0.1.3 | 12,405,289 | 1,937 | `16bdda573be6f9fed29780881e94feb1f5c0a6d542260c024e4f284c8a5d41ea` | 2026-10-19 |
| v0.1.4 | 12,405,269 | 1,937 | `24ddaf34982a6acb9b92943ead1123d6dfb34ed4c9ae082c94ed2e7d1d82c04e` | 2026-10-19 |
| v0.1.5 | 12,574,908 | 1,937 | `8e88488ba9d4137602c550a1633c98b2b45d2a4ebf578822f7412940d9655c11` | local only |
| v0.1.6 | 13,136,350 | 1,941 | `aacd02afb078b13d09a26930f6981740930df5dfe04343b7a9584cfd84bdcad9` | 2026-10-19 |
| v0.1.7 | 12,970,892 | 1,941 | `5cf8eba69c9d1bb961efd160075c29b9cde52e5b30699598e5ec174106dd5138` | 2026-10-19 |
| v0.1.8 | 12,976,142 | 1,941 | `0913914b37ba5a1b4b8db7775ebb1b7ab1621d1a069a000c43766c4c62b9ad1f` | local only |
| v0.1.9 | 12,975,396 | 1,941 | `8ec1ffb3e4dee3c4befbc953f7d36a22ab1864e5e204439c7c16a5233257ce01` | 2026-10-19 |
| v0.1.10 | 13,145,163 | 1,941 | `4a90d09e95ea37449882f6b7507fcfa3d0ccdf72d86dbc969b26d6426cbcf951` | 2026-10-19 |
| v0.2.0 | 13,149,053 | 1,941 | `d3bc76163dc1fa5598455b48e5fc4674b5a6f588cca5e84fa9951a72160c2fbb` | 2026-10-20 |
| v0.2.1 | 13,152,604 | 1,941 | `56c0aa4177a1bea8fe0078a9c27ab2dee264f0c85387af0a667086cd39f0e792` | 2026-10-20 |
| v0.2.2 | 13,153,013 | 1,941 | `ca74c7fc4b6ce807af582f8dcbae041f4001bbf8b291e86e3be29a30f9fa38ac` | 2026-10-21 |
| **v0.3.0** | **13,178,430** | **1,943** | `7f79d9dc8184c1119ce42a6dc59e1036fb3ffee6bb883c0c603cfdd977d80744` | 2026-10-21 |
| v0.4.0-preview.1 | 20,029,633 | 3,925 | `4c3f252deca659697a687681538d96b492054b64b6f1865bd82b4c720d07fcd3` | 2026-10-24 |
| v0.4.0-preview.2 | 12,193,169 | 3,896 | `1c9816a992cd303a93b1b24e7601657c36d82247dceddf36e2e768c3e2e7e7cb` | 2026-10-24 |
| v0.4.1-preview.1 | 12,191,035 | 3,896 | `6e07ae30a3f2a1f92c165afa0cb516fa87b75a7484bc909690c8001532a6b7fb` | 2026-10-24 |
| v0.4.2 | 12,221,858 | 3,894 | `5bfdf80df4a93d96c283a0823788cf8d2a5ffeaa470f4c4c1e89fe5114cbcedb` | 2026-10-26 |
| v0.4.3 | 12,224,037 | 3,894 | `a2015b34472477b8a06d73527df6db3d4a6f589458c909af6f41442a4efc513f` | 2026-10-26 |
| v0.4.4 | — | — | — | **无发布记录**：GitHub Releases 与 `git ls-remote --tags` 均无 `v0.4.4`，本地也无产物（`gh release view v0.4.4` → `release not found`，2026-11-02 核实）。按「未发布」处理；若日后发现遗漏，以 Releases 页面为准 |
| v0.4.5 | 12,227,007 | 3,894 | `3b2a74741cd4fc299e7ad0a0c57a296545fb0025a6bcd81f29381307886e6237` | 2026-10-30 |
| **v0.4.6** | **12,476,192** | **3,912** | `fc06fd0724a4a6e8785bd912217c88c228aa1c234437d94e750c59a5f0619805` | 2026-10-30 (**最后发布**) |
| v0.4.6.1 | 10,948,881 | 3,907 | `a3f1b9158c9b29356eb30e608b894450ec62968cc44df49b0fe07ff4b862117c` | local only |
| v0.4.7 | 12,513,618 | 3,922 | `afced725c3322c19bd2a76557563275f363df26456517d4fdf16212fff21d582` | local only |
| v0.4.8 | — | — | — | local only（无独立产物，改动并入 v0.4.9/v0.4.10 开发线） |
| v0.4.9 | — | — | — | local only（同上） |
| v0.4.10 | — | — | — | local only。只产出过**插件包** `spw-folia/build/libs/plugin-dev.spw.folia-0.4.10.spmod`（334,174 B，92 文件，`Plugin-Version: 0.4.10`），**未**组装完整 `.spmod`（`dist/release/` 里没有 0.4.10 产物），所以没有 bytes/entries/sha256 可记 |
| **v0.4.11** | **15,406,708** | **3,976** | `e7bd36687e9499c6882bfb2b549610b63e5a3dae85732b69127b1bf0f012fa22` | local only（2026-11-02 本地组装）。配置页重新分组（播放页 / 诊断与日志 / 支持与反馈）、新增 `showProblemButton` 开关（默认关）、自检复检纳入检查表。**未上传** |
| v0.4.12 | 15,419,925 | 3,977 | `238d36a8c713b8d3c2bf4f9764eaccc557d593456d039c0aada8d67c71bf4342` | local only（2026-11-02 本地组装）。重写配置同步（`FoliaConfigSync`），**引入了「三个开关全部不生效」的回归**，由 v0.4.13 修复。**未上传** |
| **v0.4.13** | **15,438,647** | **3,982** | `5cb1cdafacdea46559e4b57ad1934522e6b20874d2531aabad2b46cac948f308` | **2026-11-03 发布**。修复 v0.4.12 的开关回归（行协议换行截断 + `ready` 后重发 + spawn 期开关同步 + 详细日志旧值迁移），并补齐 `verify-json-singleline` / `verify-playback-switches` / `verify-live-settings-payload` 三个回归脚本。`verify-all.mjs` 10/10。详见 [`release-notes-v0.4.13.md`](release-notes-v0.4.13.md) |

`local only` builds were verified on a real install but never uploaded; their changes shipped inside
the next published release. v0.1.11 was never built as a standalone artifact either — its two fixes
(see [`archive/verification-v0.1.11.md`](archive/verification-v0.1.11.md)) went out with v0.2.0.

Notes on how to read this table:

- `entries` counts **files** inside the zip; the five directory entries (`classes/` and the package
  folders) are excluded, which is what the pre-v0.4.3 rows already did.
- The v0.4.5 / v0.4.6 numbers were recomputed on 2026-11-02 from the assets downloaded via
  `gh release download`, not copied from release notes. v0.4.6.1 / v0.4.7 rows come from the
  `dist/release/*.spmod.json` sidecars of those local builds (same recomputation, same machine).
- Version numbers were not bumped in code for a long stretch: `build.gradle.kts` and
  `FoliaPlugin.PLUGIN_VERSION` still read `0.4.7` after several development cycles. The 0.4.10 work
  unifies them; the artifacts named `*-0.4.7*.spmod` in `dist/release/` are therefore older local
  builds, not the published 0.4.7 — and 0.4.7 itself was never published either.

Current release payload (**v0.4.6**, the last published artifact): `web/` 3,820 files /
26,112,116 B, `native/` 5 files / 1,097,142 B (host `spw-folia-host.exe` 164,864 B), `licenses/`
7 files / 49,370 B, `classes/` 80 files / 626,269 B — 27,884,897 B uncompressed, shipped as
12,476,192 B with sha256 `fc06fd07…`. The v0.4.5 artifact differs only in `classes/`
(62 files / 493,078 B → 12,227,007 B total, sha256 `3b2a7474…`). Verify a downloaded artifact with:

```bash
sha256sum spw-folia-0.4.6.spmod    # compare with the ledger row and the release's SHA256SUMS.txt
node packaging/tools/verify-layout.mjs   # packaged-layout acceptance on a clean unpack
```
