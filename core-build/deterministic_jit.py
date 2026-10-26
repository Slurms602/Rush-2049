#!/usr/bin/env python3
"""Make flycast-wasm's JIT deterministic for lockstep netplay, keeping its speed features.

The stock JIT decides from the wall clock (a) whether a new block is compiled in this
frame's batch or handed to the browser's background compiler, (b) how many hot blocks get
compiled immediately, and (c) how long the chain sweep may run; chains themselves are
compiled in the background and go live whenever the browser finishes. Each of those makes
a fast and a slow machine execute different code paths at different moments, so their
emulated state drifts apart. Here every decision is made by counts instead:

- new blocks always go to the frame's batch (compiled at the next frame start),
- hot blocks compile immediately up to a per-frame count (2, or 50 during a load storm),
- the chain sweep is bounded by its scan/build counts only,
- chains compile synchronously and are promoted at the next frame start.

Usage: python3 deterministic_jit.py core/rec-wasm/rec_wasm.cpp
"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
if "wasm_compile_chain_now" in src:
    print("already applied")
    sys.exit(0)


def rep(old, new):
    global src
    if src.count(old) != 1:
        raise SystemExit("anchor not found exactly once:\n" + old)
    src = src.replace(old, new)


# Forward declaration next to the async one.
rep("void wasm_compile_chain_async(const u8* bytesPtr, u32 len, u32 head_pc);",
    "void wasm_compile_chain_async(const u8* bytesPtr, u32 len, u32 head_pc);\n"
    "void wasm_compile_chain_now(const u8* bytesPtr, u32 len, u32 head_pc);")

# Synchronous chain compile that feeds the same promotion queue as the async one.
rep("EM_JS(void, wasm_compile_chain_async, (const u8* bytesPtr, u32 len, u32 head_pc), {", r"""// Lockstep netplay: compile a chain synchronously and queue it for promotion at the
// next frame start (drainChainQueue), so it goes live on the same frame everywhere.
EM_JS(void, wasm_compile_chain_now, (const u8* bytesPtr, u32 len, u32 head_pc), {
	if (!Module._flyChainReady) Module._flyChainReady = [];
	if (!Module._flyChainFail) Module._flyChainFail = [];
	try {
		var mod = new WebAssembly.Module(Module.HEAPU8.slice(bytesPtr, bytesPtr + len));
		var instance = new WebAssembly.Instance(mod, { env: Module._jitImports });
		var table = wasmTable;
		if (!Module._jitTableBase) {
			Module._jitTableBase = table.length;
			Module._jitNextIdx = table.length;
			table.grow(4096);
		}
		var idx = Module._jitNextIdx++;
		if (idx >= table.length)
			table.grow(4096);
		table.set(idx, instance.exports.b);
		if (!Module._wasmChainCache) Module._wasmChainCache = {};
		Module._wasmChainCache[head_pc] = instance.exports.b;
		if (!Module._wasmChainIdx) Module._wasmChainIdx = {};
		Module._wasmChainIdx[head_pc] = idx;
		Module._flyChainReady.push({ pc: head_pc, idx: idx });
	} catch (e) {
		if (!Module._flyQ) console.error('[chain] compile fail head=0x' + (head_pc >>> 0).toString(16) + ': ' + e.message);
		Module._flyChainFail.push(head_pc);
	}
});
EM_JS(void, wasm_compile_chain_async, (const u8* bytesPtr, u32 len, u32 head_pc), {""")

# Non-emscripten stub, for completeness.
rep("static void wasm_compile_chain_async(const u8*, u32, u32) {}",
    "static void wasm_compile_chain_async(const u8*, u32, u32) {}\n"
    "static void wasm_compile_chain_now(const u8*, u32, u32) {}")

# Per-frame counter of hot blocks compiled immediately.
rep("static u32 g_bridged_this_frame = 0;",
    "static u32 g_bridged_this_frame = 0;\n"
    "static u32 g_hot_sync_this_frame = 0;   // lockstep: count-based hot compile budget")
rep("\t\tg_bridged_this_frame = 0;\n",
    "\t\tg_bridged_this_frame = 0;\n\t\tg_hot_sync_this_frame = 0;\n")

# (b) Hot-block budget by count (about 1 ms per compile), not by measured time.
rep("""										double fly_sync_budget = (g_bridged_this_frame > FLY_STORM_BRIDGED_THRESHOLD)
										                         ? 50.0 : FLY_SYNC_COMPILE_BUDGET_MS;
										if (!g_defer_runtime
										    || (force_hot && compileTimeThisFrame < fly_sync_budget)) {
											double t0 = emscripten_get_now();
											rdv_FailedToFindBlock(miss_pc);
											compilesThisFrame++;""",
    """										// Lockstep netplay: budget by count (~1 ms per compile),
										// so every machine makes the same choice.
										u32 fly_sync_budget = (g_bridged_this_frame > FLY_STORM_BRIDGED_THRESHOLD)
										                      ? 50 : 2;
										if (!g_defer_runtime
										    || (force_hot && g_hot_sync_this_frame < fly_sync_budget)) {
											double t0 = emscripten_get_now();
											rdv_FailedToFindBlock(miss_pc);
											g_hot_sync_this_frame++;
											compilesThisFrame++;""")

# (a) Deferred misses always queue for the frame's batch.
rep("""										} else if (!fly_frame_over_budget()
										           || g_bridged_this_frame > FLY_STORM_BRIDGED_THRESHOLD) {""",
    """										} else {   // lockstep netplay: always queue (was: unless over the frame's time budget)""")

# (a) New blocks always batch, never the background compiler.
rep("""								g_compile_batch = g_defer_runtime && !fly_frame_over_budget();""",
    """								g_compile_batch = g_defer_runtime;   // lockstep netplay: never async""")

# (c) Chain sweep bounded by counts only; chains compile synchronously.
rep("""				if (emscripten_get_now() - cs_t0 > cs_ms_cap)
					break;
""", "")
rep("""				wasm_compile_chain_async(cbytes.data(), (u32)cbytes.size(), v);""",
    """				wasm_compile_chain_now(cbytes.data(), (u32)cbytes.size(), v);   // lockstep netplay""")

open(path, "w", encoding="utf-8").write(src)
print("applied")
