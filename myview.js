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
    const CHECK_EVERY = 20;     // frames between checks (reading pixels stalls the GPU briefly)
    const CONFIRM = 3;          // same answer this many times in a row before switching

    const view = { on: true, layout: null, pending: null, count: 0, frames: 0 };
    window.DC_VIEW = view;

    const canvas = () => window.EJS_emulator && window.EJS_emulator.canvas;

    // RetroArch draws the 4:3 picture centred in the canvas.
    function pictureRect(w, h) {
        const pw = Math.min(w, h * 4 / 3), ph = pw * 3 / 4;
        return { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph };
    }

    function detect() {
        const gl = canvas().getContext("webgl2");
        const r = pictureRect(gl.drawingBufferWidth, gl.drawingBufferHeight);
        const width = Math.max(1, Math.round(r.w));
        const row = (fy) => {
            const px = new Uint8Array(width * 4);
            gl.readPixels(Math.round(r.x), Math.round(r.y + (1 - fy) * r.h), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return px;
        };
        // Nearly every pixel between fractions a and b of the row is black.
        const dark = (px, a, b) => {
            let bright = 0, n = 0;
            for (let i = Math.floor(a * width); i < Math.floor(b * width); i++, n++) {
                if (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] > 60) bright++;
            }
            return bright <= n * 0.02;
        };
        // The gap is only a few pixels tall: read every pixel row in the band at once.
        const y0 = Math.round(r.y + (1 - GAP[1]) * r.h), y1 = Math.round(r.y + (1 - GAP[0]) * r.h);
        const band = new Uint8Array(width * (y1 - y0 + 1) * 4);
        gl.readPixels(Math.round(r.x), y0, width, y1 - y0 + 1, gl.RGBA, gl.UNSIGNED_BYTE, band);
        let gap = null;
        for (let k = 0; k <= y1 - y0 && !gap; k++) {
            const line = band.subarray(k * width * 4, (k + 1) * width * 4);
            if (dark(line, 0.02, 0.40)) gap = line;
        }
        if (!gap) return null;
        if (dark(row(0.40), 0.02, 0.40) || dark(row(0.60), 0.02, 0.40)) return null;   // a black screen, not a split
        return dark(gap, 0.80, 0.98) ? "quads" : "halves";
    }

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
        let layout = null;
        try { layout = detect(); } catch (e) { return; }
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
