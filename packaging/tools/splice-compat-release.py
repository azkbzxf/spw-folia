"""Splice freshly built plugin classes onto a previously published release payload.

Compatibility-only release: web/, native/ and licenses/ must stay byte-identical to the accepted
base artifact. Re-staging them from this checkout would silently regress the helper exe / settings
island when packaging/ is older than what shipped.

Usage:
  python packaging/tools/splice-compat-release.py \
      --base dist/release/spw-folia-0.4.3.spmod \
      --classes spw-folia/build/libs/plugin-dev.spw.folia-0.4.5.spmod \
      --out dist/release/spw-folia-0.4.5.spmod \
      --version 0.4.5 \
      --payload-note "v0.4.3 (web/native/licenses unchanged)"
"""
import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

STAMP = (2026, 1, 1, 0, 0, 0)
PERMISSIONS = "class-transform,library-read,key-bindings"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="previously published .spmod")
    ap.add_argument("--classes", required=True, help="Gradle-built .spmod (classes/ only used)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--payload-note", default="")
    args = ap.parse_args()

    base_path = Path(args.base)
    classes_path = Path(args.classes)
    out_path = Path(args.out)

    if not base_path.is_file():
        print("ERROR: base not found: %s" % base_path, file=sys.stderr)
        return 2
    if not classes_path.is_file():
        print("ERROR: classes not found: %s" % classes_path, file=sys.stderr)
        return 2
    out_path.parent.mkdir(parents=True, exist_ok=True)

    base = zipfile.ZipFile(base_path)
    classes = zipfile.ZipFile(classes_path)

    kept = [(i, base.read(i.filename)) for i in base.infolist()
            if not i.filename.startswith("classes/")]
    dropped = [i.filename for i in base.infolist() if i.filename.startswith("classes/")]
    new = [(i, classes.read(i.filename)) for i in classes.infolist()]

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for info, data in kept:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            out.writestr(zi, data)
        for info, data in new:
            zi = zipfile.ZipInfo(info.filename, date_time=STAMP)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, data)

    data = out_path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    size = len(data)

    # Every non-classes/ entry must keep its CRC.
    a = {i.filename: i.CRC for i in base.infolist() if not i.filename.startswith("classes/")}
    b = {i.filename: i.CRC for i in zipfile.ZipFile(out_path).infolist()
         if not i.filename.startswith("classes/")}
    if a != b:
        print("ERROR: payload entries changed", file=sys.stderr)
        print(set(a.items()) ^ set(b.items()), file=sys.stderr)
        return 1

    # Manifest version must be the new one.
    manifest = {}
    with zipfile.ZipFile(out_path) as z:
        for name in z.namelist():
            if name.endswith("META-INF/MANIFEST.MF"):
                for line in z.read(name).decode("utf-8", "replace").splitlines():
                    if ": " in line and not line.startswith(" "):
                        k, v = line.split(": ", 1)
                        manifest[k.strip()] = v.strip()
                break
    if manifest.get("Plugin-Version") != args.version:
        print("ERROR: manifest Plugin-Version=%r, expected %r"
              % (manifest.get("Plugin-Version"), args.version), file=sys.stderr)
        return 1
    if "class-transform" not in manifest.get("Plugin-Permissions", ""):
        print("ERROR: manifest lacks class-transform", file=sys.stderr)
        return 1

    meta = {
        "file": out_path.name,
        "sizeBytes": size,
        "sizeMB": round(size / 1048576, 2),
        "sha256": digest,
        "entries": len(zipfile.ZipFile(out_path).infolist()),
        "pluginId": manifest.get("Plugin-Id"),
        "pluginClass": manifest.get("Plugin-Class"),
        "pluginVersion": manifest.get("Plugin-Version"),
        "pluginName": manifest.get("Plugin-Name"),
        "permissions": PERMISSIONS,
        "payload": args.payload_note,
    }
    (out_path.parent / (out_path.name + ".json")).write_text(
        json.dumps(meta, indent=2), encoding="utf-8")
    (out_path.parent / (out_path.name + ".sha256")).write_text(
        "%s *%s\n" % (digest, out_path.name), encoding="utf-8")

    print("wrote %s (%d B, %.2f MB, sha256=%s)" % (out_path, size, size / 1048576, digest))
    print("kept %d payload entries (all CRC identical), dropped %d old classes, added %d new"
          % (len(kept), len(dropped), len(new)))
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
