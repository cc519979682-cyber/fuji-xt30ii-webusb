import test from "node:test";
import assert from "node:assert/strict";
import { encodeInteger, encodePTPString, readInteger } from "../ptp.js";
import { SLOT_CURSOR, SLOT_NAME, SLOT_FIRST, SLOT_LAST, FIELD, decodeRecipe, readSlot } from "../recipe.js";
import { reconcileRecipe, recipeMismatches } from "../staged-write.js";

const u16 = (value, signed = false) => encodeInteger(value, 2, signed);

function makeCamera({ resetOnFilm = false, refuseFilm = false, alterNameOnFilm = false, alterUnknownOnFilm = false, initialPriority = 0 } = {}) {
  const raw = new Map();
  for (let code = SLOT_FIRST; code <= SLOT_LAST; code++) raw.set(code, u16(0));
  for (const [key, value] of Object.entries({
    dynamicRange: 100, priority: initialPriority, film: 1, monoWarmCool: 0,
    monoMagentaGreen: 0, grain: 6, chrome: 1, blueChrome: 1,
    whiteBalance: 2, whiteBalanceRed: 0, whiteBalanceBlue: 0,
    kelvin: 5500, highlight: 0, shadow: 0, color: 0,
    sharpness: 0, highIsoNR: 0x2000, clarity: 0,
  })) raw.set(FIELD[key], u16(value));
  const writes = [];
  const payloads = [];
  let cursor = 7;
  let name = "C1";
  const camera = {
    async getProperty(code) {
      if (code === SLOT_CURSOR) return u16(cursor);
      if (code === SLOT_NAME) return encodePTPString(name);
      if (code === FIELD.priority) return raw.get(code).slice(0, 2);
      return raw.get(code)?.slice() ?? u16(0);
    },
    async setProperty(code, bytes) {
      if (code === SLOT_CURSOR) { cursor = readInteger(bytes); return; }
      writes.push(code);
      payloads.push({ code, bytes: bytes.slice() });
      if (code === FIELD.priority && bytes.length !== 4) throw new Error("mock D191 requires int32 write");
      if (code === FIELD.film && refuseFilm) return;
      raw.set(code, code === FIELD.priority ? bytes.slice(0, 2) : bytes.slice());
      if (code === FIELD.film && resetOnFilm) {
        raw.set(FIELD.priority, u16(2));
        raw.set(FIELD.whiteBalance, u16(4));
        raw.set(FIELD.grain, u16(3));
        raw.set(FIELD.color, u16(20));
        raw.set(FIELD.chrome, u16(2));
      }
      if (code === FIELD.film && alterNameOnFilm) name = "Changed";
      if (code === FIELD.film && alterUnknownOnFilm) raw.set(SLOT_FIRST, u16(5));
      if (code === FIELD.priority) {
        raw.set(FIELD.dynamicRange, u16(100));
        raw.set(FIELD.highlight, u16(0));
        raw.set(FIELD.shadow, u16(0));
      }
      if (code === FIELD.whiteBalance) {
        raw.set(FIELD.kelvin, u16(5500));
        raw.set(FIELD.whiteBalanceRed, u16(0));
        raw.set(FIELD.whiteBalanceBlue, u16(0));
      }
      if (code === FIELD.kelvin) {
        raw.set(FIELD.whiteBalanceRed, u16(0));
        raw.set(FIELD.whiteBalanceBlue, u16(0));
      }
    },
  };
  const supported = new Set([SLOT_CURSOR, SLOT_NAME, ...raw.keys()]);
  return { camera, supported, writes, payloads, baseline: decodeRecipe(raw) };
}

test("ASTIA-only change writes only film when camera leaves other values intact", async () => {
  const { camera, supported, writes, baseline } = makeCamera();
  const target = { ...baseline, film: 3 };
  const { after, writes: count } = await reconcileRecipe(camera, supported, 1, target);
  assert.deepEqual(writes, [FIELD.film]);
  assert.equal(count, 1);
  assert.deepEqual(recipeMismatches(after.recipe, target), []);
});

test("D191 reads as two bytes but writes Off as four-byte little-endian int", async () => {
  const { camera, supported, writes, payloads, baseline } = makeCamera({ initialPriority: 0x8000 });
  assert.equal((await camera.getProperty(FIELD.priority)).length, 2);
  const target = { ...baseline, priority: 0 };
  const { after } = await reconcileRecipe(camera, supported, 1, target);
  assert.equal(after.recipe.priority, 0);
  assert.deepEqual(writes, [FIELD.priority]);
  assert.deepEqual(Array.from(payloads[0].bytes), [0, 0, 0, 0]);
});

test("film, priority, and Kelvin white balance resets are repaired from fresh reads", async () => {
  const { camera, supported, writes, baseline } = makeCamera({ resetOnFilm: true });
  const target = {
    ...baseline, film: 3, priority: 0, dynamicRange: 200,
    whiteBalance: 0x8007, kelvin: 6100, whiteBalanceRed: 2,
    whiteBalanceBlue: -1, highlight: 1, shadow: -1, color: 1,
  };
  const { after } = await reconcileRecipe(camera, supported, 1, target);
  assert.deepEqual(recipeMismatches(after.recipe, target), []);
  assert.deepEqual(writes.slice(0, 3), [FIELD.film, FIELD.priority, FIELD.whiteBalance]);
  assert.ok(writes.indexOf(FIELD.kelvin) < writes.indexOf(FIELD.whiteBalanceRed));
  assert.ok(writes.indexOf(FIELD.kelvin) < writes.indexOf(FIELD.whiteBalanceBlue));
  assert.equal(writes.filter((code) => code === FIELD.film).length, 1);
});

test("a successful transport response with wrong film readback stops after one attempt", async () => {
  const { camera, supported, writes, baseline } = makeCamera({ refuseFilm: true });
  await assert.rejects(reconcileRecipe(camera, supported, 1, { ...baseline, film: 3 }), /胶片模拟 写入后回读不一致/);
  assert.deepEqual(writes, [FIELD.film]);
});

test("a film write that changes the slot name stops before more recipe writes", async () => {
  const { camera, supported, writes, baseline } = makeCamera({ alterNameOnFilm: true });
  const originalSlot = await readSlot(camera, 1, supported);
  await assert.rejects(reconcileRecipe(camera, supported, 1, { ...baseline, film: 3 }, { originalSlot }), /C 档名称/);
  assert.deepEqual(writes, [FIELD.film]);
});

test("a film write that changes an unmapped property stops before more recipe writes", async () => {
  const { camera, supported, writes, baseline } = makeCamera({ alterUnknownOnFilm: true });
  const originalSlot = await readSlot(camera, 1, supported);
  await assert.rejects(reconcileRecipe(camera, supported, 1, { ...baseline, film: 3 }, { originalSlot }), /0xD18E/);
  assert.deepEqual(writes, [FIELD.film]);
});
