#!/usr/bin/env python3
"""Build ejs/data/cores/flycast-wasm.data from the flycast-wasm v1.0 release.

The release core was linked without libzip, so its zip_* imports are Emscripten stubs
that abort. Flycast needs zip to read resources embedded in the binary (HLE BIOS font,
default flash images), so the HLE BIOS couldn't start. This routes those stubs to
tools/libzip-shim.js and packages the result the way EmulatorJS expects a core.

    python3 tools/package-core.py
"""
import json
import os
import re
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE = "https://github.com/nasomers/flycast-wasm/releases/download/v1.0/"
CORE_FILES = ("flycast_libretro.js", "flycast_libretro.wasm")
OUT = os.path.join(ROOT, "ejs/data/cores/flycast-wasm.data")
CORE_JSON = {
    "name": "flycast",
    "extensions": ["cdi", "gdi", "chd", "cue", "iso", "elf", "bin", "lst", "zip", "7z", "dat"],
    "options": {},
    "save": "srm",
    "license": "GPLv2",
    "repo": "https://github.com/flyinghead/flycast",
}
STUB = re.compile(r'function _zip_(\w+)\(\)\{abort\("missing function: zip_\1"\)\}')

for name in CORE_FILES:
    path = os.path.join(ROOT, name)
    if not os.path.exists(path):
        print("Downloading", name)
        urllib.request.urlretrieve(RELEASE + name, path)

js = open(os.path.join(ROOT, "flycast_libretro.js"), encoding="utf-8").read()
stubs = STUB.findall(js)
if len(stubs) != 12:
    raise SystemExit(f"Expected 12 zip stubs in the core, found {len(stubs)}: {stubs}")

# Create the shim instance in the module's scope, where HEAPU8 and _malloc live,
# right before the first stub, then point every stub at it.
first = STUB.search(js).start()
js = js[:first] + "var __dczip=DCLibzip.create(()=>HEAPU8,n=>_malloc(n));" + js[first:]
js = STUB.sub(lambda m: f"function _zip_{m.group(1)}(...a){{return __dczip.{m.group(1)}(...a)}}", js)
shim = open(os.path.join(ROOT, "tools/libzip-shim.js"), encoding="utf-8").read()

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("flycast_libretro.js", shim + "\n" + js)
    z.write(os.path.join(ROOT, "flycast_libretro.wasm"), "flycast_libretro.wasm")
    z.writestr("core.json", json.dumps(CORE_JSON))
    z.write(os.path.join(ROOT, "LICENSE-flycast.txt"), "license.txt")

print(f"Patched {len(stubs)} zip functions -> {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB)")
