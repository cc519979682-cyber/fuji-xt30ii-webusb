import { decodePTPString, encodePTPString, encodeInteger, readInteger } from "./ptp.js";

export const SLOT_CURSOR = 0xd18c;
export const SLOT_NAME = 0xd18d;
export const SLOT_FIRST = 0xd18e;
export const SLOT_LAST = 0xd1a4; // 0xD1A5 is live shooting state, never a custom-slot field.

export const FIELD = Object.freeze({
  dynamicRange: 0xd190,
  priority: 0xd191,
  film: 0xd192,
  monoWarmCool: 0xd193,
  monoMagentaGreen: 0xd194,
  grain: 0xd195,
  chrome: 0xd196,
  blueChrome: 0xd197,
  whiteBalance: 0xd199,
  whiteBalanceRed: 0xd19a,
  whiteBalanceBlue: 0xd19b,
  kelvin: 0xd19c,
  highlight: 0xd19d,
  shadow: 0xd19e,
  color: 0xd19f,
  sharpness: 0xd1a0,
  highIsoNR: 0xd1a1,
  clarity: 0xd1a2,
});

export const FILMS = Object.freeze([
  [1, "PROVIA / 标准"], [2, "Velvia / 鲜艳"], [3, "ASTIA / 柔和"],
  [4, "PRO Neg. Hi"], [5, "PRO Neg. Std"],
  [6, "黑白 / 标准"], [7, "黑白 / 黄滤镜"], [8, "黑白 / 红滤镜"], [9, "黑白 / 绿滤镜"],
  [10, "棕褐色"], [11, "Classic Chrome / 经典正片"],
  [12, "ACROS / 标准"], [13, "ACROS / 黄滤镜"], [14, "ACROS / 红滤镜"], [15, "ACROS / 绿滤镜"],
  [16, "ETERNA / 电影"], [17, "Classic Neg. / 经典负片"], [18, "ETERNA Bleach Bypass / 漂白效果"],
]);

export const WHITE_BALANCES = Object.freeze([
  [2, "自动"], [0x8020, "自动 · 白色优先"], [0x8021, "自动 · 氛围优先"],
  [4, "日光"], [0x8006, "阴天"], [6, "白炽灯"],
  [0x8001, "荧光灯 1"], [0x8002, "荧光灯 2"], [0x8003, "荧光灯 3"],
  [0x8007, "色温 K"], [8, "水下"],
  [0x8008, "自定义 1"], [0x8009, "自定义 2"], [0x800a, "自定义 3"],
]);

export const EFFECTS = Object.freeze([[1, "关闭"], [2, "弱"], [3, "强"]]);
export const GRAINS = Object.freeze([[1, "关闭"], [2, "弱 · 小颗粒"], [3, "强 · 小颗粒"], [4, "弱 · 大颗粒"], [5, "强 · 大颗粒"]]);
export const DYNAMIC_RANGES = Object.freeze([[0xffff, "自动"], [100, "DR100"], [200, "DR200"], [400, "DR400"]]);
export const PRIORITIES = Object.freeze([[0, "关闭"], [0x8000, "自动"], [1, "弱"], [2, "强"]]);
const NR_WIRE_TO_VALUE = Object.freeze({ 0x8000: -4, 0x7000: -3, 0x4000: -2, 0x3000: -1, 0x2000: 0, 0x1000: 1, 0: 2, 0x6000: 3, 0x5000: 4 });
const NR_VALUE_TO_WIRE = Object.freeze({ "-4": 0x8000, "-3": 0x7000, "-2": 0x4000, "-1": 0x3000, "0": 0x2000, "1": 0x1000, "2": 0, "3": 0x6000, "4": 0x5000 });

export const LABELS = Object.freeze({
  dynamicRange: "动态范围", priority: "动态范围优先", film: "胶片模拟", monoWarmCool: "黑白冷暖", monoMagentaGreen: "黑白洋红/绿色",
  grain: "颗粒", chrome: "色彩效果", blueChrome: "蓝色彩效果", whiteBalance: "白平衡", whiteBalanceRed: "白平衡 R",
  whiteBalanceBlue: "白平衡 B", kelvin: "色温", highlight: "高光", shadow: "阴影", color: "色彩",
  sharpness: "锐度", highIsoNR: "高 ISO 降噪", clarity: "清晰度",
});

