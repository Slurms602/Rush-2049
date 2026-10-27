#!/usr/bin/env node
// Real Flycast + WebRTC test, starting from a fresh boot (never a cached game state).
// Usage: node tools/tests/custom-track-online.cjs <site-url> <output-dir> [race-frames=1200]
// Requires Playwright and Chromium. The local site should autorun the owner's GDI and BIOS
// (serve.py --game ... --bios ...). No game/BIOS/state data is committed by this test.
// --interactive: accept 'press <player:0|1> <RetroPad index>', 'wait <frames>', 'shot', 'done'.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const interactive = args.includes('--interactive');
const positional = args.filter((s) => s !== '--interactive');
const [site, output, frameArg = '1200'] = positional;
if (!site || !output) throw new Error('Usage: node custom-track-online.cjs <site-url> <output-dir> [race-frames=1200] [--interactive]');
const raceFrames = Number(frameArg);
if (!Number.isInteger(raceFrames) || raceFrames < 1200) throw new Error('At least 1200 race frames are required');
fs.mkdirSync(output, { recursive: true });
const pages = [], logs = [[], []];
const errors = [];
// Exercise the graphics-card path even on a software-only CI machine. The
// regular software path never changes resolution when a friend joins.
const hardwarePath = process.env.RUSH_TEST_HARDWARE_PATH === '1';
let shot = 0;
let browser;
const log = (slot, message) => {
    logs[slot].push(message);
    if (/PAGEERROR|CRASH|\[net\]|\[track\]|\[mods\]/.test(message)) console.log('P' + (slot + 1), message);
};
function fatal(slot, message) {
    errors.push('P' + (slot + 1) + ': ' + message);
    for (const page of pages) page.evaluate(() => { window.__onlineFatal = true; }).catch(() => {});
}
async function open(slot, code) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', (error) => {
        log(slot, 'PAGEERROR ' + error.message);
        if (!/Wake Lock permission request denied/.test(error.message)) {
            fatal(slot, error.message);
        }
    });
    page.on('console', (message) => {
        log(slot, message.type() + ' ' + message.text());
        if (/Cannot open video driver|SH4 exception when blocked|CONTEXT_LOST_WEBGL/.test(message.text())) {
            fatal(slot, message.text());
        }
    });
    page.on('crash', () => { log(slot, 'CRASH'); fatal(slot, 'Browser renderer crashed'); });
    const url = new URL(site);
    if (!url.searchParams.has('track')) url.searchParams.set('track', 'neon-skyway');
    url.searchParams.delete('pick');
    if (code) url.searchParams.set('join', code); else url.searchParams.delete('join');
    await page.goto(url.href);
    await page.waitForFunction(() => window.DC_TRACK?.ready && window.EJS_emulator?.started
        && Number(EJS_emulator.gameManager.getFrameNum()) > 20, null, { timeout: 300000, polling: 1000 });
    await page.evaluate(() => { document.getElementById('gpu-warning').hidden = true; });
    if (hardwarePath) await page.evaluate(() => {
        DC_NET.software = false;
        window.__onlineResolutions = [];
        const g = EJS_emulator.gameManager, original = g.setVariable;
        g.setVariable = function(key, value) {
            if (key === 'reicast_internal_resolution') __onlineResolutions.push(value);
            return original.call(this, key, value);
        };
        g.setVariable('reicast_internal_resolution', '640x480');
    });
    return page;
}
async function frames(count) {
    const target = await pages[0].evaluate((n) => DC_NET.frame + n, count);
    await pages[0].waitForFunction((f) => DC_NET.frame >= f || window.__onlineFatal,
        target, { timeout: 300000, polling: 200 });
    assert.equal(errors.length, 0, errors.join('\n'));
}
async function screenshots(label) {
    for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(output,
        String(shot).padStart(2, '0') + '-' + label + '-p' + (i + 1) + '.png') });
    shot++;
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(label, await pages[0].evaluate(() => ({ frame: DC_NET.frame, epoch: DC_NET.epoch, desyncs: DC_NET.desyncs.length })));
}
async function press(player, index, held = 12, settled = 120) {
    const page = pages[player];
    await page.evaluate((i) => EJS_emulator.gameManager.simulateInput(0, i, 1), index);
    await frames(held);
    await page.evaluate((i) => EJS_emulator.gameManager.simulateInput(0, i, 0), index);
    await frames(settled);
}
async function localMenu(host) {
    // Finish BIOS/controller detection locally before the first shared snapshot. Saving
    // during BIOS initialization can leave controller reads unresponsive after restore.
    await host.evaluate(() => {
        window.__onlineTestLoop = { pre: DC_LOOP.pre, post: DC_LOOP.post, budget: 0, frame: 0 };
        DC_LOOP.pre = () => {
            if (__onlineTestLoop.budget <= 0) return false;
            __onlineTestLoop.budget--; return true;
        };
        DC_LOOP.post = () => { __onlineTestLoop.frame++; };
        EJS_emulator.gameManager.Module._fly_set_lockstep(1);
        EJS_emulator.gameManager.setVSync(false);
    });
    async function step(n) {
        const target = await host.evaluate((n) => {
            __onlineTestLoop.budget = n;
            return __onlineTestLoop.frame + n;
        }, n);
        await host.waitForFunction((f) => __onlineTestLoop.frame >= f, target, { timeout: 300000, polling: 200 });
    }
    const start = (value) => host.evaluate((v) => EJS_emulator.gameManager.functions.simulateInput(0, 3, v), value);
    await step(Number(process.env.INTRO_FRAMES || 1800));
    await host.screenshot({ path: path.join(output, 'local-intro.png') });
    await start(1); await step(300); await start(0); await step(1);
    await host.screenshot({ path: path.join(output, 'local-title.png') });
    await start(1); await step(120); await start(0); await step(60);
    await host.screenshot({ path: path.join(output, 'local-menu.png') });
    await host.evaluate(() => {
        DC_LOOP.pre = __onlineTestLoop.pre; DC_LOOP.post = __onlineTestLoop.post;
        EJS_emulator.gameManager.setVSync(true);
    });
}
(async () => {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
    try {
        const host = await open(0);
        await localMenu(host);
        await host.evaluate(() => DC_NET.host());
        await host.waitForFunction(() => DC_NET.peer?.open, null, { timeout: 60000 });
        const code = await host.evaluate(() => DC_NET.code);
        const guest = await open(1, code);
        await guest.waitForFunction(() => DC_NET.session && !DC_NET.waiting, null, { timeout: 90000, polling: 1000 });
        for (const page of pages) await page.evaluate(() => { document.getElementById('net-panel').hidden = true; });
        const fingerprints = await Promise.all(pages.map((p) => p.evaluate(() => DC_TRACK.fingerprint)));
        assert.equal(fingerprints[0], fingerprints[1], 'Both clients must install the exact same track');
        const epoch = await host.evaluate(() => DC_NET.epoch);
        await screenshots('connected');
        if (interactive) {
            const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
            for await (const line of input) {
                const [action, a, b] = line.trim().split(/\s+/);
                if (action === 'done') break;
                if (action === 'press') { await press(Number(a), Number(b)); await screenshots('input'); }
                else if (action === 'wait') { await frames(Number(a)); await screenshots('wait'); }
                else if (action === 'shot') await screenshots('manual');
                else console.log('Commands: press <player> <index>, wait <frames>, shot, done');
            }
        } else {
            // Fresh-boot navigation, US GDI v1.001. Keep screenshots of every menu so a
            // changed game build or missed input is visible instead of silently passing.
            await press(0, 7); await screenshots('two-players');
            await press(0, 0); await screenshots('profiles');
            await press(0, 0); await press(1, 0); await screenshots('mode');
            await press(0, 0); await screenshots('track');
            await press(0, 0); await screenshots('cars');
            await press(0, 0); await press(1, 0); await screenshots('loading');
            await frames(1200); await screenshots('race-start');
            await press(0, 3); await screenshots('paused');
            for (const page of pages) assert.equal(await page.evaluate(() => DC_VIEW.layout), null,
                'The pause menu must show the complete screen');
            await press(0, 0); await screenshots('resumed');
            await frames(raceFrames); await screenshots('race-end');
            // US v1.001: six car records, stride 0x808; world position at RAM 0x14cde0.
            // Both players are left without throttle, but can creep along the road. The
            // elevated circuit bounds reject menu/BIOS values and original Marina.
            const cars = await host.evaluate(() => {
                const M = EJS_emulator.gameManager.Module, base = M._wasm_get_ram_base() / 4;
                return [0, 1].map((slot) => Array.from(M.HEAPF32.slice(
                    base + (0x14cde0 + slot * 0x808) / 4,
                    base + (0x14cde0 + slot * 0x808) / 4 + 3)));
            });
            fs.writeFileSync(path.join(output, 'race-positions.json'), JSON.stringify(cars, null, 2));
            for (const [x, y, z] of cars) {
                assert.ok([x, y, z].every(Number.isFinite), 'Both cars must have finite coordinates');
                if (new URL(site).searchParams.get('track') === 'original') continue;
                assert.ok(x > -1450 && x < 1450 && y > 500 && y < 950 && z > -1200 && z < 900,
                    'Both cars must be on the elevated custom circuit, not in a menu or original track');
            }
            for (const page of pages) assert.equal(await page.evaluate(() => DC_VIEW.layout), 'halves',
                'Both clients must detect the two-player race layout');
        }
        const results = await Promise.all(pages.map((p) => p.evaluate(() => ({ fingerprint: DC_TRACK.fingerprint,
            epoch: DC_NET.epoch, frame: DC_NET.frame, desyncs: DC_NET.desyncs.length, session: DC_NET.session,
            slot: DC_NET.mySlot, active: DC_NET.active, status: document.getElementById('net-status').textContent,
            hostHashes: Array.from(DC_NET.myHashes), viewLayout: window.DC_VIEW?.layout,
            resolutions: window.__onlineResolutions || [],
            peers: Array.from(DC_NET.conns.values()).map((c) => ({ slot: c.slot, accepted: c.accepted, route: c.route, rtt: c.rtt })) }))));
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
        for (const r of results) {
            assert.equal(r.session, true); assert.equal(r.epoch, epoch, 'No automatic resync may hide a divergence');
            assert.equal(r.desyncs, 0, 'No state hash may differ'); assert.deepEqual(r.active, [0, 1]);
            if (hardwarePath) assert.ok(r.resolutions.includes('1280x960'),
                'The test must actually exercise the resolution change that used to freeze joining');
        }
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('PASS: two real clients stayed in sync. Inspect the race screenshots to confirm scene and layout.');
    } finally {
        for (let i = 0; i < logs.length; i++) fs.writeFileSync(path.join(output, 'p' + (i + 1) + '.log'), logs[i].join('\n'));
        await browser?.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
