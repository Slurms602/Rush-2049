#!/usr/bin/env python3
"""Local server for Dreamcast Web.

Sends the cross-origin isolation headers the core needs, and can auto-run a game straight
from your disk without copying it anywhere:

    python3 serve.py                      # uses config.json if present
    python3 serve.py --game "~/Some Game/game.cue" --bios ~/dreamcast-web/bios

config.json (git-ignored) looks like:
    {"game": "~/Some Game/game.cue", "bios": "bios"}

Only the files belonging to that game and BIOS are served, and only on 127.0.0.1.
"""
import argparse
import http.server
import json
import os
import re
import shutil
import webbrowser
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
DISC_EXTS = (".gdi", ".cue", ".cdi", ".chd", ".m3u")
BIOS_NAMES = ("dc_boot.bin", "dc_flash.bin")


def game_files(path):
    """The main image plus the track files it references (from a .cue or .gdi)."""
    if os.path.isdir(path):
        mains = sorted(f for f in os.listdir(path) if f.lower().endswith(DISC_EXTS))
        if not mains:
            raise SystemExit(f"No .gdi/.cue/.cdi/.chd found in {path}")
        path = os.path.join(path, mains[0])
    folder = os.path.dirname(path)
    files = [path]
    if path.lower().endswith((".cue", ".gdi")):
        text = open(path, encoding="utf-8", errors="replace").read()
        if path.lower().endswith(".cue"):
            names = re.findall(r'FILE\s+"([^"]+)"', text)
        else:  # gdi lines: <track> <lba> <type> <sector size> <file> <offset>
            names = [n.strip('"') for n in re.findall(r'^[ \t]*\d+[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]+("[^"]+"|\S+)', text, re.M)]
        files += [os.path.join(folder, n) for n in names]
    missing = [f for f in files if not os.path.isfile(f)]
    if missing:
        raise SystemExit("Missing game files:\n  " + "\n  ".join(missing))
    return files


def bios_files(folder):
    if not folder or not os.path.isdir(folder):
        return []
    found = {f.lower(): os.path.join(folder, f) for f in os.listdir(folder)}
    return [found[n] for n in BIOS_NAMES if n in found]


def load_config(args):
    cfg = {}
    cfg_path = os.path.join(ROOT, "config.json")
    if os.path.isfile(cfg_path):
        cfg = json.load(open(cfg_path))
    game = args.game or cfg.get("game")
    bios = args.bios or cfg.get("bios") or "bios"
    resolve = lambda p: os.path.join(ROOT, os.path.expanduser(p)) if p else None
    game, bios = resolve(game), resolve(bios)
    served = {}
    manifest = {"game": [], "bios": []}
    for kind, paths in (("game", game_files(game) if game else []), ("bios", bios_files(bios))):
        for p in paths:
            key = f"{kind}/{len(served)}"
            served[key] = p
            manifest[kind].append({"name": os.path.basename(p), "size": os.path.getsize(p), "url": "/local/" + key})
    return manifest, served, bios


parser = argparse.ArgumentParser()
parser.add_argument("port", nargs="?", type=int, default=8080)
parser.add_argument("--game", help="path to a .cue/.gdi/.cdi/.chd (or a folder containing one)")
parser.add_argument("--bios", help="folder containing dc_boot.bin and dc_flash.bin (default: ./bios)")
parser.add_argument("--no-browser", action="store_true")
args = parser.parse_args()
MANIFEST, SERVED, BIOS_DIR = load_config(args)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        # no-store: a browser must never copy a 1 GB disc image into its cache
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/local/") else "no-cache")
        super().end_headers()

    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        if path == "/autorun.json":
            body = json.dumps(MANIFEST).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path.startswith("/local/"):
            real = SERVED.get(path[len("/local/"):])
            if not real:
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.path.getsize(real)))
            self.end_headers()
            with open(real, "rb") as f:
                try:
                    shutil.copyfileobj(f, self.wfile, 4 << 20)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        else:
            super().do_GET()


url = f"http://localhost:{args.port}/"
print(f"Dreamcast Web running at {url}  (Ctrl+C to stop)")
if MANIFEST["game"]:
    print("Auto-run game:", ", ".join(f["name"] for f in MANIFEST["game"]))
    if not MANIFEST["bios"]:
        print(f"No BIOS in {BIOS_DIR}; using Flycast's built-in HLE BIOS.")
if not args.no_browser:
    webbrowser.open(url)
http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
