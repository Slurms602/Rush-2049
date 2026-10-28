#!/usr/bin/env node
// Drive a complete forward lap in the real US v1.001 game, including the jump.
// Requires Playwright/Chromium, Python with the builder dependencies, and serve.py
// configured with the owner's private game and BIOS. Never reads a cached save state.
// Usage: node tools/tests/custom-track-drive.cjs <site-url> <private-output-dir> [bundle-dir]
const { chromium, firefox } = require('playwright');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [site, output, bundle] = process.argv.slice(2);
if (!site || !output) throw new Error('Usage: custom-track-drive.cjs <site-url> <private-output-dir>');
const shortcutThrottle = Number(process.env.RUSH_SHORTCUT_THROTTLE || 0);
if (!Number.isFinite(shortcutThrottle) || shortcutThrottle < 0 || shortcutThrottle > 1) throw new Error('Shortcut throttle must be between 0 and 1');
const laps = Number(process.env.RUSH_DRIVE_LAPS || 1);
if (!Number.isInteger(laps) || laps < 1 || laps > 3) throw new Error('RUSH_DRIVE_LAPS must be 1, 2 or 3');
const browserName = process.env.RUSH_TEST_BROWSER || 'chromium';
if (!['chromium', 'firefox'].includes(browserName)) throw new Error('Unsupported test browser');
const root = path.resolve(__dirname, '../..');
const trackID = new URL(site).searchParams.get('track') || 'neon-skyway';
const route = JSON.parse(execFileSync('python3', ['tools/tests/drive_route.py',
    bundle ? path.join(path.resolve(bundle), 'track.json') : `tracks/${trackID}/track.json`,
    process.env.RUSH_SHORTCUTS || 'none'], { cwd: root, encoding: 'utf8' }));