const MONO_FILMS = new Set([6, 7, 8, 9, 10, 12, 13, 14, 15]);
const KNOWN_ENUMS = Object.freeze({
  dynamicRange: new Set(DYNAMIC_RANGES.map(([value]) => value)),
  priority: new Set(PRIORITIES.map(([value]) => value)),
  film: new Set(FILMS.map(([value]) => value)),
  grain: new Set([1, 2, 3, 4, 5, 6, 7]),
  chrome: new Set(EFFECTS.map(([value]) => value)),
  blueChrome: new Set(EFFECTS.map(([value]) => value)),
  whiteBalance: new Set(WHITE_BALANCES.map(([value]) => value)),
});

export const REQUIRED_CODES = Object.freeze([SLOT_CURSOR, SLOT_NAME, ...Object.values(FIELD)]);

export function validateSlotName(value) {
  if (typeof value !== "string") throw new Error("C 档名称格式无效");
  if (value.length > 25) throw new Error("C 档名称最多 25 个字符");
  if (!/^[A-Za-z0-9 _-]*$/.test(value)) throw new Error("C 档名称仅支持英文字母、数字、空格、- 和 _");
  if (value && value !== value.trim()) throw new Error("C 档名称首尾不能有空格");
  return value;
}

export function isMonochrome(film) { return MONO_FILMS.has(Number(film)); }

function numeric(raw, code, signed = false) {
  const bytes = raw.get(code);
  if (!bytes) throw new Error(`缺少属性 0x${code.toString(16).toUpperCase()}`);
  return readInteger(bytes, signed);
}

function inRange(value, minimum, maximum, step, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum || Math.abs((value - minimum) / step - Math.round((value - minimum) / step)) > 0.0001) {
    throw new Error(`${label} 的相机返回值无法映射：${value}`);
  }
  return value;
}

export function decodeRecipe(raw) {
  const recipe = {};
  for (const [key, code] of Object.entries(FIELD)) {
    const signed = ["monoWarmCool", "monoMagentaGreen", "whiteBalanceRed", "whiteBalanceBlue", "highlight", "shadow", "color", "sharpness", "clarity"].includes(key);
    recipe[key] = numeric(raw, code, signed);
  }
  for (const [key, allowed] of Object.entries(KNOWN_ENUMS)) {
    if (!allowed.has(recipe[key])) throw new Error(`${LABELS[key]} 的相机返回值无法映射：${recipe[key]}`);
  }
  if ([6, 7].includes(recipe.grain)) recipe.grain = 1; // Fuji retains last grain size when effect is off.
  const nr = NR_WIRE_TO_VALUE[recipe.highIsoNR & 0xffff];
  if (nr === undefined) throw new Error(`高 ISO 降噪的相机返回值无法映射：${recipe.highIsoNR}`);
  recipe.highIsoNR = nr;
  for (const key of ["monoWarmCool", "monoMagentaGreen", "highlight", "shadow", "color", "sharpness", "clarity"]) recipe[key] /= 10;
  inRange(recipe.whiteBalanceRed, -9, 9, 1, "白平衡 R");
  inRange(recipe.whiteBalanceBlue, -9, 9, 1, "白平衡 B");
  if (recipe.priority === 0) {
    inRange(recipe.highlight, -2, 4, 1, "高光");
    inRange(recipe.shadow, -2, 4, 1, "阴影");
  }
  inRange(recipe.sharpness, -4, 4, 1, "锐度");
  inRange(recipe.clarity, -5, 5, 1, "清晰度");
  if (!isMonochrome(recipe.film)) {
    inRange(recipe.color, -4, 4, 1, "色彩");
  } else if (!Number.isFinite(recipe.color) || recipe.color < -3276 || recipe.color > 3276) {
    throw new Error("黑白档中色彩属性格式异常");
  }
  if (isMonochrome(recipe.film)) {
    inRange(recipe.monoWarmCool, -9, 9, 1, "黑白冷暖");
    inRange(recipe.monoMagentaGreen, -9, 9, 1, "黑白洋红/绿色");
  }
  if (recipe.whiteBalance === 0x8007) inRange(recipe.kelvin, 2500, 10000, 10, "色温");
  return recipe;
}

