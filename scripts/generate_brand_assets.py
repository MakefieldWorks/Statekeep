#!/usr/bin/env python3

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
# The mark (stepped layers, transparent background) is used inside the app and
# on the web. The app icon puts that mark on a rounded tile sized to the macOS
# icon grid (824px tile on a 1024px canvas) and feeds the OS icon files.
SOURCE_SVG = ROOT / "resources" / "layertrail.svg"
ICON_SVG = ROOT / "resources" / "icon.svg"
RESOURCES_DIR = ROOT / "resources"
RENDERER_PUBLIC_DIR = ROOT / "src" / "renderer" / "public"


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, text=True, capture_output=True)


def ensure_source() -> None:
    for source in (SOURCE_SVG, ICON_SVG):
        if not source.exists():
            raise FileNotFoundError(f"Missing source SVG: {source}")


def render_png(source: Path, target: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="layertrail-brand-") as tmpdir:
        tmp_path = Path(tmpdir)
        run(["qlmanage", "-t", "-s", "1024", "-o", str(tmp_path), str(source)])
        thumbnail = tmp_path / f"{source.name}.png"
        if not thumbnail.exists():
            raise FileNotFoundError(f"Quick Look did not create thumbnail: {thumbnail}")
        shutil.copy2(thumbnail, target)


def generate_icns(base_png: Path, target: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="layertrail-iconset-") as tmpdir:
        iconset_dir = Path(tmpdir) / "layertrail.iconset"
        iconset_dir.mkdir()

        sizes = {
            "icon_16x16.png": 16,
            "icon_16x16@2x.png": 32,
            "icon_32x32.png": 32,
            "icon_32x32@2x.png": 64,
            "icon_128x128.png": 128,
            "icon_128x128@2x.png": 256,
            "icon_256x256.png": 256,
            "icon_256x256@2x.png": 512,
            "icon_512x512.png": 512,
            "icon_512x512@2x.png": 1024,
        }

        for filename, size in sizes.items():
            output = iconset_dir / filename
            run(["sips", "-z", str(size), str(size), str(base_png), "--out", str(output)])

        run(["iconutil", "-c", "icns", str(iconset_dir), "-o", str(target)])


def generate_ico(base_png: Path, target: Path) -> None:
    image = Image.open(base_png)
    image.save(target, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def generate_web_assets(mark_png: Path) -> None:
    RENDERER_PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE_SVG, RENDERER_PUBLIC_DIR / "layertrail-mark.svg")

    image = Image.open(mark_png)
    image.resize((512, 512), Image.Resampling.LANCZOS).save(RENDERER_PUBLIC_DIR / "layertrail-mark.png")
    image.resize((256, 256), Image.Resampling.LANCZOS).save(RENDERER_PUBLIC_DIR / "favicon.png")


def main() -> int:
    ensure_source()
    RESOURCES_DIR.mkdir(parents=True, exist_ok=True)

    base_png = RESOURCES_DIR / "icon.png"
    icns_path = RESOURCES_DIR / "icon.icns"
    ico_path = RESOURCES_DIR / "icon.ico"

    render_png(ICON_SVG, base_png)
    generate_icns(base_png, icns_path)
    generate_ico(base_png, ico_path)
    with tempfile.TemporaryDirectory(prefix="layertrail-mark-") as tmpdir:
        mark_png = Path(tmpdir) / "mark.png"
        render_png(SOURCE_SVG, mark_png)
        generate_web_assets(mark_png)

    print("Generated branding assets from resources/icon.svg and resources/layertrail.svg")
    print(f"- {base_png.relative_to(ROOT)}")
    print(f"- {icns_path.relative_to(ROOT)}")
    print(f"- {ico_path.relative_to(ROOT)}")
    print(f"- {(RENDERER_PUBLIC_DIR / 'layertrail-mark.svg').relative_to(ROOT)}")
    print(f"- {(RENDERER_PUBLIC_DIR / 'layertrail-mark.png').relative_to(ROOT)}")
    print(f"- {(RENDERER_PUBLIC_DIR / 'favicon.png').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Failed to generate branding assets: {exc}", file=sys.stderr)
        raise
