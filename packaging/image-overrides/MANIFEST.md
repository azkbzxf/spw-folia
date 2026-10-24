# Image overrides (packaged payload size)

The packaged `.spmod` ships Folia's web bundle verbatim, including its illustration,
mascot-avatar and preview-cover images. Those PNGs are flat-shaded anime art, so
a 256-colour palette PNG keeps the visual result while cutting the bytes by ~3/4.
The cover JPGs are re-encoded as progressive JPEG q88.

These files keep their **original names and formats**, so the staged JavaScript
does not need any URL rewriting: dynamic fallbacks such as `new URL(\`vibe1.png\`, …)`
and the extension-probing lists (`[.jpeg, .jpg, .png, .webp, .avif]`) keep
resolving correctly. `packaging/tools/apply-image-overrides.mjs` copies them over
`packaging/web/` right after `stage-web.mjs` has staged the untouched upstream
dist, and before the size report / checksums are produced.

## Contents

| directory | files | purpose |
| --- | --- | --- |
| `assets/` | 27 | every `*.png` / `*.jpg` under `poc/webview/dist/dist/assets` (mascots, avatars, preview covers) |
| `preview/` | 2 | the two generated preview covers (`placeholder_cover.jpg`, `placeholder_cover-2.jpg`) |

Current totals: 4.54 MB upstream -> 1.39 MB here (saved 3.14 MB, 69 %).

## Regenerating

Run this only when the upstream Folia web bundle (`poc/webview/dist/dist`) changes:

```bash
python packaging/tools/make-image-overrides.py
```

Settings are fixed in the script (`PNG_COLORS = 256`, `JPEG_QUALITY = 88`). It
requires Pillow, which is available in the DSH bundled Python; the normal package
build does **not** need Python — it only copies these committed files.

Because upstream asset names are content-hashed, a Folia upgrade renames the
files. The override script rewrites the whole directory, and
`apply-image-overrides.mjs` reports any override whose target no longer exists in
the staged tree, so a stale override is visible in the build log instead of
silently doing nothing.
