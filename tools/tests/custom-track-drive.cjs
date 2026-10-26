#!/usr/bin/env node
// Drive a complete forward lap in the real US v1.001 game, including the jump.
// Requires Playwright/Chromium, Python with the builder dependencies, and serve.py
// configured with the owner's private game and BIOS. Never reads a cached save state.
// Usage: node tools/tests/custom-track-drive.cjs <site-url> <private-output-dir>
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [site, output] = process.argv.slice(2);
if (!site || !output) throw new Error('Usage: custom-track-drive.cjs <site-url> <private-output-dir>');
const root = path.resolve(__dirname, '../..');
const sections = JSON.parse(execFileSync('python3', ['-c', `
import json,sys
sys.path.insert(0,'tools/trackbuilder')
from trackbuilder import resample,frames
s,_=resample(json.load(open('tracks/neon-skyway/track.json')));frames(s)
print(json.dumps([dict(pos=q['pos'].tolist(),gap=q['gap']) for q in s]))
`], { cwd: root, encoding: 'utf8' }));
fs.mkdirSync(output, { recursive: true });
(async () => {
    const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
        page.on('pageerror', (e) => {
            // Headless Chromium denies the emulator's optional screen wake lock.
            if (!/Wake Lock permission request denied/.test(e.message)) errors.push(e.message);
        });
        const url = new URL(site);
        url.searchParams.set('track', 'neon-skyway');
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
        async function step(n, input = []) {
            const target = await page.evaluate(({ n, input }) => {
                for (const [i, v] of input) EJS_emulator.gameManager.functions.simulateInput(0, i, v);
                QA.budget = n; return QA.frame + n;
            }, { n, input });
            await page.waitForFunction((f) => QA.frame >= f, target, { timeout: 300000, polling: 200 });
        }
        await step(1800);
        await step(300, [[3, 1]]); await step(1, [[3, 0]]);
        await step(120, [[3, 1]]); await step(1, [[3, 0]]);
        // Just Play, Single Race, Marina, default car, start loading.
        for (let i = 0; i < 5; i++) { await step(120, [[0, 1]]); await step(1, [[0, 0]]); }
        await step(650);
        await page.screenshot({ path: path.join(output, 'grid.png') });
        await page.evaluate((sections) => {
            const gm = EJS_emulator.gameManager, M = gm.Module;
            window.DRIVE = { frame: 0, laps: 0, respawns: 0, last: null, lastIndex: 0, log: [] };
            DC_LOOP.pre = () => {
                if (QA.budget <= 0) return false;
                const f = M.HEAPF32, i = M._wasm_get_ram_base() / 4 + 0x14cde0 / 4;
                const p = [f[i], f[i + 1], f[i + 2]];
                let distance = Infinity, idx = 0;
                for (let k = 0; k < sections.length; k++) {
                    const q = sections[k].pos, d = (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
                    if (d < distance) { distance = d; idx = k; }
                }
                const speed = DRIVE.last ? Math.hypot(p[0] - DRIVE.last[0], p[2] - DRIVE.last[2]) * 60 : 0;
                if (speed > 6000) DRIVE.respawns++;
                const ahead = Math.round(Math.max(10, Math.min(28, 10 + speed * 0.055)));
                const q = sections[(idx + ahead) % sections.length].pos;
                // Front wheel midpoint minus rear wheel midpoint gives the car's heading.
                const v = [f[i + 6] + f[i + 9] - f[i + 12] - f[i + 15],
                    f[i + 8] + f[i + 11] - f[i + 14] - f[i + 17]];
                const dx = q[0] - p[0], dz = q[2] - p[2];
                const angle = Math.atan2(v[0] * dz - v[1] * dx, v[0] * dx + v[1] * dz);
                const steer = Math.max(-1, Math.min(1, -angle * 2.5));
                gm.functions.simulateInput(0, 16, Math.round(Math.max(0, steer) * 32767));
                gm.functions.simulateInput(0, 17, Math.round(Math.max(0, -steer) * 32767));
                gm.functions.simulateInput(0, 13, 32767);
                gm.functions.simulateInput(0, 8, sections[idx].gap ? 1 : 0); // B: wings
                if (idx < 40 && DRIVE.lastIndex > sections.length - 40) DRIVE.laps++;
                DRIVE.lastIndex = idx; DRIVE.last = p;
                if (DRIVE.frame % 10 === 0) DRIVE.log.push({ frame: DRIVE.frame, p, idx, speed,
                    error: Math.sqrt(distance), gap: sections[idx].gap, laps: DRIVE.laps });
                DRIVE.frame++; QA.budget--; return true;
            };
        }, sections);
        let result;
        for (let i = 1; i <= 12; i++) {
            await step(300);
            result = await page.evaluate(() => ({ fingerprint: DC_TRACK.fingerprint, ...DRIVE }));
            await page.screenshot({ path: path.join(output, 'drive-' + i + '.png') });
            console.log('Driving', result.frame, 'laps', result.laps, 'position', result.last);
            if (result.laps >= 2) break; // First crossing is the starting grid, second is a complete lap.
        }
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
        assert.equal(errors.length, 0, errors.join('\n'));
        assert.ok(result.laps >= 2, 'Car must complete a forward lap within 3600 driving frames');
        assert.equal(result.respawns, 0, 'Respawning must not disguise a missed jump');
        assert.ok(result.log.some((r) => r.gap), 'The lap must include the authored gap');
        assert.ok(result.log.every((r) => r.p.every(Number.isFinite) && r.p[1] > 500 && r.p[1] < 950),
            'Car must stay at road altitude throughout the lap, including takeoff and landing');
        console.log('PASS: complete forward lap, gap crossed, no falls or respawns. Review screenshots for rendering.');
    } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
