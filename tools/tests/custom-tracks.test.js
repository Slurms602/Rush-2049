// Run: node --test tools/tests/custom-tracks.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "../..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const digest = (data) => createHash("sha256").update(data).digest("hex");
const names = ["TRACK1.LZS", "TRACK1ROAD.LZS", "TRACK1PATH.LZS", "TRACK1PATHBACK.LZS", "TRACK1WORLDS.LZS"];
const turn = () => new Promise(setImmediate);

function loader({ corrupt = false, missing = false, select = "neon-skyway" } = {}) {
    const data = new Uint8Array([1, 2, 3]), installed = [];
    const manifest = { id: select === "original" ? "neon-skyway" : select, version: 1, slot: 1,
        files: names.map((name) => ({ name, bytes: data.length, sha256: digest(data) })) };
    if (missing) manifest.files.pop();
    const c = vm.createContext({ URL, URLSearchParams, Uint8Array, TextEncoder, crypto: webcrypto,
        location: new URL("https://example.test/Rush-2049/?track=" + select + "&join=ABCDE"),
        DC_MODS: { install: (files) => installed.push(files) },
        fetch: async (url) => new Response(String(url).endsWith("manifest.json") ? JSON.stringify(manifest)
            : corrupt ? new Uint8Array([3, 2, 1]) : data) });
    c.window = c;
    vm.runInContext(source("track-loader.js"), c);
    return { c, installed };
}

test("custom bundle verifies every file before installation and has a stable fingerprint", async () => {
    const a = loader(), b = loader();
    await a.c.DC_TRACK.install();
    await b.c.DC_TRACK.install();
    assert.equal(a.installed.length, 1);
    assert.equal(a.installed[0].length, 5);
    assert.equal(a.c.DC_TRACK.fingerprint, b.c.DC_TRACK.fingerprint);
    assert.match(a.c.DC_TRACK.fingerprint, /^neon-skyway:1:[a-f0-9]{64}$/);
    assert.equal(a.c.DC_TRACK.ready, true);
    assert.equal(new URL(a.c.DC_TRACK.url("original")).searchParams.has("join"), false);
    assert.equal(new URL(a.c.DC_TRACK.url("original")).searchParams.has("track"), false);
});

test("corrupt and incomplete bundles never install", async () => {
    for (const options of [{ corrupt: true }, { missing: true }]) {
        const { c, installed } = loader(options);
        await assert.rejects(c.DC_TRACK.install());
        assert.equal(installed.length, 0);
        assert.equal(c.DC_TRACK.ready, false);
    }
});

test("chemical track has its own catalog entry, bundle identity and invite selection", async () => {
    const a = loader({ select: "chemical-circuit" }), b = loader();
    await a.c.DC_TRACK.install(); await b.c.DC_TRACK.install();
    assert.equal(a.c.DC_TRACK.name, "Chemical Circuit");
    assert.equal(a.installed[0].length, 5);
    assert.match(a.c.DC_TRACK.fingerprint, /^chemical-circuit:1:[a-f0-9]{64}$/);
    assert.notEqual(a.c.DC_TRACK.fingerprint, b.c.DC_TRACK.fingerprint);
    assert.equal(new URL(a.c.DC_TRACK.url("chemical-circuit", { leaveRoom: false })).searchParams.get("join"), "ABCDE");
});

test("original mode requires no downloaded files; unknown selections fail", async () => {
    const { c, installed } = loader({ select: "original" });
    c.fetch = () => { throw new Error("Original mode must not fetch track data"); };
    await c.DC_TRACK.install();
    assert.equal(c.DC_TRACK.fingerprint, "original");
    assert.equal(installed.length, 0);
    await assert.rejects(loader({ select: "typo" }).c.DC_TRACK.install(), /Unknown/);
});

test("setup selection preserves the invite and can change before boot without reloading", async () => {
    const { c, installed } = loader({ select: "original" });
    c.DC_TRACK.select("neon-skyway");
    assert.equal(c.DC_TRACK.id, "neon-skyway");
    const setup = new URL(c.DC_TRACK.url("neon-skyway", { pick: true, leaveRoom: false }));
    assert.equal(setup.searchParams.get("join"), "ABCDE");
    assert.equal(setup.searchParams.get("track"), "neon-skyway");
    assert.equal(setup.searchParams.has("pick"), true);
    await c.DC_TRACK.install();
    assert.equal(installed[0].length, 5);
    assert.throws(() => c.DC_TRACK.select("original"), /restarting/);
    assert.equal(new URL(c.DC_TRACK.url("original")).searchParams.has("join"), false);
});

