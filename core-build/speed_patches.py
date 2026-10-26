#!/usr/bin/env python3
"""Remove JavaScript round trips from flycast-wasm's hot path (apply after deterministic_jit.py).

Profiling a Rush 2049 race showed ~40% of main-thread time spent in JavaScript glue:

1. c_dispatch_loop (the loop that calls each compiled block) was inlined into the
   executor's try/catch. Emscripten's JS-based C++ exceptions turn every call inside a try
   into an invoke_* trampoline through JavaScript, and the exports those trampolines use
   are wrapped again by Asyncify. Keeping the loop out of line makes block calls plain
   call_indirect; only entering the loop goes through the trampoline.
2. Compiled blocks import their memory/division/fallback helpers from Module._wasm_*,
   which are Asyncify's JS wrappers. They now get the raw wasm functions from the
   function table, so V8 links them as direct wasm-to-wasm calls.
3. The sound chip's update (44,100 times a second) timed itself with performance.now();
   those diagnostics are dropped from release builds.

Usage (from the patched flycast source root): python3 speed_patches.py .
"""
import os
import re
import sys

root = sys.argv[1]


def patch(rel, edits):
    path = os.path.join(root, rel)
    src = open(path, encoding="utf-8").read()
    if "speed_patches" in src:
        print(rel, "already applied")
        return
    for old, new, regex in edits:
        if regex:
            new_src, n = re.subn(old, new, src, flags=re.S)
            if n == 0:
                raise SystemExit(f"{rel}: pattern not found: {old[:80]}")
            src = new_src
        else:
            if src.count(old) != 1:
                raise SystemExit(f"{rel}: anchor not found exactly once:\n{old}")
            src = src.replace(old, new)
    open(path, "w", encoding="utf-8").write(src)
    print(rel, "applied")


HELPERS = ["read8", "read16", "read32", "write8", "write16", "write32",
           "ifb", "shil_fb", "sq_pref", "div32u", "div32s", "div1"]
FUNCS = ["wasm_mem_read8", "wasm_mem_read16", "wasm_mem_read32", "wasm_mem_write8",
         "wasm_mem_write16", "wasm_mem_write32", "wasm_exec_ifb", "wasm_exec_shil_fb",
         "wasm_sq_pref", "wasm_div32u", "wasm_div32s", "wasm_div1"]

imports_js = ("Module._jitImports = (function() {\n"
              "\t\t\t// speed_patches: raw wasm helpers from the table (direct wasm-to-wasm calls)\n"
              "\t\t\tvar p = Module['_fly_jit_helper_ptrs'] ? (Module['_fly_jit_helper_ptrs']() >> 2) : 0;\n"
              "\t\t\tvar f = function(i, js) { var q = p ? HEAPU32[p + i] : 0; return q ? wasmTable.get(q) : js; };\n"
              "\t\t\treturn { memory: wasmMemory,\n"
              + "".join(f"\t\t\t\t{h}: f({i}, Module._{fn}),\n" for i, (h, fn) in enumerate(zip(HELPERS, FUNCS)))
              + "\t\t\t};\n\t\t})();")
imports_re = r"Module\._jitImports = \{\s*memory: wasmMemory,\s*" + r",\s*".join(
    rf"{h}:\s*Module\._{fn}" for h, fn in zip(HELPERS, FUNCS)) + r"\s*\};"

ptrs_c = ("\n// speed_patches: helper addresses for the JIT's import object (see Module._jitImports).\n"
          "extern \"C\" EMSCRIPTEN_KEEPALIVE u32* fly_jit_helper_ptrs() {\n"
          "\tstatic u32 p[12];\n"
          + "".join(f"\tp[{i}] = (u32)(uintptr_t)&{fn};\n" for i, fn in enumerate(FUNCS))
          + "\treturn p;\n}\n\n")

patch("core/rec-wasm/rec_wasm.cpp", [
    ("static int c_dispatch_loop(u32 ctx_ptr, u32 ram_base) {",
     "// speed_patches: never inline into the executor's try/catch (JS exception trampolines).\n"
     "__attribute__((noinline)) static int c_dispatch_loop(u32 ctx_ptr, u32 ram_base) {", False),
    (imports_re, imports_js.replace("\\", "\\\\"), True),
    ("EM_JS(int, wasm_compile_block, (const u8* bytesPtr, u32 len, u32 block_pc), {",
     ptrs_c + "EM_JS(int, wasm_compile_block, (const u8* bytesPtr, u32 len, u32 block_pc), {", False),
])

patch("core/hw/aica/aica.cpp", [
    ("#ifdef __EMSCRIPTEN__\n\t// Render-phase timer [5]", "#if defined(__EMSCRIPTEN__) && !defined(JIT_PROD_BUILD)   // speed_patches\n\t// Render-phase timer [5]", False),
    ("#ifdef __EMSCRIPTEN__\n\textern double g_fly_rp[10];\n\tdouble fly_t0 = emscripten_get_now();\n#endif\n\tfor (auto& timer : timers)",
     "#if defined(__EMSCRIPTEN__) && !defined(JIT_PROD_BUILD)\n\textern double g_fly_rp[10];\n\tdouble fly_t0 = emscripten_get_now();\n#endif\n\tfor (auto& timer : timers)", False),
    ("\tUpdateSh4Ints();\n#ifdef __EMSCRIPTEN__\n\tg_fly_rp[5] += emscripten_get_now() - fly_t0;\n#endif",
     "\tUpdateSh4Ints();\n#if defined(__EMSCRIPTEN__) && !defined(JIT_PROD_BUILD)\n\tg_fly_rp[5] += emscripten_get_now() - fly_t0;\n#endif", False),
])
