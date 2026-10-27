// Run: node --test tools/tests/webgl-compat.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function context() {
    class GL {
        constructor() { this.errors = []; this.calls = []; }
        get INVALID_ENUM() { return 0x500; }
        getError() { return this.errors.shift() || 0; }
        getParameter(cap) {
            if (cap === 0xb71) return true;
            this.errors.push(this.INVALID_ENUM); return null;
        }
        enable(cap) {
            this.calls.push(["enable", cap]);
            if (cap !== 0xb71) this.errors.push(this.INVALID_ENUM);
        }
        disable(cap) {
            this.calls.push(["disable", cap]);
            if (cap !== 0xb71) this.errors.push(this.INVALID_ENUM);
        }
    }
    const c = vm.createContext({ WebGL2RenderingContext: GL,
        EJS_GameManager: class {}, EmulatorJS: class {}, console: { log() {} } });
    c.window = c;
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../ejs/data/src/dc-patches.js"), "utf8"), c);
    return new GL();
}

test("Flycast fixed-index restart toggles cannot poison the next video initialization", () => {
    const gl = context();
    for (let frame = 0; frame < 100; frame++) {
        gl.enable(0x8d69);
        assert.equal(gl.getParameter(0xb71), true);
        gl.disable(0x8d69);
    }
    assert.equal(gl.getError(), 0, "RetroArch must not see a stale INVALID_ENUM on resolution change");
    assert.deepEqual(gl.calls, []);
    gl.enable(0xb71); gl.disable(0xb71);
    assert.deepEqual(gl.calls, [["enable", 0xb71], ["disable", 0xb71]]);
});

test("unrelated GL errors survive parameter probes and remain isolated to their context", () => {
    const first = context();
    first.enable(0xdead);
    assert.equal(first.getParameter(0xb71), true);
    assert.equal(first.getError(), first.INVALID_ENUM);
    assert.equal(first.getError(), 0);
    first.errors.push(0x501);
    first.getParameter(0xbeef); // only this unsupported parameter probe is absorbed
    assert.equal(first.getError(), 0x501);
    assert.equal(first.getError(), 0);
    const second = new first.constructor();
    first.disable(0xdead);
    first.getParameter(0xb71);
    assert.equal(second.getError(), 0);
    assert.equal(first.getError(), first.INVALID_ENUM);
});
