#!/usr/bin/env python3
"""
blend2glb.py — batch-convert Blender .blend files to .glb or .obj (drop-in companions for Online 3D Studio).

Why this exists
    .blend is Blender's private binary format. No browser (or any tool without Blender's
    own code) can reliably read it. So Online 3D Studio (index.html) cannot open .blend
    files directly — but it opens the converted .glb/.obj perfectly.

    This script runs Blender headlessly ("Blender without a window") to convert files.
    It is the automatic ".blend -> .glb/.obj" step; the result drops straight into the viewer.

Requirements
    * Python 3.7+  (this script only uses the standard library)
    * Blender 2.83 or newer installed on this machine
        - found automatically on PATH, or via --blender / BLENDER_PATH env var
        - common install folders (Windows/macOS/Linux) are also searched

Usage
    python blend2glb.py model.blend                      # -> model.glb next to the input
    python blend2glb.py a.blend b.blend --format obj     # -> a.obj (+ a.mtl), b.obj (+ b.mtl)
    python blend2glb.py my_folder --out converted/       # converts every .blend in the folder
    python blend2glb.py *.blend --out out/ --overwrite   # re-convert, overwrite existing files

    Windows example:
        py blend2glb.py "C:\\Models\\scene.blend" --blender "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe"

After converting: open the produced .glb/.obj in Online 3D Studio (drag & drop), edit, and
export to GLB / OBJ / STL — the full round trip needs no server at all.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Blender's export operators differ across versions; the generated in-Blender script tries them in order.
EXPORT_SCRIPT_TEMPLATE = r"""
import bpy, sys, traceback

fmt = {fmt!r}
out = {out!r}

try:
    if fmt == "glb":
        try:
            bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")
        except AttributeError:
            # glTF exporter addon disabled -> enable it, then retry (Blender >= 2.83)
            bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
            bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")
    else:  # obj
        try:  # Blender 4.x
            bpy.ops.wm.obj_export(filepath=out)
        except AttributeError:
            try:  # Blender 2.8 - 3.x
                bpy.ops.export_scene.obj(filepath=out, path_mode="AUTO")
            except AttributeError:
                raise RuntimeError("No Wavefront OBJ exporter in this Blender build")
    print("AETHER_CONVERT_OK")
except Exception:
    traceback.print_exc()
    print("AETHER_CONVERT_FAIL")
"""

# Places to look for a Blender executable when it is not on PATH.
COMMON_BLENDER_DIRS = [
    r"C:\Program Files\Blender Foundation",          # Windows
    r"C:\Program Files (x86)\Blender Foundation",
    "/Applications",                                  # macOS
    "/usr/bin", "/usr/local/bin", "/opt/blender",     # Linux
    "/snap/bin",
]
BLENDER_BIN_NAMES = ["blender", "blender.exe", "Blender.app/Contents/MacOS/Blender", "blender-launcher.exe"]


def find_blender(explicit: str) -> str:
    """Locate the Blender executable: --blender flag > BLENDER_PATH env > PATH > common dirs."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    env = os.environ.get("BLENDER_PATH")
    if env:
        candidates.append(env)
    candidates.append(shutil.which("blender"))
    for base in COMMON_BLENDER_DIRS:
        if not os.path.isdir(base):
            continue
        for name in BLENDER_BIN_NAMES:
            p = Path(base)
            # Windows keeps versioned subfolders: Blender Foundation\Blender 4.2\blender.exe
            if name.startswith("Blender.app") or name == "blender" and sys.platform != "win32":
                direct = p / name
                if direct.exists():
                    candidates.append(str(direct))
            for child in sorted(p.iterdir(), reverse=True) if p.is_dir() else []:
                cand = child / name if child.is_dir() else None
                if cand and cand.exists():
                    candidates.append(str(cand))
    for c in candidates:
        if c and Path(c).exists():
            return str(Path(c).resolve())
    sys.exit(
        "Blender was not found.\n"
        "  Install Blender (https://www.blender.org/download/) and either:\n"
        "    * make sure 'blender' is on PATH, or\n"
        "    * pass it explicitly:  python blend2glb.py model.blend --blender \"C:\\\\Program Files\\\\Blender Foundation\\\\Blender 4.2\\\\blender.exe\""
    )


