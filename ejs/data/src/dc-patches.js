// Dreamcast glue: feeds the files picked on index.html (window.DC_FILES) straight
// into the emulator's filesystem instead of downloading them from URLs.
(function() {
    const SYSTEM_DIR = "/system";
    const MAIN_PRIORITY = ["m3u", "gdi", "cue", "cdi", "chd", "iso", "elf"];

    const ext = (name) => name.split(".").pop().toLowerCase();
    const base = (name) => name.split("/").pop();

    // RetroArch probes a GL parameter WebGL doesn't support during video init. The INVALID_ENUM
    // it leaves behind is later picked up by RetroArch's error check, which then kills the
    // video driver ("GL: Invalid enum"). Absorb only that error, and only for getParameter.
    // Each pname is checked once; unsupported ones return null without touching GL again.
    const gl = WebGL2RenderingContext.prototype;
    const origGetParameter = gl.getParameter, origGetError = gl.getError;
    const okParams = new Set(), badParams = new Set();
    gl.getParameter = function(pname) {
        if (okParams.has(pname)) return origGetParameter.call(this, pname);
        if (badParams.has(pname)) return null;
        const pending = origGetError.call(this);
        if (pending) (this.__dcErrors = this.__dcErrors || []).push(pending);
        const value = origGetParameter.call(this, pname);
        const err = origGetError.call(this);
        if (err === this.INVALID_ENUM) {
            badParams.add(pname);
            console.log("[dc] ignored unsupported getParameter 0x" + pname.toString(16));
        } else {
            okParams.add(pname);
            if (err) (this.__dcErrors = this.__dcErrors || []).push(err);
        }
        return value;
    };
    gl.getError = function() {
        if (this.__dcErrors && this.__dcErrors.length) return this.__dcErrors.shift();
        return origGetError.call(this);
    };

    // This Flycast build crashes or hangs loading GD-ROM .cue sheets (Redump format), but
    // reads .gdi fine. Rewrite the cue as a gdi: the single-density area starts at LBA 0,
    // the high-density area at LBA 45000, and each track's LBA is where its file begins on
    // the disc, so absolute sector reads land on the right data. Tracks are renamed to
    // trackNN.bin because the gdi parser doesn't cope with spaces in names.
    function cueToGdi(FS, cueName) {
        const cue = new TextDecoder().decode(FS.readFile("/" + cueName));
        if (!/HIGH-DENSITY/i.test(cue)) return null;  // plain CD image, leave it alone
        const tracks = [];
        let area = 0, sectors = { 0: 0, 45000: 0 }, file = null;
        for (const line of cue.split(/\r?\n/)) {
            if (/HIGH-DENSITY/i.test(line)) area = 45000;
            const f = line.match(/^\s*FILE\s+"([^"]+)"/i);
            if (f) file = f[1];
            const t = line.match(/^\s*TRACK\s+(\d+)\s+(\S+)/i);
            if (t && file) {
                const size = FS.stat("/" + file).size;
                const sectorSize = /2048/.test(t[2]) ? 2048 : 2352;
                const num = parseInt(t[1], 10);
                const name = "track" + String(num).padStart(2, "0") + ".bin";
                tracks.push(`${num} ${area + sectors[area]} ${/AUDIO/i.test(t[2]) ? 0 : 4} ${sectorSize} ${name} 0`);
                FS.rename("/" + file, "/" + name);
                sectors[area] += Math.ceil(size / sectorSize);
                file = null;
            }
        }
        if (!tracks.length) return null;
        const gdiName = cueName.replace(/\.cue$/i, "") + ".gdi";
        FS.writeFile("/" + gdiName, tracks.length + "\n" + tracks.join("\n") + "\n");
        return gdiName;
    }

    const origCfg = EJS_GameManager.prototype.getRetroArchCfg;
    EJS_GameManager.prototype.getRetroArchCfg = function() {
        return origCfg.call(this) + `system_directory = "${SYSTEM_DIR}"\n`;
    };

    // Upstream only applies defaultOptions once settings exist in localStorage, so on a
    // first run the core would boot with stock options. Always merge them in, and use
    // Flycast's built-in HLE BIOS unless a real dc_boot.bin was supplied.
    const origCoreSettings = EmulatorJS.prototype.getCoreSettings;
    EmulatorJS.prototype.getCoreSettings = function() {
        const set = {};
        for (const line of origCoreSettings.call(this).split("\n")) {
            const i = line.indexOf(" = ");
            if (i > 0) set[line.slice(0, i)] = line.slice(i + 3);
        }
        const defaults = this.config.defaultOptions || {};
        for (const k in defaults) {
            if (!(k in set)) set[k] = `"${defaults[k]}"`;
        }
        const hasBoot = window.DC_FILES.bios.some(f => f.name.toLowerCase() === "dc_boot.bin");
        set.reicast_hle_bios = hasBoot ? '"disabled"' : '"enabled"';
        return Object.entries(set).map(([k, v]) => `${k} = ${v}`).join("\n") + "\n";
    };

    EmulatorJS.prototype.downloadRom = async function() {
        const FS = this.gameManager.FS;
        const written = [];
        // Upstream only shows the on-screen pad after a tap on its own start button, which
        // auto-start skips. index.html sets DC_MOBILE when it detects a touch device.
        if (window.DC_MOBILE) this.touch = true;
        for (const file of window.DC_FILES.rom) {
            this.textElem.innerText = "Reading " + file.name + "...";
            // Real File objects ignore the argument; auto-run entries use it to report progress.
            const data = new Uint8Array(await file.arrayBuffer((pct) => {
                this.textElem.innerText = "Loading " + file.name + " " + pct + "%";
            }));
            const out = (ext(file.name) === "zip" || ext(file.name) === "7z" || ext(file.name) === "rar")
                ? await this.checkCompression(data, "Decompressing " + file.name + " ")
                : { [file.name]: data };
            for (const k in out) {
                if (k.endsWith("/")) continue;
                const name = k === "!!notCompressedData" ? file.name : base(k);
                FS.writeFile("/" + name, out[k], { canOwn: true });  // no second copy of 1GB+ tracks
                written.push(name);
            }
        }
        let main = null;
        for (const e of MAIN_PRIORITY) {
            main = written.find(n => ext(n) === e);
            if (main) break;
        }
        if (!main) {
            this.startGameError("No Dreamcast image found (.gdi, .cdi, .chd, .cue)");
            throw new Error("No playable file in: " + written.join(", "));
        }
        if (ext(main) === "cue") {
            const gdi = cueToGdi(FS, main);
            if (gdi) {
                console.log("[dc] converted", main, "to", gdi);
                this.config.gameUrl = main;  // keep the original name for save files
                main = gdi;
            }
        }
        this.fileName = main;
        if (ext(this.config.gameUrl) !== "cue") this.config.gameUrl = main;
        console.log("[dc] booting", main, "from", written);
    };

    // Netplay hooks. Emscripten skips a main-loop iteration (one retro_run) when a
    // preMainLoop callback returns false, but the core only registers callbacks passed in
    // its initial config. Register forwarders there; window.DC_LOOP.pre/post can then be
    // swapped at any time.
    window.DC_LOOP = window.DC_LOOP || {};
    const origInitModule = EmulatorJS.prototype.initModule;
    EmulatorJS.prototype.initModule = function(...args) {
        const runtime = window.EJS_Runtime;
        window.EJS_Runtime = (cfg) => runtime(Object.assign(cfg, {
            preMainLoop: () => (window.DC_LOOP.pre ? window.DC_LOOP.pre() : true),
            postMainLoop: () => { if (window.DC_LOOP.post) window.DC_LOOP.post(); }
        }));
        return origInitModule.apply(this, args);
    };

    EmulatorJS.prototype.downloadBios = async function() {
        const dir = SYSTEM_DIR + "/dc";
        this.gameManager.mkdir(SYSTEM_DIR);
        this.gameManager.mkdir(dir);
        for (const file of window.DC_FILES.bios) {
            const data = new Uint8Array(await file.arrayBuffer());
            this.gameManager.FS.writeFile(dir + "/" + file.name.toLowerCase(), data);
            console.log("[dc] wrote BIOS", dir + "/" + file.name.toLowerCase());
        }
    };
})();
