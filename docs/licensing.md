# Licensing & attribution (spw-folia)

## Our license

- The repository and every artifact we publish (source, the `.spmod` release asset, the bundled web
  assets, the native helper binary) are licensed **AGPL-3.0-or-later** (full text: [`LICENSE`](../LICENSE)).
- Rationale: the visualizer is a redistribution and integration of **Folia**, which is AGPL-3.0. The
  settings UI also builds Folia's React components from a Folia source checkout. AGPL requires
  derivative and combined works to be AGPL, and requires offering the Corresponding Source to users
  who interact with the work over a network.
- Not affiliated with, endorsed by, or supported by the Folia authors or Salt Player.

## Source offer (AGPL-3.0 §6/§13)

The complete Corresponding Source for what we ship:

| shipped artifact | source |
| --- | --- |
| Kotlin plugin (`classes/`) | `spw-folia/` in this repository |
| Native host helper (`native/spw-folia-host.exe`) | `poc/webview/host/`, built with `bash poc/webview/host/build.sh` |
| Settings UI (`web/settings/`) | `poc/settings-ui/`, built with `pnpm build` |
| Web payload (`web/`) | Folia `v0.7.22` upstream (below) + staging recipe `packaging/tools/stage-web.mjs` |
| Packaging | `packaging/build-package.sh`, `packaging/tools/assemble-release.py` |

Folia's source: https://github.com/chthollyphile/folia-major, tag **`v0.7.22`**, commit
`1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe`. We ship Folia's production web build unmodified, except
for two removed PWA tags in `web/index.html` (service-worker registration + manifest link, both
inert because the service worker is not shipped). That change is documented in
[`packaging/licenses/NOTICE.md`](../packaging/licenses/NOTICE.md) and reproducible via
`packaging/tools/stage-web.mjs`. We do not patch Folia source, so there is no `patches/` directory.

Whoever redistributes this plugin, including a modified version, must keep this source offer and
must offer the Corresponding Source to users interacting with it over a network (AGPL-3.0 §13). If
you received a binary and cannot obtain the source from the locations above, contact the distributor
of that binary.

## What ships inside the `.spmod`

The plugin directory carries `licenses/`, so the notices travel with every release and stay
readable in a local installation:

| shipped file | covers |
| --- | --- |
| `licenses/AGPL-3.0.txt` | this project and the Folia web build |
| `licenses/NOTICE.md` | copyright, Folia attribution, the `index.html` change, WebView2 |
| `licenses/SOURCE-OFFER.md` | the written source offer (mirror of §Source offer above) |
| `licenses/THIRD-PARTY.md` | component inventory with versions and licenses |
| `licenses/AUDIO-MIT.txt` | the original WASAPI analyzer sources (MIT) |
| `licenses/WebView2-SDK-LICENSE.txt` | Microsoft WebView2 SDK |
| `licenses/WebView2-SDK-NOTICE.txt` | third-party notice bundle for the WebView2 SDK |

`build-package.sh` stages this directory: `NOTICE.md`, `SOURCE-OFFER.md`, `THIRD-PARTY.md` and
`AUDIO-MIT.txt` are authored in `packaging/licenses-src/`; `AGPL-3.0.txt` is copied from the Folia
upstream `LICENSE`; the two WebView2 texts are extracted from the `Microsoft.Web.WebView2` NuGet
package. Per-component details — versions, redistributed DLLs, npm dependency licenses — are in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md); do not duplicate the inventory here.

## Obligations to keep in mind

- **Folia attribution travels with the bundle.** Every release notes states which Folia version and
  upstream tag/commit it contains.
- **Nothing third-party is bundled that we cannot redistribute.** Compose, Kotlin, PF4J and the
  workshop API are `compileOnly` (Salt Player provides them); the WebView2 Runtime and .NET Framework
  4.8 are OS components; no fonts and no Folia model weights are shipped.
- **The WASAPI analyzer is ours.** `poc/webview/host/audio/` is an original clean-room
  implementation under `SPDX-License-Identifier: MIT`, distributed in the AGPL-3.0 helper as a whole.
  Keep `licenses/AUDIO-MIT.txt` in the package when those sources change.
- **Credits are not dependencies.** spw-island is a GPL-3.0 behavioural reference only — no code
  copied, not distributed — and is listed under acknowledgements in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), not as a bundled component.

## Credentials / privacy

- No credentials, tokens or cookies in the repository or in shipped logs.
- The plugin reads only SPW's workshop API data (playback state, track, lyrics, cover, audio) and
  renders it locally. No telemetry, no network requests from the shipped page.
- User logs can contain local file paths; never publish user logs verbatim.

## Publish checklist

- [ ] `LICENSE` at the repository root is the full AGPL-3.0 text (identical to
      `packaging/licenses/AGPL-3.0.txt`).
- [ ] `licenses/` inside the `.spmod` has all seven files listed above.
- [ ] `NOTICE.md` cites the Folia upstream URL plus tag `v0.7.22` and commit hash.
- [ ] README states AGPL-3.0, links to source, and says the plugin is unofficial community work.
- [ ] Release notes record the plugin version, host exe sha256, Folia version, and WebView2
      SDK/runtime versions.
- [ ] `SHA256SUMS.txt` (or the `.spmod.json` sidecar) is published next to the `.spmod`.
- [ ] GitHub repo topic `salt-player-plugins`; description mentions SPW 1.19.x and Folia mode.
- [ ] No build outputs committed except the release asset; no `%APPDATA%` data, no host jars.
