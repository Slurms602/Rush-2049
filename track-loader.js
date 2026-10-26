// Load only authored track files. Game and BIOS data always come from the player's disc.
(function () {
    "use strict";
    let id = new URLSearchParams(location.search).get("track") || "original";
    const track = window.DC_TRACK = { id, name: id === "original" ? "Original tracks" : "Neon Skyway", ready: false, fingerprint: null };
    const expected = ["TRACK1.LZS", "TRACK1ROAD.LZS", "TRACK1PATH.LZS", "TRACK1PATHBACK.LZS", "TRACK1WORLDS.LZS"];
    const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    const sha = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
    let prepared;

    track.select = function (selection) {
        if (prepared) throw new Error("Changing tracks after boot requires restarting the game");
        if (!["original", "neon-skyway"].includes(selection)) throw new Error("Unknown custom track: " + selection);
        id = selection;
        track.id = id;
        track.name = id === "original" ? "Original tracks" : "Neon Skyway";
    };

    async function fetchOK(url) {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error("Could not load the custom track (" + res.status + "). Reload and try again.");
        return res;
    }

    track.prepare = function () {
        if (prepared) return prepared;
        prepared = (async () => {
            if (id === "original") { track.fingerprint = "original"; return []; }
            if (id !== "neon-skyway") throw new Error("Unknown custom track: " + id);
            const base = new URL("tracks/" + id + "/", location.href);
            const manifest = await (await fetchOK(new URL("manifest.json", base))).json();
            if (manifest.id !== id || manifest.slot !== 1 || !Number.isSafeInteger(manifest.version) || manifest.version < 1
                || !Array.isArray(manifest.files) || manifest.files.length !== expected.length
                || expected.some((n) => manifest.files.filter((f) => f.name === n).length !== 1)) {
                throw new Error("The custom track manifest is invalid. Reload and try again.");
            }
            const files = await Promise.all(manifest.files.map(async (f) => {
                if (!Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256)) {
                    throw new Error("The custom track manifest has invalid file details.");
                }
                const url = new URL(f.url || f.name, base);
                if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("Invalid custom track file URL");
                const data = new Uint8Array(await (await fetchOK(url)).arrayBuffer());
                if (data.length !== f.bytes || await sha(data) !== f.sha256) {
                    throw new Error("The custom track download is incomplete or out of date. Reload and try again.");
                }
                return { name: f.name, data, sha256: f.sha256 };
            }));
            const identity = files.map((f) => f.name + ":" + f.sha256).sort().join("\n");
            track.fingerprint = id + ":" + manifest.version + ":" + await sha(new TextEncoder().encode(identity));
            return files;
        })();
        return prepared;
    };

    track.install = async function () {
        const files = await track.prepare();
        if (files.length) window.DC_MODS.install(files);
        track.ready = true;
    };

    track.url = function (selection, { pick = false, leaveRoom = true } = {}) {
        const url = new URL(location.href);
        if (leaveRoom) url.searchParams.delete("join");
        url.searchParams.delete("pick");
        if (selection === "original") url.searchParams.delete("track");
        else url.searchParams.set("track", selection);
        if (pick) url.searchParams.set("pick", "");
        return url.href;
    };
})();
