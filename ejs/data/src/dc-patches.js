// Dreamcast glue: feeds the files picked on index.html (window.DC_FILES) straight
// into the emulator's filesystem instead of downloading them from URLs.
(function() {
    const SYSTEM_DIR = "/system";
    const MAIN_PRIORITY = ["m3u", "gdi", "cue", "cdi", "chd", "iso", "elf"];

    const ext = (name) => name.split(".").pop().toLowerCase();
    const base = (name) => name.split("/").pop();

    const gl = WebGL2RenderingContext.prototype;
    // Flycast toggles the GLES fixed-index primitive restart state around its
    // triangle strips. WebGL 2 always enables it and rejects these toggles with
    // INVALID_ENUM. That error can survive until RetroArch next initializes its
    // framebuffer (including the resolution change when a friend joins), where
    // it shuts down the video driver and longjmps out as an "Infinity" exception.
    // The toggles already have no effect in WebGL; avoid generating their error.
    const FIXED_INDEX_RESTART = 0x8d69;
    for (const method of ["enable", "disable"]) {
        const original = gl[method];
        gl[method] = function(cap) {
            if (cap === FIXED_INDEX_RESTART) return;
            return original.call(this, cap);
        };
    }
    // RetroArch also probes unsupported GL parameters during video init. Absorb
    // only a probe's own INVALID_ENUM; preserve unrelated errors for its caller.
    // Each pname is checked once; unsupported ones subsequently return null.
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

    // The core plays sound through its own AudioWorklet, which it loads from a blob. Swap in
    // this copy: the same queue and messages, plus optional dynamic rate control. Online, the
    // game runs on the system clock (so every player's copy keeps the same pace), and the
    // sound card's clock differs slightly from it; with a target set ({target: samples}), the
    // worklet plays up to 0.5% faster or slower (inaudible) to keep its queue near the target.
    // Without a target it plays exactly like the original.
    const FLY_AUDIO = `
class FlyAudio extends AudioWorkletProcessor {
    constructor() {
        super();
        this.cap = 32768;
        this.rbL = new Float32Array(this.cap);
        this.rbR = new Float32Array(this.cap);
        this.r = 0; this.w = 0; this.avail = 0; this.frac = 0;
        this.under = 0; this.drop = 0; this.tick = 0;
        this.primed = false;
        this.target = 0; this.level = 0;
        this.port.onmessage = (e) => {
            const d = e.data;
            if (!(d instanceof Int16Array)) {
                if (d && typeof d.target === "number") { this.target = d.target; this.level = this.avail; }
                return;
            }
            const n = d.length >> 1;
            if (this.avail + n > this.cap) { this.drop += n; return; }
            for (let i = 0; i < n; i++) {
                this.rbL[this.w] = d[2 * i] / 32768;
                this.rbR[this.w] = d[2 * i + 1] / 32768;
                this.w = (this.w + 1) % this.cap;
            }
            this.avail += n;
        };
    }
    process(inputs, outputs) {
        const out = outputs[0], L = out[0], R = out[1] || out[0];
        if (!this.primed) {
            if (this.avail >= 2048) this.primed = true;
            else { for (let j = 0; j < L.length; j++) { L[j] = 0; R[j] = 0; } return true; }
        }
        let step = 1;
        if (this.target) {
            this.level += (this.avail - this.level) * 0.01;
            step += Math.max(-0.005, Math.min(0.005, (this.level - this.target) / this.target * 0.01));
        }
        for (let i = 0; i < L.length; i++) {
            if (this.avail > 1) {
                const a = this.r, b = (a + 1) % this.cap, f = this.frac;
                L[i] = this.rbL[a] + (this.rbL[b] - this.rbL[a]) * f;
                R[i] = this.rbR[a] + (this.rbR[b] - this.rbR[a]) * f;
                this.frac += step;
                const adv = Math.floor(this.frac);
                this.frac -= adv;
                this.r = (this.r + adv) % this.cap;
                this.avail -= adv;
            } else { L[i] = 0; R[i] = 0; this.under++; this.primed = false; }
        }
        if (++this.tick >= 16) {
            this.tick = 0;
            this.port.postMessage({ avail: this.avail, under: this.under, drop: this.drop });
        }
        return true;
    }
}
registerProcessor("fly-audio", FlyAudio);
`;
    if (window.AudioWorklet) {
        const origAddModule = AudioWorklet.prototype.addModule;
        AudioWorklet.prototype.addModule = async function(url, options) {
            if (typeof url === "string" && url.startsWith("blob:")) {
                try {
                    if ((await (await fetch(url)).text()).includes("class FlyAudio")) {
                        url = URL.createObjectURL(new Blob([FLY_AUDIO], { type: "application/javascript" }));
                        window.DC_AUDIO_RATE = true;
                    }
                } catch (e) { console.warn("[dc] audio worklet swap failed", e); }
            }
            return origAddModule.call(this, url, options);
        };
    }

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
