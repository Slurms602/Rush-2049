// Online play: lockstep netplay. Every player runs their own copy of the game from their own
// disc image; only controller inputs travel between browsers (WebRTC, via PeerJS). A frame
// runs only once every player's input for it has arrived, so all copies stay identical. The
// host sends its save state when a match starts, and again if the copies ever drift apart.
//
// Needs the lockstep build of the core (fly_set_lockstep / fly_state_hash exports).
(function () {
    "use strict";
    const ROOM_PREFIX = "rush2049-";
    const MAX_PLAYERS = 4;
    const HASH_EVERY = 120;      // frames between desync checks
    const FIRST_HASH = 30;       // early check right after a state load
    const RESEND = 8;            // frames of history repeated in each input packet
    const KEEP = 900;            // frames of input history kept for resend requests
    const AUDIO_TARGET = 3072;   // queued audio frames the pacer aims for (~70 ms)
    const FRAME_MS = 1000 / 59.94;
    const STALL_HINT_MS = 300;
    const NEED_AFTER_MS = 400;

    const net = {
        role: null, peer: null, code: "",
        conns: new Map(),            // peer id -> { ctl, inp, slot, rtt }
        mySlot: 0, active: [0], dropAt: {},
        session: false, waiting: true, epoch: 0, delay: 3, frame: 0, nextLocal: 0,
        inputs: [], last: [], pad: new Array(24).fill(0),
        myHashes: new Map(), theirHashes: new Map(), desyncs: [],
        stallSince: 0, stallSlot: -1, needSentAt: 0, nextAt: 0, readyFrom: new Set(),
    };
    window.DC_NET = net;

    const gm = () => window.EJS_emulator && window.EJS_emulator.gameManager;
    const core = () => gm().Module;
    const now = () => performance.now();

    // ---------- inputs ----------
    // A frame's input for one player: [button mask, 8 analog values quantized to 0..255].
    function pack(pad) {
        let mask = 0;
        for (let i = 0; i < 16; i++) if (pad[i]) mask |= 1 << i;
        const out = [mask];
        for (let i = 16; i < 24; i++) out.push(Math.round(Math.min(0x7fff, Math.max(0, pad[i])) * 255 / 0x7fff));
        return out;
    }
    const NEUTRAL = pack(new Array(24).fill(0));

    function applyFrame(f) {
        const raw = gm().functions.simulateInput;
        for (let s = 0; s < MAX_PLAYERS; s++) {
            const p = isActive(s, f) ? net.inputs[s].get(f) : NEUTRAL;
            const last = net.last[s];
            for (let i = 0; i < 24; i++) {
                const v = i < 16 ? (p[0] >> i) & 1 : Math.round(p[i - 15] * 0x7fff / 255);
                if (v !== last[i]) { raw(s, i, v); last[i] = v; }
            }
        }
    }

    const isActive = (s, f) => net.active.includes(s) && !(net.dropAt[s] <= f);

    function store(s, f, list) {
        const m = net.inputs[s];
        if (!m) return;   // before the first match state arrived
        for (let k = 0; k < list.length; k++) {
            const fr = f - k;
            if (fr >= net.frame && !m.has(fr)) m.set(fr, list[k]);
        }
    }

    function recent(s, f) {
        const list = [], m = net.inputs[s];
        for (let k = 0; k < RESEND && m.has(f - k); k++) list.push(m.get(f - k));
        return list;
    }

    // The emulator's own keyboard/gamepad handling goes through gameManager.simulateInput.
    // Online, player 1's input is captured here and fed to the game on the agreed frame.
    function hookInput() {
        const g = gm();
        if (g.__netHooked) return;
        g.__netHooked = true;
        const orig = g.simulateInput.bind(g);
        g.simulateInput = (player, index, value) => {
            if (!net.session) return orig(player, index, value);
            if (player === 0 && index < 24) net.pad[index] = value;  // hotkeys (24+) stay off online
        };
    }

    // ---------- main loop ----------
    function pre() {
        if (!net.session) return true;
        if (net.waiting) return false;
        const f = net.frame;
        while (net.nextLocal <= f + net.delay) {
            net.inputs[net.mySlot].set(net.nextLocal, pack(net.pad));
            sendInput(net.mySlot, net.nextLocal);
            net.nextLocal++;
        }
        for (const s of net.active) {
            if (isActive(s, f) && !net.inputs[s].has(f)) { stalled(s, f); return false; }
        }
        if (!paced()) return false;
        if (net.stallSince) { net.stallSince = 0; ui.status(""); }
        applyFrame(f);
        return true;
    }

    function post() {
        net.fpsFrames = (net.fpsFrames || 0) + 1;
        if (!net.session) return;
        const done = ++net.frame;
        if ((done & 127) === 0) {
            for (const m of net.inputs) for (const k of m.keys()) if (k < done - KEEP) m.delete(k);
        }
        if (done === FIRST_HASH || done % HASH_EVERY === 0) checkHash(done);
    }

    // Run frames at the game's real speed: keep the audio queue near its target (this also
    // handles 30 fps games, which produce two frames' worth of audio per render). Without
    // running audio, fall back to the clock.
    function paced() {
        const a = core()._flyAud;
        const t = now();
        if (a && a.ready && a.stats && net.audioLive) return (a.stats.avail | 0) < AUDIO_TARGET;
        if (a && a.ready && a.stats) {
            // Audio counts as live once the queue has moved; a suspended context never drains.
            if (net.audioSeen !== undefined && a.stats.avail !== net.audioSeen) net.audioLive = true;
            net.audioSeen = a.stats.avail;
        }
        if (t < net.nextAt) return false;
        net.nextAt = Math.max(net.nextAt + FRAME_MS, t - 4 * FRAME_MS);
        return true;
    }

    function stalled(s, f) {
        const t = now();
        if (!net.stallSince || net.stallSlot !== s) { net.stallSince = t; net.stallSlot = s; net.needSentAt = 0; }
        const waited = t - net.stallSince;
        if (waited > STALL_HINT_MS) ui.status("Waiting for P" + (s + 1) + "…" + stallReason(s));
        if (net.role === "host" && waited > 5000 && t - (net.lastResync || 0) > 15000) {
            net.lastResync = t;
            console.warn("[net] P" + (s + 1) + " stalled for 5 s; re-syncing");
            startMatch("resync");
            return;
        }
        if (waited > NEED_AFTER_MS && t - net.needSentAt > NEED_AFTER_MS) {
            net.needSentAt = t;
            const to = net.role === "host" ? peerOfSlot(s) : hostConn();
            if (to) send(to.ctl, { t: "need", s, f });
        }
    }

    // What we know about why a player is behind (from their pings).
    function stallReason(s) {
        const c = peerOfSlot(s);
        const r = c && c.remote;
        if (!r) return "";
        if (r.hidden) return " (their game tab is in the background)";
        if (r.loading) return " (they're loading the game state)";
        if (r.fps !== undefined && r.fps < 40) return " (their game runs at " + r.fps + " fps)";
        return "";
    }

    // ---------- desync checks ----------
    function checkHash(f) {
        const h = core()._fly_state_hash();
        if (net.role === "guest") {
            const c = hostConn();
            if (c) send(c.ctl, { t: "hash", epoch: net.epoch, f, h });
            return;
        }
        net.myHashes.set(f, h);
        for (const [key, theirs] of net.theirHashes) {
            const [slot, fr] = key.split(":").map(Number);
            if (fr === f) { net.theirHashes.delete(key); compare(slot, f, theirs); }
        }
        for (const k of net.myHashes.keys()) if (k < f - 10 * HASH_EVERY) net.myHashes.delete(k);
    }

    function onGuestHash(slot, f, h) {
        if (net.myHashes.has(f)) compare(slot, f, h);
        else net.theirHashes.set(slot + ":" + f, h);
    }

    function compare(slot, f, h) {
        if (net.myHashes.get(f) === h) return;
        console.warn("[net] desync with P" + (slot + 1) + " at frame " + f);
        const t = now();
        net.desyncs = net.desyncs.filter((x) => t - x < 60000);
        net.desyncs.push(t);
        if (net.desyncs.length >= 3) {
            ui.status("P" + (slot + 1) + " keeps drifting out of sync. Everyone needs the same disc image and BIOS as the host.", 8000);
        }
        if (net.desyncs.length <= 5) startMatch("resync");
    }

    // ---------- match start / resync ----------
    async function startMatch(reason) {
        if (net.role !== "host" || net.starting) return;
        net.starting = true;
        try {
            const epoch = net.epoch + 1;
            net.waiting = true;   // no more frames until everyone has the new state
            const state = gm().getState();
            const data = await gzip(state);
            const active = [0, ...[...net.conns.values()].filter((c) => c.slot > 0 && c.ctl.open).map((c) => c.slot)].sort();
            const delay = net.delayOverride || chooseDelay();
            const names = {};
            for (const s of active) names[s] = "P" + (s + 1);
            for (const c of net.conns.values()) {
                if (!c.ctl.open || !active.includes(c.slot)) continue;
                send(c.ctl, { t: "start", epoch, delay, active, reason });
                send(c.ctl, { t: "state", epoch, data });
            }
            begin(state, epoch, delay, active);
            net.waiting = false;   // lockstep holds the host until guests have loaded
            ui.status(reason === "resync" ? "Re-synced" : "", 1500);
            ui.refresh();
        } finally {
            net.starting = false;
        }
    }

    function begin(state, epoch, delay, active) {
        net.session = true;
        net.epoch = epoch;
        net.delay = delay;
        net.active = active;
        net.dropAt = {};
        net.frame = 0;
        net.nextLocal = delay;
        net.inputs = [];
        net.last = [];
        for (let s = 0; s < MAX_PLAYERS; s++) {
            const m = new Map();
            for (let f = 0; f < delay; f++) m.set(f, NEUTRAL);
            net.inputs.push(m);
            net.last.push(new Array(24).fill(-1));
        }
        net.myHashes.clear();
        net.theirHashes.clear();
        net.nextAt = 0;
        net.stallSince = 0;
        const g = gm();
        core()._fly_set_lockstep(1);
        g.setVSync(false);           // loop runs freely; paced() decides when a frame runs
        g.loadState(state);          // lands a few frames later, on the same frame everywhere
    }

    function endSession(message) {
        if (!net.session) return;
        net.session = false;
        net.waiting = true;
        try {
            core()._fly_set_lockstep(0);
            gm().setVSync(true);
            const raw = gm().functions.simulateInput;
            for (let s = 0; s < MAX_PLAYERS; s++) for (let i = 0; i < 24; i++) raw(s, i, 0);
        } catch (e) { console.warn(e); }
        ui.status(message || "", 6000);
    }

    function chooseDelay() {
        const rtts = [...net.conns.values()].filter((c) => c.ctl.open).map((c) => c.rtt || 80).sort((a, b) => b - a);
        if (!rtts.length) return 2;
        // Guest-to-guest inputs go through the host, so the worst path is the two slowest links.
        const oneWay = rtts.length > 1 ? (rtts[0] + rtts[1]) / 2 : rtts[0] / 2;
        // At least 2 frames: with 1, any hiccup on either machine stalls the other at once.
        return Math.min(10, Math.max(2, Math.ceil((oneWay + 12) / FRAME_MS)));
    }

    // ---------- transport ----------
    function send(conn, msg) {
        try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn("[net] send failed", e); }
    }
    const hostConn = () => [...net.conns.values()][0];
    const peerOfSlot = (s) => [...net.conns.values()].find((c) => c.slot === s);

    function sendInput(s, f) {
        const msg = { t: "i", s, f, v: recent(s, f) };
        for (const c of net.conns.values()) if (c.slot !== s) send(c.inp, msg);
    }

    function onInput(from, msg) {
        if (!net.session || msg.s === net.mySlot) return;
        store(msg.s, msg.f, msg.v);
        if (net.role === "host") {
            for (const c of net.conns.values()) if (c !== from && c.slot !== msg.s) send(c.inp, msg);
        }
    }

    function onControl(c, msg) {
        switch (msg.t) {
            case "welcome":
                net.mySlot = msg.slot;
                ui.status("Joined as P" + (msg.slot + 1) + ". Starting…");
                ui.refresh();
                break;
            case "full":
                ui.status("That room is full (4 players).", 8000);
                leave();
                break;
            case "lobby":
                net.lobby = msg.players;
                ui.refresh();
                break;
            case "start":
                net.pending = msg;
                net.waiting = true;
                ui.status("Loading the host's game state…");
                clearTimeout(net.stateTimer);
                net.stateTimer = setTimeout(() => {
                    if (net.waiting && net.pending === msg) send(c.ctl, { t: "resend" });
                }, 20000);
                break;
            case "resend":
                if (net.role === "host") startMatch("resync");
                break;
            case "state":
                if (!net.pending || net.pending.epoch !== msg.epoch) break;
                clearTimeout(net.stateTimer);
                gunzip(msg.data).then((state) => {
                    const p = net.pending;
                    begin(state, p.epoch, p.delay, p.active);
                    net.waiting = false;
                    send(c.ctl, { t: "ready", epoch: p.epoch });
                    ui.status(p.reason === "resync" ? "Re-synced" : "", 1500);
                    ui.refresh();
                });
                break;
            case "hash":
                if (msg.epoch === net.epoch) onGuestHash(c.slot, msg.f, msg.h);
                break;
            case "need": {
                if (!net.session || !net.inputs[msg.s]) break;
                const list = [];
                for (let f = msg.f; f < msg.f + 30 && net.inputs[msg.s].has(f); f++) list.push(net.inputs[msg.s].get(f));
                if (list.length) send(c.ctl, { t: "inputs", s: msg.s, f: msg.f, list });
                break;
            }
            case "inputs":
                for (let k = 0; k < msg.list.length; k++) store(msg.s, msg.f + k, [msg.list[k]]);
                break;
            case "drop":
                if (msg.epoch !== net.epoch) break;
                for (let k = 0; k < msg.list.length; k++) store(msg.s, msg.from + k, [msg.list[k]]);
                net.dropAt[msg.s] = msg.at;
                break;
        }
    }

    function onPing(c, msg) {
        if (msg.t === "ping") {
            send(c.inp, { t: "pong", ts: msg.ts });
            c.remote = { frame: msg.f, fps: msg.fps, loading: msg.w, hidden: msg.h };
        } else if (msg.t === "pong") c.rtt = c.rtt ? c.rtt * 0.8 + (now() - msg.ts) * 0.2 : now() - msg.ts;
    }

    function wire(c) {
        c.ctl.on("data", (msg) => onControl(c, msg));
        c.inp.on("data", (msg) => (msg.t === "i" ? onInput(c, msg) : onPing(c, msg)));
        c.pinger = setInterval(() => send(c.inp, { t: "ping", ts: now(), f: net.frame, fps: net.fps,
            w: net.session && net.waiting ? 1 : 0, h: document.hidden ? 1 : 0 }), 1000);
    }

    // ---------- host ----------
    function host() {
        if (net.role) return;
        hookInput();
        net.role = "host";
        net.mySlot = 0;
        net.code = randomCode();
        net.peer = new Peer(ROOM_PREFIX + net.code, { debug: 1 });
        net.peer.on("open", () => { ui.refresh(); });
        net.peer.on("error", (e) => {
            if (e.type === "unavailable-id") { net.peer.destroy(); net.role = null; host(); return; }
            ui.status("Online error: " + (e.type || e.message), 8000);
        });
        net.peer.on("connection", (conn) => {
            let c = net.conns.get(conn.peer);
            if (!c) {
                const used = new Set([0, ...[...net.conns.values()].map((x) => x.slot)]);
                let slot = 1;
                while (used.has(slot)) slot++;
                c = { slot, rtt: 0 };
                net.conns.set(conn.peer, c);
            }
            c[conn.label] = conn;
            conn.on("open", () => {
                if (!c.ctl || !c.inp || !c.ctl.open || !c.inp.open) return;
                if (c.slot >= MAX_PLAYERS) { send(c.ctl, { t: "full" }); setTimeout(() => dropConn(conn.peer), 500); return; }
                wire(c);
                send(c.ctl, { t: "welcome", slot: c.slot });
                lobbyUpdate();
                // Start (or re-sync, to bring the newcomer in) shortly after someone joins,
                // so nobody has to press anything. Joins close together share one start.
                ui.status("P" + (c.slot + 1) + " joined. Starting the online match…", 4000);
                clearTimeout(net.autoStart);
                net.autoStart = setTimeout(() => startMatch(net.session ? "join" : "start"), 2500);
            });
            conn.on("close", () => dropConn(conn.peer));
            conn.on("error", () => dropConn(conn.peer));
        });
    }

    function dropConn(id) {
        const c = net.conns.get(id);
        if (!c) return;
        net.conns.delete(id);
        clearInterval(c.pinger);
        try { c.ctl && c.ctl.close(); c.inp && c.inp.close(); } catch (e) {}
        if (net.session && net.active.includes(c.slot) && net.dropAt[c.slot] === undefined) {
            // Everyone keeps that player's inputs up to the last frame the host has, then neutral.
            const m = net.inputs[c.slot];
            let at = net.frame;
            while (m.has(at)) at++;
            const from = Math.max(net.frame - 60, 0);
            const list = [];
            for (let f = from; f < at; f++) list.push(m.get(f) || NEUTRAL);
            net.dropAt[c.slot] = at;
            for (const o of net.conns.values()) send(o.ctl, { t: "drop", epoch: net.epoch, s: c.slot, at, from, list });
            ui.status("P" + (c.slot + 1) + " left", 4000);
        }
        lobbyUpdate();
    }

    function lobbyUpdate() {
        const players = [{ slot: 0 }, ...[...net.conns.values()].filter((c) => c.ctl && c.ctl.open).map((c) => ({ slot: c.slot }))];
        net.lobby = players;
        for (const c of net.conns.values()) send(c.ctl, { t: "lobby", players });
        ui.refresh();
    }

    // ---------- guest ----------
    function join(code) {
        if (net.role) return;
        hookInput();
        net.role = "guest";
        net.code = code.toUpperCase();
        ui.status("Connecting to room " + net.code + "…");
        net.peer = new Peer({ debug: 1 });
        net.peer.on("error", (e) => {
            ui.status(e.type === "peer-unavailable" ? "Room " + net.code + " not found. Is the host's game running?" : "Online error: " + (e.type || e.message), 10000);
        });
        net.peer.on("open", () => {
            const id = ROOM_PREFIX + net.code;
            const c = { slot: 0, rtt: 0 };
            c.ctl = net.peer.connect(id, { label: "ctl", reliable: true });
            c.inp = net.peer.connect(id, { label: "inp", reliable: false, serialization: "json" });
            net.conns.set(id, c);
            let opened = 0;
            const onOpen = () => { if (++opened === 2) wire(c); };
            c.ctl.on("open", onOpen);
            c.inp.on("open", onOpen);
            const lost = () => { if (net.role === "guest") { endSession("Lost the connection to the host. You can keep playing on your own."); leave(); } };
            c.ctl.on("close", lost);
            c.ctl.on("error", lost);
        });
    }

    function leave() {
        for (const id of [...net.conns.keys()]) {
            const c = net.conns.get(id);
            clearInterval(c.pinger);
            try { c.ctl && c.ctl.close(); c.inp && c.inp.close(); } catch (e) {}
        }
        net.conns.clear();
        endSession();
        if (net.peer) net.peer.destroy();
        net.peer = null;
        net.role = null;
        ui.refresh();
    }

    // ---------- helpers ----------
    function randomCode() {
        const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let s = "";
        for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
        return s;
    }

    async function gzip(u8) {
        const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    }

    async function gunzip(buf) {
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    // ---------- UI ----------
    const ui = {
        status(text, ms) {
            const el = document.getElementById("net-status");
            if (!el) return;
            el.textContent = text;
            el.hidden = !text;
            clearTimeout(ui.timer);
            if (text && ms) ui.timer = setTimeout(() => { el.hidden = true; }, ms);
        },
        refresh() {
            const panel = document.getElementById("net-panel");
            if (!panel) return;
            const link = location.origin + location.pathname + "?join=" + net.code;
            const rows = (net.lobby || [{ slot: net.mySlot }]).map((p) => {
                const c = peerOfSlot(p.slot);
                const r = c && c.remote;
                const info = [];
                if (net.role === "host" && c && c.rtt) info.push(Math.round(c.rtt) + " ms");
                if (r && r.fps !== undefined) info.push(r.fps + " fps");
                if (r && r.hidden) info.push("tab in background");
                if (r && r.loading) info.push("loading");
                return "<li>P" + (p.slot + 1) + (p.slot === net.mySlot ? " (you)" : "") + (info.length ? " · " + info.join(" · ") : "") + "</li>";
            }).join("");
            let html;
            if (!net.role) {
                html = '<button id="net-host">Host an online game</button>' +
                    '<p class="net-note">You get a link to send. Friends who open it and load the game join your match automatically. Everyone needs the same disc image and the BIOS files.</p>';
            } else if (net.role === "host") {
                html = (net.peer && net.peer.open
                    ? '<p>Room <b>' + net.code + '</b>. Send your friends this link:</p><p class="net-link"><input readonly value="' + link + '"><button id="net-copy">Copy</button></p>'
                    : "<p>Opening a room…</p>") +
                    "<ul>" + rows + "</ul>" +
                    '<p class="net-row">Input delay: <button id="net-dminus">−</button> <b>' + (net.delayOverride || "auto (" + chooseDelay() + ")") + '</b> <button id="net-dplus">+</button></p>' +
                    '<p class="net-note">Friends join automatically when they open the link and their game starts.</p>' +
                    (net.session ? '<button id="net-start">Re-sync everyone</button>' : "") +
                    '<button id="net-leave" class="secondary">Close room</button>';
            } else {
                html = "<p>Room <b>" + net.code + "</b></p><ul>" + rows + "</ul>" +
                    '<button id="net-leave" class="secondary">Leave</button>';
            }
            document.getElementById("net-body").innerHTML = html;
            const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
            on("net-host", host);
            on("net-copy", () => navigator.clipboard && navigator.clipboard.writeText(link));
            on("net-start", () => startMatch("start"));
            on("net-leave", leave);
            on("net-dminus", () => { net.delayOverride = Math.max(2, (net.delayOverride || chooseDelay()) - 1); ui.refresh(); });
            on("net-dplus", () => { net.delayOverride = Math.min(10, (net.delayOverride || chooseDelay()) + 1); ui.refresh(); });
        },
    };

    // Called by index.html once the game is running.
    net.init = function () {
        window.DC_LOOP.pre = pre;
        window.DC_LOOP.post = post;
        const join_ = new URLSearchParams(location.search).get("join");
        if (join_) join(join_);
        ui.refresh();
        setInterval(() => {
            const panel = document.getElementById("net-panel");
            if (net.role && panel && !panel.hidden && !panel.contains(document.activeElement)) ui.refresh();
        }, 2000);
        // Show script errors instead of failing silently, so friends can report them.
        window.addEventListener("error", (e) => ui.status("Error: " + e.message, 15000));
        // Which GPU the browser draws with. A software renderer can't keep up with the game.
        let renderer = "";
        try {
            const gl = window.EJS_emulator.canvas.getContext("webgl2");
            const ext = gl.getExtension("WEBGL_debug_renderer_info");
            renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        } catch (e) {}
        if (/Basic Render Driver|SwiftShader|llvmpipe|softpipe|Software/i.test(renderer)) {
            const w = document.getElementById("gpu-warning");
            if (w) w.hidden = false;
            // Drawing in software: a quarter of the pixels keeps the game playable.
            window.EJS_emulator.gameManager.setVariable("reicast_internal_resolution", "320x240");
        }
        // ?hud=1: also show the emulator's own timing HUD (drawn by the core) and the GPU in use.
        let gpu = "";
        if (/[?&]hud=1/.test(location.search)) {
            document.getElementById("fps").classList.add("below-hud");
            gpu = "\n" + (renderer || "(GPU unknown)") + "\n" + navigator.userAgent;
        }
        // Frames the game drew in the last second, and game speed (emulated time per real
        // second; below 100% the game runs in slow motion and the audio stutters).
        const m = core();
        const frames = () => (m._fly_render_count ? m._fly_render_count() : net.fpsFrames);
        const guest = () => (m._fly_guest_seconds ? m._fly_guest_seconds() : 0);
        let lastF = frames(), lastG = guest(), lastT = now();
        setInterval(() => {
            const f = frames(), g = guest(), t = now(), el = document.getElementById("fps");
            const fps = Math.round((f - lastF) * 1000 / (t - lastT));   // 0 during videos (not 3D frames)
            const speed = m._fly_guest_seconds ? Math.round((g - lastG) * 100000 / (t - lastT)) + "% speed" : "";
            if (el) el.textContent = [fps ? fps + " fps" : "", speed].filter(Boolean).join(" · ") + gpu;
            net.fps = fps;
            lastF = f; lastG = g; lastT = t;
        }, 1000);
    };
    net.host = host;
    net.join = join;
    net.leave = leave;
    net.startMatch = startMatch;
})();
