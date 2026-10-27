// Disc mods: custom files the game reads as if they were on the player's disc. The core
// (core-build/disc_patch.py) returns sectors the page supplies instead of the image's; this
// builds those sectors from the player's own disc directory plus the mod's files, the same way
// on every player's machine, so online play stays in sync.
(function () {
    "use strict";
    const SECTOR = 2048;
    const PVD_LBA = 45016;          // ISO 9660 volume descriptor of the GD-ROM high-density area
    const fad = (lba) => lba + 150;
    const core = () => window.EJS_emulator.gameManager.Module;

    function read(lba, count) {
        const M = core(), ptr = M._malloc(count * SECTOR);
        if (!ptr) throw new Error("Not enough memory to read the disc");
        try {
            if (M._fly_disc_read(fad(lba), count, ptr) !== count) throw new Error("Could not read the game disc");
            return M.HEAPU8.slice(ptr, ptr + count * SECTOR);
        } finally { M._free(ptr); }
    }

    function patch(lba, bytes) {
        const M = core(), count = Math.ceil(bytes.length / SECTOR), ptr = M._malloc(count * SECTOR);
        if (!ptr) throw new Error("Not enough memory to install the track");
        try {
            M.HEAPU8.fill(0, ptr, ptr + count * SECTOR);
            M.HEAPU8.set(bytes, ptr);
            M._fly_disc_patch_add(fad(lba), count, ptr);
        } finally { M._free(ptr); }
    }

    // The root directory: each file's name, extent, size and where its record sits.
    function rootDir() {
        const raw = read(PVD_LBA, 1);
        if (raw[0] !== 1 || String.fromCharCode(...raw.subarray(1, 6)) !== "CD001") {
            throw new Error("Custom tracks need the Rush 2049 US GDI disc or a CHD made from it");
        }
        const pvd = new DataView(raw.buffer);
        const lba = pvd.getUint32(156 + 2, true), size = pvd.getUint32(156 + 10, true);
        if (!lba || size < 34 || size > 1024 * 1024) throw new Error("Unsupported disc directory");
        const data = read(lba, Math.ceil(size / SECTOR));
        const records = [];
        for (let o = 0; o < size; ) {
            const len = data[o];
            if (!len) { o = (Math.floor(o / SECTOR) + 1) * SECTOR; continue; }
            if (len < 34 || o + len > size || data[o + 32] > len - 33) throw new Error("Invalid disc directory record");
            const v = new DataView(data.buffer, o);
            const name = String.fromCharCode(...data.subarray(o + 33, o + 33 + data[o + 32])).split(";")[0];
            records.push({ off: o, name, lba: v.getUint32(2, true), size: v.getUint32(10, true) });
            o += len;
        }
        return { lba, size, data, records };
    }

    // ISO 9660 stores numbers twice: little-endian, then big-endian.
    function setBoth(buf, off, value) {
        const v = new DataView(buf.buffer, buf.byteOffset);
        v.setUint32(off, value, true);
        v.setUint32(off + 4, value, false);
    }

    // files: [{ name: "TRACK1ROAD.LZS", data: Uint8Array }]. Each replaces the file of that name,
    // in the space the original occupies.
    function install(files) {
        if (!core()._fly_disc_patch_add) throw new Error("this core can't patch the disc");
        const dir = rootDir();
        const planned = [], names = new Set();
        for (const f of files) {
            if (typeof f.name !== "string" || !(f.data instanceof Uint8Array) || !f.data.length) throw new Error("Invalid track file");
            const name = f.name.toUpperCase();
            if (names.has(name)) throw new Error("Duplicate track file: " + name);
            names.add(name);
            const rec = dir.records.find((r) => r.name === name);
            if (!rec) throw new Error(f.name + " is not on the disc");
            if (f.data.length > Math.ceil(rec.size / SECTOR) * SECTOR) throw new Error(f.name + " is bigger than the original");
            const aliases = [];
            if (f.aliases !== undefined) {
                if (!name.endsWith(".STR") || !Array.isArray(f.aliases) || f.aliases.length > 32) throw new Error("Invalid soundtrack aliases");
                for (const alias of f.aliases) {
                    if (typeof alias !== "string" || !/^[A-Z0-9]+\.STR$/.test(alias) || names.has(alias)) throw new Error("Invalid or duplicate soundtrack alias");
                    const target = dir.records.find(r => r.name === alias);
                    if (!target) throw new Error(alias + " is not on the disc");
                    names.add(alias); aliases.push(target);
                }
            }
            planned.push({ f, rec, aliases });
        }
        // Validate the whole bundle before changing any sectors. A bad last file must not
        // leave the first four installed and let players unknowingly race a mixed track.
        for (const { f, rec, aliases } of planned) {
            patch(rec.lba, f.data);
            setBoth(dir.data, rec.off + 10, f.data.length);
            // Share one native audio extent; do not allocate 18 copies of the PCM.
            for (const alias of aliases) {
                setBoth(dir.data, alias.off + 2, rec.lba);
                setBoth(dir.data, alias.off + 10, f.data.length);
            }
        }
        patch(dir.lba, dir.data);
        console.log("[mods] installed " + files.map((f) => f.name).join(", "));
    }

    window.DC_MODS = { install, rootDir, read };
})();