export function validateDraft(recipe) {
  const problems = [];
  const enumCheck = (key, allowed) => { if (!allowed.has(Number(recipe[key]))) problems.push(`${LABELS[key]} 无效`); };
  for (const [key, allowed] of Object.entries(KNOWN_ENUMS)) enumCheck(key, allowed);
  const check = (key, min, max, step) => {
    try { inRange(Number(recipe[key]), min, max, step, LABELS[key]); } catch (error) { problems.push(error.message); }
  };
  check("whiteBalanceRed", -9, 9, 1); check("whiteBalanceBlue", -9, 9, 1);
  if (Number(recipe.priority) === 0) { check("highlight", -2, 4, 1); check("shadow", -2, 4, 1); }
  if (!isMonochrome(recipe.film)) check("color", -4, 4, 1);
  check("sharpness", -4, 4, 1); check("highIsoNR", -4, 4, 1); check("clarity", -5, 5, 1);
  if (isMonochrome(recipe.film)) { check("monoWarmCool", -9, 9, 1); check("monoMagentaGreen", -9, 9, 1); }
  if (Number(recipe.whiteBalance) === 0x8007) check("kelvin", 2500, 10000, 10);
  return problems;
}

function encodeField(key, value, originalWidth) {
  let wire = Number(value);
  if (["monoWarmCool", "monoMagentaGreen", "highlight", "shadow", "color", "sharpness", "clarity"].includes(key)) wire = Math.round(wire * 10);
  if (key === "highIsoNR") wire = NR_VALUE_TO_WIRE[String(value)];
  const signed = ["monoWarmCool", "monoMagentaGreen", "whiteBalanceRed", "whiteBalanceBlue", "highlight", "shadow", "color", "sharpness", "clarity"].includes(key);
  // X-T30 II reports D191 as two bytes, while Fuji's custom-slot write
  // protocol uses an int32 for D-Range Priority (as documented for X-S10).
  if (key === "priority") return encodeInteger(wire, 4, true);
  return encodeInteger(wire, originalWidth, signed);
}

// Changed fields only. Preserve all unmapped camera properties in the destination slot.
export function buildWritePlan(before, after, raw, beforeName = "", afterName = beforeName, nameRaw = null, originalEmptyNameRaw = null) {
  const errors = validateDraft(after);
  if (errors.length) throw new Error(errors.join("；"));
  const mono = isMonochrome(after.film);
  const forceStyle = before.film !== after.film;
  const order = ["film", "priority", "dynamicRange", "grain", "chrome", "blueChrome", "whiteBalance", "kelvin", "whiteBalanceRed", "whiteBalanceBlue", "highlight", "shadow", "color", "sharpness", "highIsoNR", "clarity", "monoWarmCool", "monoMagentaGreen"];
  const plan = [];
  for (const key of order) {
    if (key === "dynamicRange" && Number(after.priority) !== 0) continue;
    if (["highlight", "shadow"].includes(key) && Number(after.priority) !== 0) continue;
    if (["chrome", "blueChrome", "color"].includes(key) && mono) continue;
    if (["monoWarmCool", "monoMagentaGreen"].includes(key) && !mono) continue;
    if (key === "kelvin" && Number(after.whiteBalance) !== 0x8007) continue;
    const changed = Number(before[key]) !== Number(after[key]);
    const wbModeChanged = before.whiteBalance !== after.whiteBalance;
    const priorityChanged = before.priority !== after.priority;
    const monoZeroAlready = ["monoWarmCool", "monoMagentaGreen"].includes(key) && Number(before[key]) === 0 && Number(after[key]) === 0;
    const dependent = (forceStyle && !monoZeroAlready)
      || (key === "kelvin" && wbModeChanged)
      || (["whiteBalanceRed", "whiteBalanceBlue"].includes(key) && (wbModeChanged || before.kelvin !== after.kelvin))
      || (["dynamicRange", "highlight", "shadow"].includes(key) && priorityChanged);
    if (!changed && !dependent) continue;
    const code = FIELD[key];
    const original = raw.get(code);
    if (!original || ![2, 4].includes(original.length)) throw new Error(`${LABELS[key]} 缺少可写入的原始属性`);
    plan.push({ key, code, label: LABELS[key], value: Number(after[key]), bytes: encodeField(key, after[key], original.length) });
  }
  if (beforeName !== afterName) {
    if (plan.length) throw new Error("改名可能使相机重建 C 档。请先只写名称，重新读取并备份后再调整配方");
    validateSlotName(afterName);
    if (!nameRaw || decodePTPString(nameRaw) !== beforeName) throw new Error("C 档原始名称与快照不一致");
    let bytes = encodePTPString(afterName);
    // If this session first read an empty name, preserve its exact wire form
    // when the user clears a newly assigned name again.
    if (afterName === "" && originalEmptyNameRaw) {
      if (decodePTPString(originalEmptyNameRaw) !== "") throw new Error("原始空名称格式异常");
      bytes = originalEmptyNameRaw.slice();
    }
    plan.push({ key: "name", code: SLOT_NAME, label: afterName ? `C 档名称「${afterName}」` : "C 档名称（清空）", value: afterName, bytes });
  }
  return plan;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}

