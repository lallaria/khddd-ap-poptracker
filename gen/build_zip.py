"""Zips the pack like the release workflow and doesn't mess up on the accents.

Usage: .venv/Scripts/python gen/build_zip.py [output.zip]   (default dist/khddd-ap-tracker.zip)
"""
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXCLUDED_DIRS = {".git", ".github", ".claude", ".venv", "dist", "gen", "__pycache__"}
EXCLUDED_FILES = {".gitignore", ".luarc.json", ".release-please-manifest.json", "release-please-config.json"}


def main(output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(REPO.rglob("*")):
            relative = path.relative_to(REPO)
            if not path.is_file() or EXCLUDED_DIRS & set(relative.parts) or relative.name in EXCLUDED_FILES:
                continue
            archive.write(path, relative.as_posix())
            count += 1
    print(f"wrote {output} ({count} files)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else REPO / "dist" / "khddd-ap-tracker.zip")
