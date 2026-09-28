import { readInteger } from "./ptp.js";
import {
  SLOT_CURSOR, FIELD, LABELS, isMonochrome, readSlot, buildWritePlan, validateDraft,
  equalBytes, unexpectedPropertyChanges,
} from "./recipe.js";

// Write controls before the values they may reset. Every decision below is made
// from a fresh camera read, because Fuji may change other fields after a write.
export const WRITE_ORDER = Object.freeze([
  "film", "priority", "whiteBalance", "dynamicRange", "kelvin",
  "whiteBalanceRed", "whiteBalanceBlue", "grain", "chrome", "blueChrome",
  "highlight", "shadow", "color", "sharpness", "highIsoNR", "clarity",
  "monoWarmCool", "monoMagentaGreen",
]);

function active(key, target) {
  if (["dynamicRange", "highlight", "shadow"].includes(key) && Number(target.priority) !== 0) return false;
  if (["chrome", "blueChrome", "color"].includes(key) && isMonochrome(target.film)) return false;
  if (["monoWarmCool", "monoMagentaGreen"].includes(key) && !isMonochrome(target.film)) return false;
  if (key === "kelvin" && Number(target.whiteBalance) !== 0x8007) return false;
  return true;
}

export function recipeMismatches(current, target) {
  return WRITE_ORDER.filter((key) => active(key, target)
    && Number(current[key]) !== Number(target[key]));
}

export function collateralMismatches(before, after) {
  const changes = [];
  if (!equalBytes(before.nameRaw, after.nameRaw)) changes.push("C 档名称");
  const mappedCodes = Object.values(FIELD).map((code) => ({ code }));
  changes.push(...unexpectedPropertyChanges(before, after, mappedCodes));
  return changes;
}

async function assertSelectedSlot(camera, slot) {
  const cursor = await camera.getProperty(SLOT_CURSOR);
  if (cursor.length !== 2 || readInteger(cursor) !== slot) {
    throw new Error(`相机 C 档选择器不再指向 C${slot}，已停止写入`);
  }
}

function nextEntry(live, target, key) {
  // buildWritePlan supplies the device's observed byte width and encoding.
  // Ignore its film/WB dependency expansion when the live value already matches.
  return buildWritePlan(live.recipe, target, live.raw, live.name, live.name, live.nameRaw)
    .find((entry) => entry.key === key && Number(live.recipe[key]) !== Number(target[key]));
}

export async function reconcileRecipe(camera, supported, slot, target, options = {}) {
  const errors = validateDraft(target);
  if (errors.length) throw new Error(errors.join("；"));
  if (!Number.isInteger(slot) || slot < 1 || slot > 7) throw new Error("目标 C 档不正确");
  let live = await readSlot(camera, slot, supported);
  const assertNoCollateral = () => {
    if (!options.originalSlot) return;
    const changes = collateralMismatches(options.originalSlot, live);
    if (changes.length) throw new Error(`相机额外改动了名称或未映射属性：${changes.join("、")}；已停止写入`);
  };
  assertNoCollateral();
  let writes = 0;

  for (let pass = 1; pass <= 2; pass++) {
    for (const key of WRITE_ORDER) {
      if (!active(key, target) || Number(live.recipe[key]) === Number(target[key])) continue;
      const entry = nextEntry(live, target, key);
      if (!entry || entry.code !== FIELD[key]) throw new Error(`${LABELS[key]} 无法安全编码，已停止写入`);
      await assertSelectedSlot(camera, slot);
      await options.beforeWrite?.(entry, pass, writes);
      await camera.setProperty(entry.code, entry.bytes);
      writes++;
      await options.afterWrite?.(entry, pass, writes);
      live = await readSlot(camera, slot, supported);
      assertNoCollateral();
      if (Number(live.recipe[key]) !== Number(target[key])) {
        // Some bodies settle after the successful PTP response. Retry only the read.
        await new Promise((resolve) => setTimeout(resolve, 200));
        live = await readSlot(camera, slot, supported);
        assertNoCollateral();
      }
      if (Number(live.recipe[key]) !== Number(target[key])) {
        throw new Error(`${LABELS[key]} 写入后回读不一致：目标 ${target[key]}，实际 ${live.recipe[key]}`);
      }
    }
    live = await readSlot(camera, slot, supported);
    assertNoCollateral();
    if (recipeMismatches(live.recipe, target).length === 0) return { after: live, writes };
  }

  const remaining = recipeMismatches(live.recipe, target).map((key) => LABELS[key]);
  throw new Error(`相机参数未能稳定保存：${remaining.join("、")}`);
}