export function unexpectedPropertyChanges(before, after, plan) {
  if (before.raw.size !== after.raw.size) throw new Error("回读的 C 档属性数量变化，无法验证写入结果");
  const plannedCodes = new Set(plan.map((entry) => entry.code));
  const fieldNames = new Map(Object.entries(FIELD).map(([key, code]) => [code, LABELS[key]]));
  const changes = [];
  for (const [code, original] of before.raw) {
    if (plannedCodes.has(code)) continue;
    if (!equalBytes(original, after.raw.get(code))) {
      changes.push(fieldNames.get(code) || `0x${code.toString(16).toUpperCase()}`);
    }
  }
  return changes;
}

export function bytesToHex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("备份中有无效十六进制数据");
  return Uint8Array.from(hex.match(/../g)?.map((part) => parseInt(part, 16)) ?? []);
}

export async function selectSlot(camera, slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 7) throw new Error("目标 C 档不正确");
  await camera.setProperty(SLOT_CURSOR, encodeInteger(slot, 2));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export async function readSlot(camera, slot, supported) {
  await selectSlot(camera, slot);
  const nameRaw = await camera.getProperty(SLOT_NAME);
  const name = decodePTPString(nameRaw);
  const raw = new Map();
  for (let code = SLOT_FIRST; code <= SLOT_LAST; code++) {
    if (supported.has(code)) raw.set(code, await camera.getProperty(code));
  }
  return { slot, name, nameRaw, raw, recipe: decodeRecipe(raw) };
}

export async function readAllSlots(camera, supported, onProgress = () => {}) {
  const originalCursor = await camera.getProperty(SLOT_CURSOR);
  if (originalCursor.length !== 2) throw new Error("相机 C 档选择器格式异常");
  const slots = [];
  let mainError = null;
  try {
    for (let slot = 1; slot <= 7; slot++) {
      onProgress(slot);
      slots.push(await readSlot(camera, slot, supported));
    }
  } catch (error) {
    mainError = error;
  } finally {
    try {
      await camera.setProperty(SLOT_CURSOR, originalCursor);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (restoreError) {
      if (!mainError) mainError = new Error(`已读取 C 档，但无法恢复相机原来的档位选择：${restoreError.message}`);
    }
  }
  if (mainError) throw mainError;
  return slots;
}

export function backupObject(deviceInfo, slots) {
  return {
    format: "fuji-mini-backup-v1",
    createdAt: new Date().toISOString(),
    camera: { model: deviceInfo.model, firmware: deviceInfo.version, serial: deviceInfo.serial },
    slots: slots.map((slot) => ({
      slot: slot.slot,
      name: slot.name,
      nameRaw: bytesToHex(slot.nameRaw),
      properties: Object.fromEntries([...slot.raw].map(([code, bytes]) => [`0x${code.toString(16).toUpperCase()}`, bytesToHex(bytes)])),
      mappedRecipe: slot.recipe,
    })),
  };
}
