# Archive — historical evidence

Everything in this directory is **history, not documentation**. It is kept only so that an artifact
published months ago can still be traced to the claims made about it; nothing here describes how the
project works today. Current documentation lives one level up in [`docs/`](../).

**This directory is deliberately not linked from the project README.** It is an audit trail for
maintainers, not an entry point for users or contributors — reach it by path when you need the
evidence behind a specific past fix.

- How to use / install / build the plugin → [README](../../README.md).
- What changed in a release → the [GitHub Releases](https://github.com/azkbzxf/spw-folia/releases)
  page. Per-release notes, `.spmod` assets and `SHA256SUMS.txt` all live there; the release bodies in
  this repository's git history are byte-identical to the published ones.
- Current packaging and release procedure → [`docs/release.md`](../release.md).

## Contents

**Decision records and reverse-engineering (still referenced by current docs)**

- `webview-spike.md` — the WebView2-vs-JCEF decision record, style scan, DPI and beat-FX findings.
  Current host contract: [`docs/host-app.md`](../host-app.md).
- `hook-poc.md` — the SPW 1.19.0 menu-hook proof of concept (`appendContent` dead end, working
  design, permission pre-grant). Distilled current version: [`docs/hook-target.md`](../hook-target.md).
- `re-host.md` — SPW host reverse-engineering facts: install layout, target menu, build environment,
  local install/permission loop. Cited by [`docs/hook-target.md`](../hook-target.md).
- `plugin-integration.md` — the plugin ↔ native-helper integration milestone (menu item → fullscreen
  Folia window fed by Salt Player). Current contract: [`docs/protocol.md`](../protocol.md).

**Verification reports still cited as evidence by current docs**

- `verification-v0.1.2.md` — cover-colour theme fix (`coverUrl` mirror). No current doc cites it;
  kept as the only record of that root cause.
- `verification-v0.1.3.md` — font/subtitle pushConfig assertions. Cited by
  [`docs/known-inert-settings.md`](../known-inert-settings.md).
- `verification-v0.1.7.md` — player-page transparency (v0.1.7). Cited by
  [`docs/live-transparency.md`](../live-transparency.md).
- `verification-v0.1.10.md` — wheel-scroll crash fix. Cited by [`docs/live-transparency.md`](../live-transparency.md)
  and [`docs/runtime-requirements.md`](../runtime-requirements.md).
- `verification-v0.1.11.md` — WebView2 155+ stdin-pump crash (shipped in v0.2.0). Cited by
  [`docs/runtime-requirements.md`](../runtime-requirements.md).
- `verification-v0.2.0.md` — transparency compatibility + crash fixes, with build assertions. Cited by
  [`docs/live-transparency.md`](../live-transparency.md).
- `verification-v0.3.0.md` — bottom playback-control bar verification. Cited by
  [`docs/playback-controls.md`](../playback-controls.md).
- `verification-v0.4.2.md` — the three v0.4.2 fixes verified on the real host + real WebView2. Cited by
  [`docs/release-notes-v0.4.3.md`](../release-notes-v0.4.3.md), which is itself a historical note.
- `verification-live-preview.md` — the live settings-preview evidence. Current contract:
  [`docs/live-preview-iframe.md`](../live-preview-iframe.md).

**Not kept here:** per-release notes, the v0.1.0 acceptance/QA matrices and payload-validation
reports were removed. Their content is fully carried by the GitHub Releases bodies (verified
byte-identical to the notes that used to sit here) and, where it matters for a current claim, by the
verification reports above. Ask git history for anything else.

Files here are frozen: they keep their original wording and their `docs/<name>.md` cross-links have
been rewritten to `docs/archive/` paths so they still resolve. Do not update them to track code
changes — add a new document under `docs/` instead.