def blender_version(blender: str) -> str:
    """Return Blender's version string (used for the log header)."""
    try:
        out = subprocess.run([blender, "--version"], capture_output=True, text=True, timeout=60)
        first = (out.stdout or out.stderr).strip().splitlines()
        return first[0] if first else "unknown version"
    except Exception:
        return "unknown version"


def convert_one(blender: str, blend_path: Path, fmt: str, out_path: Path) -> bool:
    """Run one headless Blender conversion. Returns True on success."""
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as tf:
        tf.write(EXPORT_SCRIPT_TEMPLATE.format(fmt=fmt, out=str(out_path)))
        script_path = tf.name
    cmd = [
        blender, "--background", "--factory-startup",
        str(blend_path), "--python", script_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        combined = (proc.stdout or "") + (proc.stderr or "")
        ok = "AETHER_CONVERT_OK" in combined
        if not ok:
            # Show the most useful lines of Blender's output for debugging.
            tail = "\n".join(
                line for line in combined.strip().splitlines()
                if line.strip() and not line.startswith(("Fra:", "Saved:"))
            )[-1200:]
            print(f"    Blender output (tail):\n{tail}", file=sys.stderr)
        return ok
    except subprocess.TimeoutExpired:
        print("    Timed out after 600 s.", file=sys.stderr)
        return False
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


def collect_inputs(paths, recursive: bool) -> list:
    """Expand the CLI arguments into a de-duplicated list of .blend files."""
    result, seen = [], set()
    for raw in paths:
        p = Path(raw).expanduser()
        if p.is_dir():
            it = p.rglob("*.blend") if recursive else p.glob("*.blend")
            found = sorted(it)
            if not found:
                print(f"  (no .blend files in {p})", file=sys.stderr)
            for f in found:
                if f not in seen:
                    seen.add(f); result.append(f)
        elif p.suffix.lower() == ".blend":
            if p not in seen:
                seen.add(p); result.append(p)
        else:
            print(f"  skipping {p} (not a .blend file or folder)", file=sys.stderr)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="blend2glb.py",
        description="Batch-convert .blend files to .glb or .obj using headless Blender.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="The converted files open directly in Online 3D Studio (index.html).",
    )
    ap.add_argument("inputs", nargs="+", metavar="BLEND_OR_FOLDER",
                    help=".blend file(s), or folder(s) containing .blend files")
    ap.add_argument("--format", choices=["glb", "obj"], default="glb",
                    help="output format (default: glb — recommended, materials/textures embedded)")
    ap.add_argument("--out", metavar="DIR", default=None,
                    help="output folder (default: next to each input file)")
    ap.add_argument("--recursive", action="store_true",
                    help="also search subfolders when a folder is given")
    ap.add_argument("--overwrite", action="store_true",
                    help="re-convert even if the output file already exists")
    ap.add_argument("--blender", metavar="PATH", default=None,
                    help="path to the Blender executable (else PATH / BLENDER_PATH / common locations)")
    args = ap.parse_args()

    blender = find_blender(args.blender)
    blend_files = collect_inputs(args.inputs, args.recursive)
    if not blend_files:
        sys.exit("Nothing to convert — pass .blend files or folders containing them.")

    print(f"Blender : {blender}  ({blender_version(blender)})")
    print(f"Format  : {args.format.upper()}   Files: {len(blend_files)}")

    done, failed, skipped = [], [], []
    for i, src in enumerate(blend_files, 1):
        out_dir = Path(args.out).expanduser() if args.out else src.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{src.stem}.{args.format}"
        tag = f"[{i}/{len(blend_files)}] {src.name}"
        if out_path.exists() and not args.overwrite:
            print(f"{tag} -> {out_path.name}  (exists, skipped; use --overwrite)")
            skipped.append(src)
            continue
        print(f"{tag} -> {out_path} ...", flush=True)
        if convert_one(blender, src, args.format, out_path) and out_path.exists():
            size = fmt_size(out_path.stat().st_size)
            print(f"    OK ({size})")
            done.append(out_path)
        else:
            print(f"    FAILED", file=sys.stderr)
            failed.append(src)

    print("-" * 60)
    print(f"Converted {len(done)}, skipped {len(skipped)}, failed {len(failed)}.")
    for f in failed:
        print(f"  failed: {f}", file=sys.stderr)
    if done:
        print(f"Drop the {args.format.upper()} files into Online 3D Studio to view & edit them.")
    return 0 if not failed else 1


def fmt_size(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{max(n, 1) / 1024:.0f} KB"


if __name__ == "__main__":
    sys.exit(main())
