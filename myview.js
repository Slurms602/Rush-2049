// Online, every player runs the whole game, so a split-screen race would show everyone all
// the views. This finds the race split (the black gap between the top and bottom views)
// and shows only this player's view, enlarged to fill the window.
//
// Layout measured on Rush 2049, as fractions of the 4:3 picture: 2 players get the left
// three quarters of the top/bottom halves (the right quarter is a shared map/timer panel);
// 3-4 players get quadrants (player 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right).
(function () {
    "use strict";
    const HALVES = [
        { x: 0.000, y: 0.025, w: 0.750, h: 0.456 },
        { x: 0.000, y: 0.4875, w: 0.750, h: 0.454 },
    ];
    const QUADS = [
        { x: 0.003, y: 0.025, w: 0.494, h: 0.456 },
        { x: 0.503, y: 0.025, w: 0.494, h: 0.456 },
        { x: 0.003, y: 0.4875, w: 0.494, h: 0.454 },
        { x: 0.503, y: 0.4875, w: 0.494, h: 0.454 },
    ];
    const GAP = [0.474, 0.492]; // the black rows between the top and bottom views lie in here
    const CHECK_EVERY = 20;     // frames between checks
    const CONFIRM = 2;          // same answer this many times in a row before switching

    // Parts of the picture the check reads, as fractions [x0, y0, x1, y1] (y from the top).
    const REGIONS = {
        band: [0, GAP[0], 1, GAP[1]],   // the gap is only a few pixels tall: every row in the band
        row40: [0, 0.40, 1, 0.40],
        row60: [0, 0.60, 1, 0.60],
        mid: [0.44, 0, 0.56, 1],
        centre: [0.48, 0.10, 0.52, 0.40],
    };

    const view = { on: true, layout: null, pending: null, count: 0, frames: 0 };
    window.DC_VIEW = view;

    const canvas = () => window.EJS_emulator && window.EJS_emulator.canvas;

    // RetroArch draws the 4:3 picture centred in the canvas.
    function pictureRect(w, h) {
        const pw = Math.min(w, h * 4 / 3), ph = pw * 3 / 4;
        return { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph };
    }

    const dark = (r, g, b) => r + g + b <= 60;
    // Menu outlines are deep blue (including b=132). Require little red so thin
    // purple sky bands (about r=41, g=32, b=123) are not mistaken for a pause menu.
    const menuBlue = (r, g, b) => b >= 120 && b > 4 * r && b > 2 * g;

    // Where each region lies in the drawing buffer, and where its pixels go in one byte array.
    function regionsOf(gl) {
        const r = pictureRect(gl.drawingBufferWidth, gl.drawingBufferHeight);
        const out = {};
        let size = 0;
        for (const k in REGIONS) {
            const [x0, y0, x1, y1] = REGIONS[k];
            const left = Math.round(r.x + x0 * r.w), bottom = Math.round(r.y + (1 - y1) * r.h);
            const w = Math.max(1, Math.round(r.x + x1 * r.w) - left);
            const h = Math.max(1, Math.round(r.y + (1 - y0) * r.h) - bottom);
            out[k] = { left, bottom, w, h, offset: size };
            size += w * h * 4;
        }
        return { regions: out, size };
    }

    // A region's pixels (rows bottom-up, as read): row(k) and col(i) give the share of pixels
    // passing a test, row 0 being the top one.
    function block(px, w, h) {
        const share = (test, o, step, n) => {
            let hit = 0;
            for (let i = 0; i < n; i++, o += step) if (test(px[o], px[o + 1], px[o + 2])) hit++;
            return hit / n;
        };
        return {
            w, h,
            row: (k, test, a = 0, b = 1) => {
                const i0 = Math.floor(a * w), n = Math.max(1, Math.floor(b * w) - i0);
                return share(test, ((h - 1 - k) * w + i0) * 4, 4, n);
            },
            col: (i, test) => share(test, i * 4, w * 4, h),
        };
    }

    function analyze(data, regions) {
        const get = (k) => {
            const b = regions[k];
            return block(data.subarray(b.offset, b.offset + b.w * b.h * 4), b.w, b.h);
        };
        const band = get("band");
        let gap = -1;
        for (let k = 0; k < band.h && gap < 0; k++) if (band.row(k, dark, 0.02, 0.40) >= 0.98) gap = k;
        if (gap < 0) return null;
        if (get("row40").row(0, dark, 0.02, 0.40) >= 0.98
            || get("row60").row(0, dark, 0.02, 0.40) >= 0.98) return null;   // a black screen, not a split
        // The pause menu and its submenus are drawn over the split views as boxes with thin blue
        // outlines across the middle of the picture: show the whole screen then.
        const mid = get("mid");
        let lines = 0;
        for (let k = 0, run = 0; k <= mid.h; k++) {
            if (k < mid.h && mid.row(k, menuBlue) >= 0.95) run++;
            else { if (run && run <= mid.h * 0.02) lines++; run = 0; }
        }
        if (lines >= 2) return null;
        // Quadrants also have a black column down the middle (the 2-player race intro has a dark
        // right-hand panel, so the gap row alone can't tell).
        const centre = get("centre");
        let column = false;
        for (let i = 0; i < centre.w && !column; i++) column = centre.col(i, dark) >= 0.95;
        return column && band.row(gap, dark, 0.80, 0.98) >= 0.98 ? "quads" : "halves";
    }

    // Reading pixels straight back would make the CPU wait for the GPU to finish drawing.
    // Instead each check copies the regions into a GPU buffer, and the next check (when the
    // copy is long done) reads them out.
    let pbo = null, pboSize = 0, fence = null, captured = null;

    function capture(gl) {
        const c = regionsOf(gl);
        const prev = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        if (!pbo) pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        if (c.size > pboSize) { gl.bufferData(gl.PIXEL_PACK_BUFFER, c.size, gl.STREAM_READ); pboSize = c.size; }
        for (const k in c.regions) {
            const b = c.regions[k];
            gl.readPixels(b.left, b.bottom, b.w, b.h, gl.RGBA, gl.UNSIGNED_BYTE, b.offset);
        }
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prev);
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        captured = c;
    }

    function collect(gl) {
        const data = new Uint8Array(captured.size);
        const prev = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
        gl.bindBuffer(gl.COPY_READ_BUFFER, pbo);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, data);
        gl.bindBuffer(gl.COPY_READ_BUFFER, prev);
        gl.deleteSync(fence);
        fence = null;
        return analyze(data, captured.regions);
    }

    // For tests: read and analyze the current frame at once.
    view.detect = function () {
        const gl = canvas().getContext("webgl2"), c = regionsOf(gl), data = new Uint8Array(c.size);
        for (const k in c.regions) {
            const b = c.regions[k];
            gl.readPixels(b.left, b.bottom, b.w, b.h, gl.RGBA, gl.UNSIGNED_BYTE, data.subarray(b.offset, b.offset + b.w * b.h * 4));
        }
        return analyze(data, c.regions);
    };

    function apply() {
        const c = canvas();
        if (!c) return;
        const net = window.DC_NET;
        const regions = view.layout === "quads" ? QUADS : HALVES;
        const reg = view.on && net && net.session && view.layout ? regions[net.mySlot] : null;
        if (!reg) {
            c.style.transform = "";
            c.style.clipPath = "";
            return;
        }
        const cw = c.clientWidth, ch = c.clientHeight, r = pictureRect(cw, ch);
        const rx = r.x + reg.x * r.w, ry = r.y + reg.y * r.h, rw = reg.w * r.w, rh = reg.h * r.h;
        const s = Math.min(cw / rw, ch / rh);
        c.style.transformOrigin = "0 0";
        c.style.transform = `translate(${(cw - rw * s) / 2 - rx * s}px, ${(ch - rh * s) / 2 - ry * s}px) scale(${s})`;
        c.style.clipPath = `inset(${ry}px ${cw - rx - rw}px ${ch - ry - rh}px ${rx}px)`;
    }

    // Called by netplay.js after every emulated frame while online.
    view.tick = function () {
        if (++view.frames % CHECK_EVERY) return;
        let layout;
        try {
            const gl = canvas().getContext("webgl2");
            if (fence && gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
            layout = fence ? collect(gl) : undefined;   // the frame copied at the previous check
            capture(gl);
        } catch (e) { return; }
        if (layout === undefined) return;
        if (layout === view.pending) view.count++;
        else { view.pending = layout; view.count = 1; }
        if (view.count >= CONFIRM && layout !== view.layout) {
            view.layout = layout;
            apply();
            updateButton();
        }
    };

    view.reset = function () {
        view.layout = view.pending = null;
        view.count = 0;
        apply();
        updateButton();
    };

    function updateButton() {
        const b = document.getElementById("my-view");
        if (!b) return;
        const net = window.DC_NET;
        b.hidden = !(net && net.session && view.layout);
        b.textContent = view.on ? "Show all views" : "Show my view";
    }

    view.toggle = function () {
        view.on = !view.on;
        apply();
        updateButton();
    };

    window.addEventListener("resize", apply);
})();