function modDisc(discNames = names) {
    const sector = 2048, directoryLBA = 45100, directory = new Uint8Array(sector), pvd = new Uint8Array(sector);
    pvd.set([1, 67, 68, 48, 48, 49, 1]);
    const pv = new DataView(pvd.buffer);
    pv.setUint32(158, directoryLBA, true); pv.setUint32(166, sector, true);
    let off = 0;
    for (const [i, name] of discNames.entries()) {
        const len = 34 + name.length;
        directory[off] = len; directory[off + 32] = name.length;
        directory.set(Buffer.from(name), off + 33);
        const dv = new DataView(directory.buffer, off);
        dv.setUint32(2, 45200 + i, true); dv.setUint32(6, 45200 + i, false); dv.setUint32(10, sector, true);
        off += len;
    }
    const patches = [], heap = new Uint8Array(1024 * 1024);
    const Module = { HEAPU8: heap, _malloc: () => 8192, _free() {},
        _fly_disc_read(fad, count, ptr) {
            heap.set(fad === 45016 + 150 ? pvd : directory, ptr); return count;
        },
        _fly_disc_patch_add(fad, count, ptr) { patches.push({ fad, count, data: heap.slice(ptr, ptr + count * sector) }); } };
    const c = vm.createContext({ Uint8Array, console, EJS_emulator: { gameManager: { Module } } });
    c.window = c; vm.runInContext(source("mods.js"), c);
    return { c, patches, pvd };
}

test("disc installer rejects the complete invalid plan before patching any sectors", () => {
    for (const invalid of [{ name: "NOTHERE.LZS", data: new Uint8Array(10) },
        { name: names[1], data: new Uint8Array(2049) }, { name: names[0], data: new Uint8Array(10) }]) {
        const { c, patches } = modDisc();
        assert.throws(() => c.DC_MODS.install([{ name: names[0], data: new Uint8Array(10) }, invalid]));
        assert.equal(patches.length, 0);
    }
});

test("disc installer patches data plus both byte orders of the directory file size", () => {
    const { c, patches } = modDisc();
    c.DC_MODS.install([{ name: names[0], data: new Uint8Array(100) }]);
    assert.equal(patches.length, 2);
    const dv = new DataView(patches[1].data.buffer);
    assert.equal(dv.getUint32(10, true), 100);
    assert.equal(dv.getUint32(14, false), 100);
});

test("disc installer rejects unsupported image filesystem before mutation", () => {
    const { c, patches, pvd } = modDisc();
    pvd[1] = 0;
    assert.throws(() => c.DC_MODS.install([{ name: names[0], data: new Uint8Array(10) }]), /GDI/);
    assert.equal(patches.length, 0);
});

function network() {
    const peers = new Map(), sent = [];
    let nextID = 0;
    class Connection extends EventEmitter {
        constructor(peer, options) { super(); this.peer = peer; Object.assign(this, options); this.open = false; }
        send(msg) { sent.push(msg); queueMicrotask(() => { if (this.other.open) this.other.emit("data", msg); }); }
        close() { this.open = false; this.other.open = false; }
    }
    class Peer extends EventEmitter {
        constructor(id) { super(); this.id = typeof id === "string" ? id : "guest" + nextID++; peers.set(this.id, this);
            queueMicrotask(() => { this.open = true; this.emit("open"); }); }
        connect(id, options) {
            const local = new Connection(id, options), remote = new Connection(this.id, options);
            local.other = remote; remote.other = local;
            queueMicrotask(() => { peers.get(id).emit("connection", remote); queueMicrotask(() => {
                local.open = remote.open = true; local.emit("open"); remote.emit("open");
            }); });
            return local;
        }
        destroy() { peers.delete(this.id); }
    }
    function page(fingerprint) {
        const elements = new Map(["net-panel", "net-body", "net-status"].map((id) => [id, { hidden: true, contains: () => false }]));
        let loads = 0;
        const c = vm.createContext({ console, URL, URLSearchParams, performance, Blob, Response, CompressionStream, DecompressionStream,
            Uint8Array, Peer, location: new URL("https://example.test/Rush-2049/?track=neon-skyway"),
            setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
            document: { getElementById: (id) => elements.get(id) || null },
            DC_TRACK: { id: fingerprint.split(":")[0], ready: true, fingerprint },
            EJS_emulator: { gameManager: { Module: { _fly_set_lockstep() {} }, simulateInput() {},
                getState: () => new Uint8Array([1, 2, 3]), loadState() { loads++; }, setVSync() {}, setVariable() {} } } });
        c.window = c; vm.runInContext(source("netplay.js"), c);
        return { c, elements, get loads() { return loads; } };
    }
    return { page, sent };
}

test("online rejects original/custom and different custom builds before transferring state", async () => {
    for (const other of ["original", "neon-skyway:1:other-build", "chemical-circuit:1:verified-build"]) {
        const { page, sent } = network(), host = page("neon-skyway:1:verified-build"), guest = page(other);
        host.c.DC_NET.host(); await turn();
        guest.c.DC_NET.join(host.c.DC_NET.code); await turn(); await turn();
        assert.equal(guest.c.DC_NET.role, null);
        assert.equal([...host.c.DC_NET.conns.values()].some((c) => c.accepted), false);
        assert.equal(sent.some((m) => m.t === "state" || m.t === "welcome"), false);
        assert.match(guest.elements.get("net-status").textContent, /different track/);
        assert.equal(guest.loads, 0);
    }
});