const sections = route.sections;
fs.mkdirSync(output, { recursive: true });
(async () => {
    const browser = await (browserName === 'firefox' ? firefox : chromium).launch({
        headless: process.env.RUSH_TEST_HEADED !== '1',
        ...(browserName === 'firefox' ? { firefoxUserPrefs: {
            'webgl.force-enabled': true, 'webgl.disabled': false,
            'gfx.webrender.software': true, 'media.autoplay.default': 0,
        } } : { args: ['--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
        ...(process.env.RUSH_DEBUG_PORT ? ['--remote-debugging-port=' + Number(process.env.RUSH_DEBUG_PORT)] : [])] }) });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
        page.on('console', (message) => fs.appendFileSync(path.join(output, 'browser.log'), message.text() + '\n'));
        await page.addInitScript(() => {
            window.__driveError = null;
            addEventListener('error', (e) => { if (e.message) window.__driveError = e.message; });
        });
        if (bundle) await page.route(`**/tracks/${trackID}/*`, (route) => {
            const name = path.basename(new URL(route.request().url()).pathname);
            return route.fulfill({ path: path.join(path.resolve(bundle), name) });
        });
        page.on('pageerror', (e) => {
            // Headless Chromium denies the emulator's optional screen wake lock.
            if (!/Wake Lock permission request denied/.test(e.message)) {
                errors.push(e.message); console.error('Emulator page error:', e.message);
            }
        });
        const url = new URL(site);
        url.searchParams.set('track', trackID);
        url.searchParams.delete('join'); url.searchParams.delete('pick');
        await page.goto(url.href);
        await page.waitForFunction(() => window.DC_TRACK?.ready && window.EJS_emulator?.started,
            null, { timeout: 300000 });
        await page.evaluate(() => {
            document.getElementById('gpu-warning').hidden = true;
            window.QA = { frame: 0, budget: 0 };
            DC_LOOP.pre = () => { if (QA.budget <= 0) return false; QA.budget--; return true; };
            DC_LOOP.post = () => QA.frame++;
            EJS_emulator.gameManager.Module._fly_set_lockstep(1);
            EJS_emulator.gameManager.setVSync(false);
        });
        if (process.env.RUSH_TEST_RESOLUTION_CYCLE === '1') await page.evaluate(() => {
            EJS_emulator.gameManager.setVariable('reicast_internal_resolution', '640x480');
        });
        async function step(n, input = []) {
            const target = await page.evaluate(({ n, input }) => {
                for (const [i, v] of input) EJS_emulator.gameManager.functions.simulateInput(0, i, v);
                QA.budget = n; return QA.frame + n;
            }, { n, input });
            try {
                await page.waitForFunction((f) => QA.frame >= f || window.DRIVE?.invalidPosition || window.DRIVE?.fall || window.__driveError
                    || !EJS_emulator.gameManager.Module._wasm_get_ram_base(),
                    target, { timeout: 120000, polling: 200 });
            } catch (error) {
                const diagnostic = await Promise.race([page.evaluate(() => {
                    const M = EJS_emulator.gameManager.Module;
                    const base = M._wasm_get_ram_base(), i = base / 4 + 0x14cde0 / 4;
                    const ctx = M._fly_ctx_ptr?.();
                    M._fly_dump_pc_trace?.();
                    return { qa: QA, error: window.__driveError, drive: window.DRIVE,
                        coreLog: window._flyLog?.slice(-150),
                        ram: { base, bytes: M.HEAPU8.length, start: window.__driveRAM,
                            code: Array.from(M.HEAPU8.slice(base + 0x10000, base + 0x10040)),
                            ctx: ctx ? Array.from(M.HEAPU32.slice(ctx / 4, ctx / 4 + 128)) : null },
                        car: Array.from(M.HEAPF32.slice(i, i + 18)) };
                }), new Promise((resolve) => setTimeout(() => resolve({ error: 'Renderer unresponsive' }), 10000))]);
                fs.writeFileSync(path.join(output, 'timeout.json'), JSON.stringify(diagnostic, null, 2));
                throw error;
            }
        }
        await step(1800);
        await step(300, [[3, 1]]); await step(1, [[3, 0]]);
        await step(120, [[3, 1]]); await step(1, [[3, 0]]);
        // Just Play, Single Race, Marina, default car, start loading.
        for (let i = 0; i < 5; i++) { await step(120, [[0, 1]]); await step(1, [[0, 0]]); }
        await step(650);
        await page.screenshot({ path: path.join(output, 'grid.png') });
        await page.evaluate(({ sections, fullThrottle, shortcutThrottle }) => {
            const gm = EJS_emulator.gameManager, M = gm.Module;
            const base = M._wasm_get_ram_base();
            window.__driveRAM = { base, bytes: M.HEAPU8.length,
                code: Array.from(M.HEAPU8.slice(base + 0x10000, base + 0x10040)) };
            window.DRIVE = { frame: 0, laps: 0, respawns: 0, last: null, lastIndex: 0, crossings: [], log: [] };
            // Sample the rendered scene inside postMainLoop, while the WebGL
            // drawing buffer is still valid. Finite car coordinates alone don't
            // detect a black picture with a working HUD or continuing audio.
            const sample = document.createElement('canvas'); sample.width = 64; sample.height = 48;
            const ctx = sample.getContext('2d', { willReadFrequently: true });
            DRIVE.pictures = [];
            DC_LOOP.post = () => {
                QA.frame++;
                if (DRIVE.frame % 300) return;
                const c = EJS_emulator.canvas;
                ctx.drawImage(c, c.width * .2, c.height * .2, c.width * .6, c.height * .5, 0, 0, 64, 48);
                const pixels = ctx.getImageData(0, 0, 64, 48).data;
                let lit = 0;
                for (let j = 0; j < pixels.length; j += 4) if (pixels[j] + pixels[j + 1] + pixels[j + 2] > 30) lit++;
                DRIVE.pictures.push({ frame: DRIVE.frame, lit: lit / (64 * 48) });
            };
            DC_LOOP.pre = () => {
                if (QA.budget <= 0) return false;
                try {
                const f = M.HEAPF32, i = M._wasm_get_ram_base() / 4 + 0x14cde0 / 4;
                const p = [f[i], f[i + 1], f[i + 2]];
                if (!p.every(Number.isFinite)) {
                    DRIVE.invalidPosition = p; QA.budget = 0; return false;
                }
                if (p[1] < 500) {
                    DRIVE.fall = p; QA.budget = 0; return false;
                }
                let distance = Infinity, idx = 0;
                for (let k = 0; k < sections.length; k++) {
                    const q = sections[k].pos, d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
                    if (d < distance) { distance = d; idx = k; }
                }
                const speed = DRIVE.last ? Math.hypot(p[0] - DRIVE.last[0], p[2] - DRIVE.last[2]) * 60 : 0;
                if (DRIVE.last && Math.hypot(...p.map((v, k) => v - DRIVE.last[k])) * 60 > 6000) DRIVE.respawns++;
                const ahead = fullThrottle ? Math.round(Math.max(10, Math.min(28, 10 + speed * 0.055)))
                    : Math.round(Math.max(7, Math.min(19, 4 + speed * 0.045)));
                const q = sections[(idx + ahead) % sections.length].pos;
                // Front wheel midpoint minus rear wheel midpoint gives the car's heading.
                const v = [f[i + 6] + f[i + 9] - f[i + 12] - f[i + 15],
                    f[i + 8] + f[i + 11] - f[i + 14] - f[i + 17]];
                const dx = q[0] - p[0], dz = q[2] - p[2];
                const angle = Math.atan2(v[0] * dz - v[1] * dx, v[0] * dx + v[1] * dz);
                const model = M._wasm_get_ram_base() + 0x14cbb4;
                const materials = Array.from(M.HEAPU32.slice((model + 0x60c) / 4, (model + 0x61c) / 4));
                const jumpZone = Array.from({ length: 51 }, (_, j) =>
                    sections[(idx + j - 40 + sections.length) % sections.length].gap).some(Boolean);
                // Steering also rolls the wings in flight. Keep a level glide over
                // the authored jumps instead of trying to turn toward the runout.
                const steer = jumpZone && materials.every((m) => m === 8) ? 0
                    : Math.max(-1, Math.min(1, -angle * 2.5));
                const velocity = DRIVE.last ? [p[0] - DRIVE.last[0], p[2] - DRIVE.last[2]] : [0, 0];
                const slip = speed > 10 ? Math.atan2(v[0] * velocity[1] - v[1] * velocity[0],
                    v[0] * velocity[0] + v[1] * velocity[1]) * 180 / Math.PI : 0;
                gm.functions.simulateInput(0, 16, Math.round(Math.max(0, steer) * 32767));
                gm.functions.simulateInput(0, 17, Math.round(Math.max(0, -steer) * 32767));
                let targetSpeed = 300;
                for (let k = 0; k <= 45; k++) {
                    const limit = sections[(idx + k) % sections.length].limit;
                    targetSpeed = Math.min(targetSpeed, Math.sqrt(limit ** 2 + 2 * 105 * k * 10));
                }
                const inAir = materials.every(m => m === 8);
                const launch = shortcutThrottle > 0 && (['approach', 'ramp', 'flight'].includes(sections[idx].phase) || (sections[idx].shortcut && inAir));
                const braking = !fullThrottle && !launch && speed > targetSpeed + 5;
                gm.functions.simulateInput(0, 13, braking ? 0 : (launch && (DRIVE.frame % 20) >= Math.round(shortcutThrottle * 20) ? 0 : 32767));
                gm.functions.simulateInput(0, 12, braking ? 32767 : 0);
                gm.functions.simulateInput(0, 8, (sections[idx].gap || (shortcutThrottle > 0 && sections[idx].shortcut && inAir)) ? 1 : 0); // B: wings
                if (idx < 40 && DRIVE.lastIndex > sections.length - 40) {
                    DRIVE.laps++; DRIVE.crossings.push(DRIVE.frame);
                }
                DRIVE.lastIndex = idx; DRIVE.last = p;
                if (DRIVE.frame % 10 === 0) {
                    DRIVE.log.push({ frame: DRIVE.frame, p, idx, speed,
                        slip, steer, targetSpeed, braking, phase: sections[idx].phase, error: Math.sqrt(distance), gap: sections[idx].gap, jump: sections[idx].jump, shortcut: sections[idx].shortcut, mainIndex: sections[idx].mainIndex, laps: DRIVE.laps,
                        materials,
                        suspension: Array.from(f.slice((model + 0x5cc) / 4, (model + 0x5dc) / 4)) });
                }
                DRIVE.frame++; QA.budget--; return true;
                } catch (error) {
                    window.__driveError = error.stack || error.message;
                    QA.budget = 0; return false;
                }
            };
        }, { sections, fullThrottle: process.env.RUSH_DRIVE_MODE === 'grip', shortcutThrottle });
        let result;
        for (let i = 1; i <= 20 * laps; i++) {
            if (process.env.RUSH_TEST_RESOLUTION_CYCLE === '1' && (i === 2 || i === 4)) {
                await page.evaluate((resolution) => EJS_emulator.gameManager.setVariable(
                    'reicast_internal_resolution', resolution), i === 2 ? '1280x960' : '640x480');
                await page.setViewportSize(i === 2 ? { width: 1100, height: 800 } : { width: 960, height: 720 });
            }
            await step(300);
            result = await page.evaluate(() => ({ fingerprint: DC_TRACK.fingerprint,
                nativeError: window.__driveError || (!EJS_emulator.gameManager.Module._wasm_get_ram_base() ? 'Native core shut down' : null), ...DRIVE }));
            fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(result, null, 2));
            await page.screenshot({ path: path.join(output, 'drive-' + i + '.png') });
            console.log('Driving', result.frame, 'laps', result.laps, 'position', result.last);
            if (result.nativeError || result.invalidPosition || result.fall || result.laps >= laps + 1) break; // First crossing is the starting grid.
        }
        result.route = { shortcuts: route.shortcuts, mainLength: route.mainLength, routeLength: route.routeLength };
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
        assert.equal(errors.length, 0, errors.join('\n'));
        assert.ok(!result.nativeError, result.nativeError);
        assert.ok(!result.invalidPosition, `Native car position became nonfinite at driving frame ${result.frame}`);
        assert.ok(result.pictures.length > 0 && result.pictures.every((p) => p.lit > .05),
            'The central 3D scene must remain visible throughout the lap');
        assert.ok(!result.fall, `Car fell below the track at driving frame ${result.frame}`);
        assert.ok(result.laps >= laps + 1, `Car must complete ${laps} forward lap(s) within ${6000 * laps} driving frames`);
        assert.equal(result.respawns, 0, 'Respawning must not disguise a missed jump');
        for (const id of route.shortcuts) {
            if (process.env.RUSH_SHORTCUT_THROTTLE) {
                const approach = result.log.filter(r => r.shortcut === id && ['approach', 'ramp'].includes(r.phase));
                assert.ok(approach.length > 5 && approach.every(r => !r.braking), `Shortcut ${id} must be approached without braking`);
                assert.ok(result.log.find(r => r.shortcut === id && r.gap && r.materials.every(m=>m===8))?.speed >= 160 * shortcutThrottle, `Shortcut ${id} must be taken at racing speed`);
                console.log(`${id}: no-brake approach; takeoff speed ${Math.round(result.log.find(r => r.shortcut === id && r.gap && r.materials.every(m=>m===8))?.speed || 0)} ft/s`);
            }
            const airborne = result.log.find((r) => r.shortcut === id && r.gap && r.materials.every((m) => m === 8));
            assert.ok(airborne, `Shortcut ${id} must include real flight`);
            const landing = result.log.find((r) => r.frame > airborne.frame && r.materials.filter((m) => m === 0).length >= 2);
            const deck = route.landings.find((q) => q.id === id).deck;
            assert.ok(landing && deck.some(({ pos, width }) => Math.abs(landing.p[1] - pos[1]) < 25
                && Math.hypot(landing.p[0] - pos[0], landing.p[2] - pos[2]) < width / 2 + 15),
                `Shortcut ${id} must land on its intended rejoin, including the correct level`);
        }
        if (route.shortcuts.length) assert.ok(route.routeLength < route.mainLength, 'A shortcut must shorten the lap');
        for (const jump of new Set(sections.filter((s) => s.gap).map((s) => s.jump))) {
            assert.ok(result.log.some((r) => r.jump === jump), `The lap must include jump ${jump}`);
        }
        assert.ok(result.log.every((r) => r.p.every(Number.isFinite) && r.p[1] > 500 && r.p[1] < 950),
            'Car must stay at road altitude throughout the lap, including takeoff and landing');
        if (process.env.RUSH_DRIVE_MODE !== 'grip') {
            // Allow the intentional flight and settling runout. Elsewhere the
            // suspension must retain contact, even when all position checks pass.
            const solid = result.log.filter((r) => r.speed > 80 && !Array.from({ length: 51 }, (_, j) =>
                sections[(r.idx + j - 40 + sections.length) % sections.length].gap).some(Boolean));
            assert.ok(solid.length > 100, 'Contact check needs enough moving samples on solid road');
            const grounded = solid.filter((r) => r.materials.every((m) => m === 0)).length;
            assert.ok(grounded / solid.length >= 0.95,
                `All four tires must retain pavement contact in 95% of solid-road samples (${grounded}/${solid.length})`);
            assert.ok(solid.every((r) => !r.materials.every((m) => m === 8)),
                'No unplanned flight is allowed away from the jump');
            console.log(`Contact: ${grounded}/${solid.length} solid-road samples have four tires on pavement.`);
        }
        console.log('PASS: complete forward lap, gap crossed, no falls or respawns. Review screenshots for rendering.');
    } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
