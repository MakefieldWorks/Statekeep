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
SOURCE_SVG = ROOT / "resources" / "statekeep.svg"
ICON_SVG = ROOT / "resources" / "icon.svg"
RESOURCES_DIR = ROOT / "resources"
RENDERER_PUBLIC_DIR = ROOT / "src" / "renderer" / "public"


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, text=True, capture_output=True)
    if result.returncode != 0:
        # Show the tool's own message (for example a missing Chromium) rather
        # than only its exit status.
        raise RuntimeError(f"{' '.join(cmd)} failed:\n{(result.stderr or result.stdout).strip()}")


def ensure_source() -> None:
    for source in (SOURCE_SVG, ICON_SVG):
        if not source.exists():
            raise FileNotFoundError(f"Missing source SVG: {source}")


def render_png(source: Path, target: Path) -> None:
    run(["node", str(ROOT / "scripts" / "render_svg_png.mjs"), str(source), str(target), "1024"])
    image = Image.open(target).convert("RGBA")
    # Both sources have transparent corners. An opaque corner means the
    # renderer flattened the image onto a background.
    if image.getpixel((0, 0))[3] != 0:
        raise RuntimeError(f"Rendered {target.name} has an opaque corner; transparency was lost")
    image.save(target)


def generate_icns(base_png: Path, target: Path) -> None:
    # Pillow writes every standard size (16 to 512@2x) from the 1024px image.
    Image.open(base_png).convert("RGBA").save(target, format="ICNS")


def generate_ico(base_png: Path, target: Path) -> None:
    image = Image.open(base_png)
    image.save(target, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def generate_installer_sidebar(base_png: Path, target: Path) -> None:
    # NSIS welcome/finish pages require an uncompressed 24-bit 164x314 BMP.
    width, height, mark_size = 164, 314, 104
    sidebar = Image.new("RGB", (width, height), "#ffffff")
    mark = Image.open(base_png).convert("RGBA").resize((mark_size, mark_size), Image.Resampling.LANCZOS)
    sidebar.paste(mark, ((width - mark_size) // 2, 48), mark)
    sidebar.save(target, format="BMP")


def generate_web_assets(mark_png: Path) -> None:
    RENDERER_PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE_SVG, RENDERER_PUBLIC_DIR / "statekeep-mark.svg")

    image = Image.open(mark_png)
    image.resize((512, 512), Image.Resampling.LANCZOS).save(RENDERER_PUBLIC_DIR / "statekeep-mark.png")
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
    generate_installer_sidebar(base_png, RESOURCES_DIR / "installerSidebar.bmp")
    with tempfile.TemporaryDirectory(prefix="statekeep-mark-") as tmpdir:
        mark_png = Path(tmpdir) / "mark.png"
        render_png(SOURCE_SVG, mark_png)
        generate_web_assets(mark_png)

    print("Generated branding assets from resources/icon.svg and resources/statekeep.svg")
    print(f"- {base_png.relative_to(ROOT)}")
    print(f"- {icns_path.relative_to(ROOT)}")
    print(f"- {ico_path.relative_to(ROOT)}")
    print("- resources/installerSidebar.bmp")
    print(f"- {(RENDERER_PUBLIC_DIR / 'statekeep-mark.svg').relative_to(ROOT)}")
    print(f"- {(RENDERER_PUBLIC_DIR / 'statekeep-mark.png').relative_to(ROOT)}")
    print(f"- {(RENDERER_PUBLIC_DIR / 'favicon.png').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Failed to generate branding assets: {exc}", file=sys.stderr)
        raise