test("matching track builds join, share the selection, and transfer a game state", async () => {
    const { page, sent } = network(), host = page("neon-skyway:1:verified-build"), guest = page("neon-skyway:1:verified-build");
    host.c.DC_NET.host(); await turn();
    guest.c.DC_NET.join(host.c.DC_NET.code); await turn(); await turn();
    assert.equal(guest.c.DC_NET.mySlot, 1);
    assert.match(host.elements.get("net-body").innerHTML, /track=neon-skyway/);
    await host.c.DC_NET.startMatch("test");
    for (let i = 0; i < 30 && !guest.loads; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host.loads, 1); assert.equal(guest.loads, 1);
    assert.equal(sent.filter((m) => m.t === "state").length, 1);
});

function detectView({ pause = false, black = false } = {}) {
    const w = 640, h = 480, pixels = new Uint8Array(w * h * 4);
    const row = (y, rgb) => {
        for (let x = 0; x < w; x++) pixels.set([...rgb, 255], (y * w + x) * 4);
    };
    for (let y = 0; y < h; y++) row(y, black ? [0, 0, 0] : [70, 80, 110]);
    if (!black) {
        // Measured sky color from the real custom race. Two thin sky bands must
        // not masquerade as the two horizontal edges of a pause menu.
        for (const y0 of [30, 270]) for (let y = y0; y < y0 + 7; y++) row(y, [41, 32, 123]);
        for (let y = 229; y < 232; y++) row(y, [0, 0, 0]);
        if (pause) for (const y0 of [80, 300]) for (let y = y0; y < y0 + 2; y++) row(y, [0, 0, 132]);
    }
    const gl = { drawingBufferWidth: w, drawingBufferHeight: h,
        readPixels(left, bottom, width, height, _format, _type, output) {
            for (let y = 0; y < height; y++) {
                const start = ((h - 1 - bottom - y) * w + left) * 4;
                output.set(pixels.subarray(start, start + width * 4), y * width * 4);
            }
        } };
    const c = vm.createContext({ Uint8Array, EJS_emulator: { canvas: { getContext: () => gl } }, addEventListener() {} });
    c.window = c; vm.runInContext(source("myview.js"), c);
    return c.DC_VIEW.detect();
}

test("purple sky bands keep the two-player race cropped to each player's view", () => {
    assert.equal(detectView(), "halves");
});

test("pause menu outlines and black loading screens still show the complete screen", () => {
    assert.equal(detectView({ pause: true }), null);
    assert.equal(detectView({ black: true }), null);
});

test('Doodle Dimension installs its shipped files with verified hashes and its own room identity', async () => {
    const { c, installed } = loader({ select: 'doodle-dimension' });
    c.fetch = async (url) => {
        const filename = new URL(url).pathname.split('/').pop();
        return new Response(fs.readFileSync(path.join(root, 'tracks/doodle-dimension', filename)));
    };
    await c.DC_TRACK.install();
    assert.equal(c.DC_TRACK.name, 'Doodle Dimension');
    assert.equal(installed[0].length, 6);
    assert.equal(installed[0][5].aliases.length, 17);
    assert.match(c.DC_TRACK.fingerprint, /^doodle-dimension:2:[a-f0-9]{64}$/);
    assert.equal(new URL(c.DC_TRACK.url('doodle-dimension', { leaveRoom: false })).searchParams.get('join'), 'ABCDE');
});


test('native soundtrack aliases share one patched extent and invalid aliases leave the disc intact', () => {
    const streams = ['BASSY.STR', 'FLIER.STR', 'MORNING.STR'];
    const { c, patches } = modDisc(streams);
    c.DC_MODS.install([{ name: streams[0], data: new Uint8Array(100), aliases: streams.slice(1) }]);
    assert.equal(patches.length, 2);
    const bytes = patches[1].data; let off = 0;
    for (const name of streams) {
        const v = new DataView(bytes.buffer, off);
        assert.equal(v.getUint32(2, true), 45200);
        assert.equal(v.getUint32(6, false), 45200);
        assert.equal(v.getUint32(10, true), 100);
        assert.equal(v.getUint32(14, false), 100);
        off += 34 + name.length;
    }
    for (const aliases of [['MISSING.STR'], ['FLIER.STR', 'FLIER.STR'], ['../GAME.BIN']]) {
        const bad = modDisc(streams);
        assert.throws(() => bad.c.DC_MODS.install([{ name: streams[0], data: new Uint8Array(100), aliases }]));
        assert.equal(bad.patches.length, 0);
    }
});

test('a corrupt soundtrack prevents all installation', async () => {
    const { c, installed } = loader({ select: 'doodle-dimension' });
    c.fetch = async (url) => {
        const filename = new URL(url).pathname.split('/').pop();
        const data = fs.readFileSync(path.join(root, 'tracks/doodle-dimension', filename));
        if (filename === 'SOUNDTRACK.STR') data[2048] ^= 1;
        return new Response(data);
    };
    await assert.rejects(c.DC_TRACK.install(), /incomplete or out of date/);
    assert.equal(installed.length, 0);
    assert.equal(c.DC_TRACK.ready, false);
});
