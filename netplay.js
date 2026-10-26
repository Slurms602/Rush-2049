// Online play: lockstep netplay. Every player runs their own copy of the game from their own
// disc image; only controller inputs travel between browsers (WebRTC, via PeerJS). A frame
// runs only once every player's input for it has arrived, so all copies stay identical. The
// host sends its save state when a match starts, and again if the copies ever drift apart.
//
// Needs the lockstep build of the core (fly_set_lockstep / fly_state_hash exports).
(function () {
    "use strict";
    const ROOM_PREFIX = "rush2049-";
    const VERSION = 2;           // players must run the same netplay code; bump on protocol changes
    const MAX_PLAYERS = 4;
    const HASH_EVERY = 120;      // frames between desync checks
    const FIRST_HASH = 30;       // early check right after a state load
    const RESEND = 8;            // frames of history repeated in each input packet
    const KEEP = 900;            // frames of input history kept for resend requests
    const AUDIO_TARGET = 3072;   // audio queue (samples, ~70 ms) the sound plays from, online
    const FRAME_MS = 1000 / 59.94;
    const STALL_HINT_MS = 300;
    const NEED_AFTER_MS = 400;

    const net = {
        role: null, peer: null, code: "",
        conns: new Map(),            // peer id -> { ctl, inp, slot, rtt }
        mesh: new Map(),             // guests only: slot -> direct link { inp, slot, id, rtt } to another guest
        early: [],                   // input packets for a match this player hasn't loaded yet
        mySlot: 0, active: [0], dropAt: {},
        session: false, waiting: true, epoch: 0, delay: 3, frame: 0, nextLocal: 0,
        inputs: [], last: [], pad: new Array(24).fill(0),
        myHashes: new Map(), theirHashes: new Map(), desyncs: [],
        stallSince: 0, stallSlot: -1, needSentAt: 0, nextAt: 0, readyFrom: new Set(),
        loop: null, workMs: 0, workStart: 0, resProbe: {}, lowerFor: 0,
        margins: [], margin: undefined, avgMargin: undefined, lag: 0, arrived: new Map(), readyFrame: -1, readyAt: 0,
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
        const t = now();
        for (let k = 0; k < list.length; k++) {
            const fr = f - k;
            if (fr >= net.frame && !m.has(fr)) {
                m.set(fr, list[k]);
                if (s !== net.mySlot) net.arrived.set(fr, Math.max(net.arrived.get(fr) || 0, t));
            }
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
        if (!due()) return false;
        if (net.readyFrame !== f) { net.readyFrame = f; net.readyAt = now(); }
        for (const s of net.active) {
            if (isActive(s, f) && !net.inputs[s].has(f)) { stalled(s, f); return false; }
        }
        if (net.stallSince) { net.stallSince = 0; ui.status(""); }
        // How long before the frame was due its last remote input arrived (negative: we waited).
        const arrived = net.arrived.get(f);
        if (arrived !== undefined) { net.margins.push(net.readyAt - arrived); net.arrived.delete(f); }
        net.nextAt += FRAME_MS;
        applyFrame(f);
        net.workStart = now();
        return true;
    }

    function post() {
        net.fpsFrames = (net.fpsFrames || 0) + 1;
        if (!net.session) return;
        if (net.workStart) {
            // How long this PC takes to emulate and draw a frame (the budget is 16.7 ms).
            const w = now() - net.workStart;
            net.workMs = net.workMs ? net.workMs * 0.95 + w * 0.05 : w;
            net.workStart = 0;
        }
        if (window.DC_VIEW) window.DC_VIEW.tick();
        if ((net.frame & 63) === 0) audioRate(AUDIO_TARGET);
        const done = ++net.frame;
        if ((done & 127) === 0) {
            for (const m of net.inputs) for (const k of m.keys()) if (k < done - KEEP) m.delete(k);
            for (const k of net.arrived.keys()) if (k < done) net.arrived.delete(k);
        }
        if (done === FIRST_HASH || done % HASH_EVERY === 0) checkHash(done);
        if (done % 300 === 0) checkResolution(done);
    }

    // Online the game draws at 2x so each player's enlarged view stays sharp (myview.js). If a
    // frame takes too long on this PC, try normal resolution once, and keep it only if that
    // helps (when the CPU is the limit, it doesn't). Drawing only: it can't affect sync.
    const HI_RES = "1280x960", LO_RES = "640x480";
    function checkResolution(f) {
        const p = net.resProbe;
        if (net.software || p.done || f < 600) return;
        if (!p.before) {
            if (net.workMs < 14) return;
            p.before = net.workMs;
            p.at = f + 300;
            gm().setVariable("reicast_internal_resolution", LO_RES);
        } else if (f >= p.at) {
            p.done = true;
            p.keepLow = p.before - net.workMs >= 1.5;
            if (p.keepLow) ui.status("Drawing at normal resolution so your PC keeps up.", 6000);
            else gm().setVariable("reicast_internal_resolution", HI_RES);
        }
    }

    // Frames run on the game's clock, one per display refresh: the main loop runs on
    // requestAnimationFrame and a refresh runs a frame only when one is due. A 60 Hz screen then
    // shows every frame exactly once, and the main thread is idle between frames, so inputs
    // from the network are handled as soon as they arrive. After a stall, or in a background
    // tab (no refreshes), frames run back to back until the game has caught up.
    function due() {
        const t = now();
        let late = t - net.nextAt;
        if (late > 6 * FRAME_MS) { net.nextAt = t; late = 0; }   // far behind: skip the backlog
        setLoop(document.hidden || late > 1.5 * FRAME_MS ? "fast" : "vsync");
        return late >= (net.loop === "vsync" ? -FRAME_MS / 2 : 0);
    }

    function setLoop(mode) {
        if (net.loop === mode) return;
        net.loop = mode;
        gm().setVSync(mode === "vsync");
    }

    // Online the game runs on the system clock, which drifts a little from the sound card's.
    // The audio worklet (dc-patches.js) then plays up to 0.5% faster or slower to keep its
    // queue at this many samples; 0 turns that off.
    function audioRate(target) {
        const a = core()._flyAud;
        if (a && a.node && a.drcTarget !== target) {
            a.node.port.postMessage({ target });
            a.drcTarget = target;
        }
    }

    // ---------- time sync ----------
    // How early the others' inputs arrive (the margin) depends on how the players' clocks line
    // up. A player running a little ahead of the others gets their inputs just in time, so any
    // network jitter stalls it, while its own inputs reach them early. Each player measures its
    // margin, the host shares the average, and a player below the average runs a few ms later
    // (one above it a few ms earlier) until everyone has the same margin.
    function syncTick() {
        const ms = net.margins;
        net.margins = [];
        if (!net.session || net.waiting || ms.length < 30) return;
        ms.sort((a, b) => a - b);
        net.margin = ms[Math.floor(ms.length * 0.1)];
        if (net.role === "host") {
            const all = [net.margin];
            for (const c of net.conns.values()) {
                if (c.remote && c.remote.m !== undefined && net.active.includes(c.slot)) all.push(c.remote.m);
            }
            net.avgMargin = all.reduce((a, b) => a + b, 0) / all.length;
        }
        if (net.role === "host") tuneDelay();
        if (net.avgMargin === undefined) return;
        const diff = net.avgMargin - net.margin;   // > 0: we run early compared with the others
        if (Math.abs(diff) < 3) return;
        const shift = Math.max(-5, Math.min(5, diff / 2));
        net.nextAt += shift;
        net.lag += shift;
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
            if (to) send(to.ctl, { t: "need", e: net.epoch, s, f });
        }
    }

    // What we know about why a player is behind (from their pings).
    function stallReason(s) {
        const c = peerOfSlot(s) || net.mesh.get(s);
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
            const delay = net.delayOverride || (net.session ? net.delay : chooseDelay());
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
        net.margins = [];
        net.arrived.clear();
        net.readyFrame = -1;
        net.nextAt = 0;
        net.stallSince = 0;
        const early = net.early;
        net.early = [];
        for (const msg of early) if (msg.e === epoch) store(msg.s, msg.f, msg.v);
        const g = gm();
        core()._fly_set_lockstep(1);
        net.loop = null;
        setLoop("vsync");            // due() decides when a frame runs
        // Each player sees an enlarged part of the split screen (myview.js); render at 2x so
        // it stays sharp. Rendering only, so it can't affect sync.
        if (!net.resProbe.done) net.resProbe = {};
        if (!net.software) g.setVariable("reicast_internal_resolution", net.resProbe.keepLow ? LO_RES : HI_RES);
        g.loadState(state);          // lands a few frames later, on the same frame everywhere
    }

    function endSession(message) {
        if (!net.session) return;
        net.session = false;
        net.waiting = true;
        try {
            core()._fly_set_lockstep(0);
            gm().setVSync(true);
            net.loop = null;
            audioRate(0);
            if (!net.software) gm().setVariable("reicast_internal_resolution", LO_RES);
            if (window.DC_VIEW) window.DC_VIEW.reset();
            const raw = gm().functions.simulateInput;
            for (let s = 0; s < MAX_PLAYERS; s++) for (let i = 0; i < 24; i++) raw(s, i, 0);
        } catch (e) { console.warn(e); }
        ui.status(message || "", 6000);
    }

    // Input delay: frames between pressing a button and the frame it applies to. It has to
    // cover the slowest path an input takes between two players: host to guest is half that
    // link's ping; guest to guest is direct when the two are linked, else through the host.
    // Pings are medians of recent samples, plus their spread (jitter) as headroom.
    function chooseDelay() {
        const guests = [...net.conns.values()].filter((c) => c.ctl.open && c.slot > 0);
        if (!guests.length) return 2;
        if (guests.some((c) => !c.rtts || c.rtts.length < 3)) return 4;   // no reliable pings yet
        const slow = (c) => c.rtt + c.jitter;
        let worst = 0;
        for (const a of guests) {
            worst = Math.max(worst, slow(a) / 2);
            for (const b of guests) {
                if (b.slot <= a.slot) continue;
                const relay = (slow(a) + slow(b)) / 2;
                const direct = a.remote && a.remote.pr && a.remote.pr[b.slot];
                worst = Math.max(worst, direct ? Math.min(relay, direct / 2) : relay);
            }
        }
        // At least 2 frames: with 1, any hiccup on either machine stalls the others at once.
        return Math.min(10, Math.max(2, Math.ceil((worst + 8) / FRAME_MS)));
    }

    // The delay only decides how early each player's input is sampled; every frame still gets
    // exactly one input from each player. So it can change at any time without a re-sync: the
    // host keeps it matched to the pings (raising it at once, lowering it after 10 s).
    function tuneDelay() {
        const want = net.delayOverride || chooseDelay();
        if (want < net.delay && !net.delayOverride && ++net.lowerFor < 10) return;
        net.lowerFor = 0;
        if (want !== net.delay) setDelay(want);
    }

    function setDelay(d) {
        net.delay = d;
        for (const c of net.conns.values()) send(c.ctl, { t: "delay", e: net.epoch, d });
        ui.refresh();
    }

    // ---------- transport ----------
    function send(conn, msg) {
        try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn("[net] send failed", e); }
    }
    const hostConn = () => [...net.conns.values()][0];
    const peerOfSlot = (s) => [...net.conns.values()].find((c) => c.slot === s);

    function sendInput(s, f) {
        const msg = { t: "i", e: net.epoch, s, f, v: recent(s, f) };
        for (const c of net.conns.values()) if (c.slot !== s) send(c.inp, msg);
        for (const m of net.mesh.values()) send(m.inp, msg);
    }

    // Inputs carry the match (epoch) they belong to: frame numbers restart at every re-sync,
    // so a packet still in flight from the previous match must not land in this one.
    function onInput(from, msg) {
        if (msg.s === net.mySlot) return;
        if (msg.e > net.epoch) { if (net.early.length < 2000) net.early.push(msg); return; }
        if (!net.session || msg.e !== net.epoch) return;
        store(msg.s, msg.f, msg.v);
        if (net.role === "host") {
            for (const c of net.conns.values()) if (c !== from && c.slot !== msg.s) send(c.inp, msg);
        }
    }

    function onControl(c, msg) {
        switch (msg.t) {
            case "welcome":
                if (msg.v !== VERSION) {
                    ui.status("The host has an older copy of this page open. They need to reload it (Ctrl+F5).", 15000);
                    leave();
                    break;
                }
                net.mySlot = msg.slot;
                ui.status("Joined as P" + (msg.slot + 1) + ". Starting…");
                ui.refresh();
                break;
            case "version":
                ui.status("This page is out of date. Reload it (Ctrl+F5), then open the link again.", 15000);
                leave();
                break;
            case "full":
                ui.status("That room is full (4 players).", 8000);
                leave();
                break;
            case "lobby":
                net.lobby = msg.players;
                meshUpdate();
                ui.refresh();
                break;
            case "delay":
                if (msg.e === net.epoch) { net.delay = msg.d; ui.refresh(); }
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
                if (!net.session || msg.e !== net.epoch || !net.inputs[msg.s]) break;
                const list = [];
                for (let f = msg.f; f < msg.f + 30 && net.inputs[msg.s].has(f); f++) list.push(net.inputs[msg.s].get(f));
                if (list.length) send(c.ctl, { t: "inputs", e: net.epoch, s: msg.s, f: msg.f, list });
                break;
            }
            case "inputs":
                if (msg.e !== net.epoch) break;
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
            c.remote = { frame: msg.f, fps: msg.fps, ms: msg.ms, loading: msg.w, hidden: msg.h, m: msg.m, pr: msg.pr };
            if (msg.a !== undefined && net.role === "guest") net.avgMargin = msg.a;
            if (msg.d !== undefined && net.role === "guest" && net.session && !net.waiting) net.delay = msg.d;
        } else if (msg.t === "pong") {
            // Median of the last 20 pings (a busy moment on either side doesn't skew it), and
            // how far the slower ones stray above it.
            c.rtts = (c.rtts || []).concat(now() - msg.ts).slice(-20);
            const sorted = c.rtts.slice().sort((a, b) => a - b);
            c.rtt = sorted[sorted.length >> 1];
            c.jitter = sorted[Math.floor(sorted.length * 0.9)] - c.rtt;
        }
    }

    // Is the link direct, or detouring through the relay (TURN) server? Relays add latency.
    async function updateRoute(c) {
        const pc = c.inp && c.inp.peerConnection;
        if (!pc) return;
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
        if (!pair) stats.forEach((r) => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r; });
        if (!pair) return;
        const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
        c.route = [local, remote].some((x) => x && x.candidateType === "relay") ? "relayed" : "direct";
    }

    function wire(c) {
        c.ctl.on("data", (msg) => onControl(c, msg));
        c.inp.on("data", (msg) => (msg.t === "i" ? onInput(c, msg) : onPing(c, msg)));
        startPings(c);
    }

    // Twice a second: ping (for the delay and the panel) and share this player's state. Guests
    // also tell the host their pings to the other guests (pr), for the delay.
    function startPings(c) {
        let n = 0;
        c.pinger = setInterval(() => {
            const pr = {};
            if (net.role === "guest" && c.slot === 0) {
                for (const m of net.mesh.values()) if (m.rtt) pr[m.slot] = Math.round(m.rtt + m.jitter);
            }
            send(c.inp, { t: "ping", ts: now(), f: net.frame, fps: net.fps, ms: Math.round(net.workMs),
                w: net.session && net.waiting ? 1 : 0, h: document.hidden ? 1 : 0,
                m: net.margin, a: net.role === "host" ? net.avgMargin : undefined, pr,
                d: net.role === "host" && net.session ? net.delay : undefined });
            if (n++ % 4 === 0) updateRoute(c).catch(() => {});
        }, 500);
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
                if (!c.ctl.metadata || c.ctl.metadata.v !== VERSION) {
                    ui.status("A friend has an older copy of this page open. They need to reload it (Ctrl+F5).", 10000);
                    send(c.ctl, { t: "version" });
                    setTimeout(() => dropConn(conn.peer), 1000);
                    return;
                }
                if (c.slot >= MAX_PLAYERS) { send(c.ctl, { t: "full" }); setTimeout(() => dropConn(conn.peer), 500); return; }
                wire(c);
                send(c.ctl, { t: "welcome", slot: c.slot, v: VERSION });
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
        const players = [{ slot: 0 }, ...[...net.conns.entries()].filter(([, c]) => c.ctl && c.ctl.open).map(([id, c]) => ({ slot: c.slot, id }))];
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
            c.ctl = net.peer.connect(id, { label: "ctl", reliable: true, metadata: { v: VERSION } });
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
        net.peer.on("connection", (conn) => {
            if (conn.label !== "mesh" || !conn.metadata) { conn.close(); return; }
            addLink(conn, conn.metadata.slot);
        });
    }

    // ---------- guest-to-guest links ----------
    // Guests also connect to each other directly, so their inputs skip the hop through the
    // host. The host keeps relaying them too (whichever copy arrives first is used), so a link
    // that can't be made, or drops, costs nothing.
    function meshUpdate() {
        if (net.role !== "guest" || !net.peer) return;
        const want = new Map();
        for (const p of net.lobby || []) if (p.slot > 0 && p.slot !== net.mySlot && p.id) want.set(p.slot, p.id);
        for (const [slot, m] of net.mesh) if (want.get(slot) !== m.id) closeLink(m);
        for (const [slot, id] of want) {
            if (net.mesh.has(slot) || slot < net.mySlot) continue;   // the lower slot dials the higher one
            addLink(net.peer.connect(id, { label: "mesh", reliable: false, serialization: "json", metadata: { slot: net.mySlot } }), slot);
        }
    }

    function addLink(conn, slot) {
        const old = net.mesh.get(slot);
        if (old) closeLink(old);
        const m = { inp: conn, slot, id: conn.peer, rtt: 0 };
        net.mesh.set(slot, m);
        conn.on("open", () => startPings(m));
        conn.on("data", (msg) => (msg.t === "i" ? onInput(m, msg) : onPing(m, msg)));
        conn.on("close", () => closeLink(m));
        conn.on("error", () => closeLink(m));
    }

    function closeLink(m) {
        if (net.mesh.get(m.slot) === m) net.mesh.delete(m.slot);
        clearInterval(m.pinger);
        try { m.inp.close(); } catch (e) {}
    }

    function leave() {
        for (const id of [...net.conns.keys()]) {
            const c = net.conns.get(id);
            clearInterval(c.pinger);
            try { c.ctl && c.ctl.close(); c.inp && c.inp.close(); } catch (e) {}
        }
        net.conns.clear();
        for (const m of [...net.mesh.values()]) closeLink(m);
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
                const c = peerOfSlot(p.slot) || net.mesh.get(p.slot);
                const r = c && c.remote;
                const info = [];
                if (c && c.rtt) info.push(Math.round(c.rtt) + " ms" + (c.route ? " " + c.route : ""));
                if (r && r.fps !== undefined) info.push(r.fps + " fps" + (r.ms ? " (" + r.ms + " ms/frame)" : ""));
                if (p.slot === net.mySlot && net.session && net.workMs) info.push(Math.round(net.workMs) + " ms/frame");
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
                    '<p class="net-row">Input delay: <button id="net-dminus">−</button> <b>' + (net.delayOverride || "auto (" + (net.session ? net.delay : chooseDelay()) + ")") + '</b> <button id="net-dplus">+</button></p>' +
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
            const nudge = (d) => {
                net.delayOverride = Math.max(2, Math.min(10, (net.delayOverride || net.delay) + d));
                if (net.session) setDelay(net.delayOverride);
                ui.refresh();
            };
            on("net-dminus", () => nudge(-1));
            on("net-dplus", () => nudge(1));
        },
    };

    // Called by index.html once the game is running.
    net.init = function () {
        window.DC_LOOP.pre = pre;
        window.DC_LOOP.post = post;
        const join_ = new URLSearchParams(location.search).get("join");
        if (join_) join(join_);
        ui.refresh();
        setInterval(syncTick, 1000);
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
        net.software = /Basic Render Driver|SwiftShader|llvmpipe|softpipe|Software/i.test(renderer);
        if (net.software) {
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
