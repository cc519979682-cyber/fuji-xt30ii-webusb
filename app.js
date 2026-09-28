import { PTPTransport, decodePTPString } from "./ptp.js";
import { createPreview } from "./preview.js";
import { reconcileRecipe, recipeMismatches, collateralMismatches } from "./staged-write.js";
import {
  SLOT_CURSOR, SLOT_NAME, SLOT_FIRST, SLOT_LAST,
  FILMS, WHITE_BALANCES, EFFECTS, GRAINS, DYNAMIC_RANGES, PRIORITIES,
  isMonochrome, readAllSlots, readSlot, buildWritePlan, backupObject, equalBytes, decodeRecipe, unexpectedPropertyChanges, validateDraft,
} from "./recipe.js";

const $ = (id) => document.getElementById(id);
const controls = {
  film: $("film"), dynamicRange: $("dynamicRange"), priority: $("priority"),
  whiteBalance: $("whiteBalance"), kelvin: $("kelvin"), grain: $("grain"),
  chrome: $("chrome"), blueChrome: $("blueChrome"),
};
const sliders = [
  ["whiteBalanceRed", "白平衡 R", -9, 9, 1], ["whiteBalanceBlue", "白平衡 B", -9, 9, 1],
  ["highlight", "高光", -2, 4, 1], ["shadow", "阴影", -2, 4, 1],
  ["color", "色彩", -4, 4, 1], ["sharpness", "锐度", -4, 4, 1],
  ["highIsoNR", "高 ISO 降噪", -4, 4, 1], ["clarity", "清晰度", -5, 5, 1],
  ["monoWarmCool", "黑白冷暖", -9, 9, 1], ["monoMagentaGreen", "黑白洋红/绿色", -9, 9, 1],
];

let camera = null;
let deviceInfo = null;
let supported = new Set();
let slots = [];
let draft = null;
let initialEmptyNameRaw = new Map();
let backupDone = false;
let busy = false;
const updatePreview = createPreview();

function fillSelect(control, choices) {
  control.replaceChildren(...choices.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    return option;
  }));
}

fillSelect(controls.film, FILMS);
fillSelect(controls.dynamicRange, DYNAMIC_RANGES);
fillSelect(controls.priority, PRIORITIES);
fillSelect(controls.whiteBalance, WHITE_BALANCES);
fillSelect(controls.grain, GRAINS);
fillSelect(controls.chrome, EFFECTS);
fillSelect(controls.blueChrome, EFFECTS);

for (const [key, label, min, max, step] of sliders) {
  const wrapper = document.createElement("label");
  wrapper.className = `slider-field ${["color"].includes(key) ? "color-only" : ""} ${key.startsWith("mono") ? "mono-only" : ""}`;
  wrapper.innerHTML = `<div class="slider-top"><span>${label}</span><output id="${key}Output">0</output></div><input type="range" name="${key}" id="${key}" min="${min}" max="${max}" step="${step}" value="0"><div class="slider-limits"><span>${min}</span><span>${max > 0 ? `+${max}` : max}</span></div>`;
  $("sliders").append(wrapper);
  controls[key] = $(key);
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${message}`;
  $("log").prepend(item);
  while ($("log").children.length > 12) $("log").lastElementChild.remove();
}

function status(message, kind = "") {
  $("status").textContent = message;
  $("status").className = kind;
  log(message);
}

function selectedSlot() {
  return slots.find((slot) => slot.slot === Number($("targetSlot").value)) ?? null;
}

function normalizeDraft(recipe) {
  const value = { ...recipe };
  if (!Number.isFinite(value.color) || value.color < -4 || value.color > 4) value.color = 0;
  for (const key of ["monoWarmCool", "monoMagentaGreen"]) {
    if (!Number.isFinite(value[key]) || value[key] < -9 || value[key] > 9) value[key] = 0;
  }
  for (const key of ["highlight", "shadow"]) {
    if (!Number.isFinite(value[key]) || value[key] < -2 || value[key] > 4) value[key] = 0;
  }
  if (!Number.isFinite(value.kelvin) || value.kelvin < 2500 || value.kelvin > 10000) value.kelvin = 5500;
  return value;
}

function setSlotChoice(slot) {
  draft = slot ? normalizeDraft(slot.recipe) : null;
  $("slotName").textContent = slot ? `相机现有名称：${slot.name || "未命名"}` : "未选择档位";
  $("newSlotName").value = slot?.name ?? "";
  if (draft) {
    for (const [key, control] of Object.entries(controls)) control.value = String(draft[key]);
  }
  $("confirmOverwrite").checked = false;
  update();
}

function updateDependencies() {
  const active = Boolean(draft) && !busy;
  const priorityUsbBlocked = deviceInfo?.version === "2.04";
  const mono = active && isMonochrome(draft.film);
  const priority = active && Number(draft.priority) !== 0;
  const kelvin = active && Number(draft.whiteBalance) === 0x8007;
  controls.kelvin.disabled = !kelvin;
  controls.priority.disabled = !active || priorityUsbBlocked;
  for (const key of ["dynamicRange", "highlight", "shadow"]) controls[key].disabled = !active || priority;
  for (const key of ["chrome", "blueChrome", "color"]) controls[key].disabled = !active || mono;
  for (const key of ["monoWarmCool", "monoMagentaGreen"]) controls[key].disabled = !active || !mono;
  for (const node of document.querySelectorAll(".slider-field")) {
    node.classList.toggle("disabled", node.querySelector("input")?.disabled || false);
  }
  const hints = [];
  if (priority) hints.push("动态范围优先开启时，相机自动控制动态范围、高光和阴影。");
  if (mono) hints.push("黑白胶片模拟下，色彩与色彩效果不可调整，可使用黑白冷暖和洋红/绿色。");
  if (!kelvin) hints.push("色温只在白平衡选择「色温 K」时生效。");
  if (priorityUsbBlocked) hints.push("这台机身固件 2.04 拒绝通过 USB 修改动态范围优先；需要改动时请在相机菜单操作，再重新读取。");
  $("dependencyNote").textContent = active ? (hints.join(" ") || "设置会保存到你选定的 C 档。") : "选择一个 C 档后显示可调整的参数。";
}

function pendingPlan() {
  const slot = selectedSlot();
  if (!slot || !draft) return [];
  if (deviceInfo?.version === "2.04" && Number(slot.recipe.priority) !== Number(draft.priority)) {
    throw new Error("这台机身固件 2.04 拒绝通过 USB 修改动态范围优先；请在相机菜单修改后重新读取");
  }
  const plan = buildWritePlan(slot.recipe, draft, slot.raw, slot.name, $("newSlotName").value,
    slot.nameRaw, initialEmptyNameRaw.get(slot.slot))
    .filter((entry) => entry.code === SLOT_NAME || Number(slot.recipe[entry.key]) !== Number(draft[entry.key]));
  if (plan.some((entry) => entry.code === SLOT_NAME) && plan.length > 1) {
    throw new Error("改名与配方需分两次写入：先仅改名称，重新读取并备份，再调整配方");
  }
  return plan;
}

function refreshSlotLabels() {
  const selected = $("targetSlot").value;
  const selector = $("targetSlot");
  selector.replaceChildren(new Option("请选择要覆盖的 C 档", ""));
  for (const slot of slots) selector.add(new Option(`C${slot.slot} · ${slot.name || "未命名"}`, String(slot.slot)));
  selector.value = selected;
  $("slotOverview").replaceChildren(...slots.map((slot) => {
    const item = document.createElement("div");
    item.className = "slot-mini";
    const title = document.createElement("strong"); title.textContent = `C${slot.slot}`;
    const name = document.createElement("span"); name.textContent = slot.name || "未命名";
    item.append(title, name);
    return item;
  }));
}

function update() {
  const connected = Boolean(camera);
  const read = slots.length === 7;
  const slot = selectedSlot();
  $("connectionBadge").textContent = connected ? `● 已连接 · ${deviceInfo?.model ?? "FUJIFILM"}` : "● 未连接";
  $("connectionBadge").classList.toggle("online", connected);
  $("connectButton").disabled = connected || busy;
  $("scanButton").disabled = !connected || busy;
  $("backupButton").disabled = !read || busy;
  $("disconnectButton").disabled = !connected || busy;
  $("targetSlot").disabled = !read || busy;
  $("recipeFields").disabled = !slot || busy;
  $("newSlotName").disabled = !slot || busy;
  $("presetSoftPortrait").disabled = !slot || slot.slot !== 1 || busy;
  $("confirmOverwrite").disabled = !slot || !backupDone || busy;
  for (const [key] of sliders) {
    const value = Number(controls[key].value);
    $(`${key}Output`).textContent = `${value > 0 ? "+" : ""}${value}`;
  }
  updateDependencies();
  let plan = [];
  let error = "";
  try { plan = pendingPlan(); } catch (problem) { error = problem.message; }
  const nameOnly = plan.length === 1 && plan[0].code === SLOT_NAME;
  $("confirmLabel").textContent = slot
    ? (nameOnly
      ? `我已保存备份，并知晓改名可能用当前拍摄设置重建 C${slot.slot} 的配方`
      : `我已保存备份，并确认覆盖 C${slot.slot}${slot.name ? `「${slot.name}」` : ""}`)
    : "我已保存备份，并确认覆盖所选 C 档";
  $("writeButton").textContent = nameOnly ? "先写名称并核对" : "写入所选 C 档";
  if (error) $("changeSummary").textContent = `当前设置无法写入：${error}`;
  else if (!slot) $("changeSummary").textContent = "暂无待写入的变更。";
  else if (!plan.length) $("changeSummary").textContent = "当前参数与相机中的设置相同。";
  else {
    $("changeSummary").replaceChildren();
    const title = document.createElement("strong");
    title.textContent = nameOnly ? "将写入名称：" : `当前有 ${plan.length} 项差异：`;
    $("changeSummary").append(title, document.createTextNode(plan.map((entry) => entry.label).join("、")));
    if (nameOnly) $("changeSummary").append(document.createElement("br"),
      document.createTextNode("注意：实机曾在改名时把该档配方改成当前拍摄设置。写后会核对全部属性；随后请重新读取并备份，再调整配方。"));
    else $("changeSummary").append(document.createElement("br"),
      document.createTextNode("写入时会逐项回读；相机若自动更改参数，实际写入项数可能增加。"));
  }
  $("writeButton").disabled = !connected || !read || !slot || !backupDone || !$("confirmOverwrite").checked || !plan.length || Boolean(error) || busy;
  updatePreview(draft);
}

function clearReadState() {
  slots = [];
  draft = null;
  initialEmptyNameRaw = new Map();
  backupDone = false;
  $("targetSlot").replaceChildren(new Option("读取后选择", ""));
  $("slotOverview").replaceChildren();
  $("slotName").textContent = "未选择档位";
  $("newSlotName").value = "";
  $("confirmOverwrite").checked = false;
  update();
}

function cameraModelOK(model) {
  return model.toUpperCase().replace(/[^A-Z0-9]/g, "") === "XT30II";
}

async function connect() {
  busy = true; update();
  status("正在请求浏览器连接相机…");
  const candidate = new PTPTransport();
  try {
    await candidate.connect();
    const info = await candidate.deviceInfo();
    if (!cameraModelOK(info.model)) throw new Error(`检测到 ${info.model}。这个简易面板只允许写入 X-T30 II。`);
    // X-T30 II V2.04 reports an empty DevicePropertiesSupported list, even
    // though its private C-slot properties are readable. Probe actual reads.
    const cursor = await candidate.getProperty(SLOT_CURSOR);
    if (cursor.length !== 2) throw new Error("C 档选择器长度异常；已停止，避免误写");
    decodePTPString(await candidate.getProperty(SLOT_NAME));
    const raw = new Map();
    const properties = new Set([SLOT_CURSOR, SLOT_NAME]);
    for (let code = SLOT_FIRST; code <= SLOT_LAST; code++) {
      const bytes = await candidate.getProperty(code);
      if (bytes.length !== 2 && bytes.length !== 4) throw new Error(`属性 0x${code.toString(16).toUpperCase()} 的长度异常；已停止，避免误写`);
      raw.set(code, bytes);
      properties.add(code);
    }
    decodeRecipe(raw); // Refuse writes unless all editable values map cleanly.
    camera = candidate;
    deviceInfo = info;
    supported = properties;
    $("deviceLine").textContent = `${info.model} · 固件 ${info.version || "未知"} · C 档属性已逐项读取验证`;
    status("相机已连接。下一步读取 C1–C7。", "success");
  } catch (error) {
    await candidate.disconnect();
    status(`连接失败：${error.message}`, "error");
  } finally {
    busy = false; update();
  }
}

async function disconnect() {
  busy = true; update();
  const old = camera;
  camera = null;
  try { await old?.disconnect(); } catch { /* best effort */ }
  deviceInfo = null;
  supported = new Set();
  clearReadState();
  $("deviceLine").textContent = "尚未连接相机。";
  busy = false; update();
  status("已断开相机。", "success");
}

async function scan() {
  busy = true; clearReadState(); update();
  status("正在读取全部 7 个 C 档；这一步不会改动胶片配方。", "");
  try {
    slots = await readAllSlots(camera, supported, (index) => status(`正在读取 C${index} / C7…`));
    initialEmptyNameRaw = new Map(slots.filter((slot) => slot.name === "")
      .map((slot) => [slot.slot, slot.nameRaw.slice()]));
    refreshSlotLabels();
    status("C1–C7 已读取并完成参数映射。请先下载备份。", "success");
  } catch (error) {
    slots = [];
    status(`读取失败：${error.message}。写入功能保持锁定。`, "error");
  } finally {
    busy = false; update();
  }
}

function saveBackup() {
  if (slots.length !== 7 || !deviceInfo) return;
  const backup = backupObject(deviceInfo, slots);
  const contents = JSON.stringify(backup, null, 2);
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `XT30II-C1-C7-backup-${now}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  backupDone = true;
  $("confirmOverwrite").checked = false;
  status("已生成 C1–C7 的 JSON 备份下载。请确认浏览器已保存文件。", "success");
  update();
}

function snapshotSame(a, b) {
  if (a.name !== b.name || !equalBytes(a.nameRaw, b.nameRaw)) return false;
  if (a.raw.size !== b.raw.size) return false;
  for (const [code, bytes] of a.raw) if (!equalBytes(bytes, b.raw.get(code))) return false;
  return true;
}

async function applySoftPortrait() {
  const slot = selectedSlot();
  if (!slot || slot.slot !== 1 || busy) return;
  try {
    const response = await fetch("./C1-Soft-Portrait-target.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`无法读取示例文件（HTTP ${response.status}）`);
    const preset = await response.json();
    if (selectedSlot()?.slot !== 1 || busy) return;
    if (preset.slot !== "C1" || !preset.recipe || typeof preset.recipe !== "object") {
      throw new Error("示例文件格式不正确");
    }
    const recipe = { ...slot.recipe, ...preset.recipe };
    const errors = validateDraft(recipe);
    if (errors.length) throw new Error(errors.join("；"));
    draft = { ...recipe };
    for (const [key, control] of Object.entries(controls)) control.value = String(draft[key]);
    $("confirmOverwrite").checked = false;
    update();
    status("已载入 C1「柔和人像」示例，请检查参数、下载当前备份后再决定是否写入。", "success");
  } catch (error) { status(`载入示例失败：${error.message}`, "error"); }
}

async function writeSelectedSlot() {
  const slot = selectedSlot();
  if (!slot || !camera || !backupDone || !$("confirmOverwrite").checked) return;
  let plan;
  try { plan = pendingPlan(); } catch (error) { status(error.message, "error"); return; }
  if (!plan.length) return;
  const targetRecipe = { ...draft };
  const nameOnly = plan.length === 1 && plan[0].code === SLOT_NAME;
  busy = true; update();
  let originalCursor = null;
  let wrote = 0;
  let attemptedWrite = false;
  try {
    originalCursor = await camera.getProperty(SLOT_CURSOR);
    if (originalCursor.length !== 2) throw new Error("无法记录当前 C 档选择器；已取消写入");
    status(`正在重新核对 C${slot.slot}，确认相机设置没有变化…`);
    const live = await readSlot(camera, slot.slot, supported);
    if (!snapshotSame(slot, live)) throw new Error(`C${slot.slot} 的相机设置在读取备份后发生变化。已取消写入，请重新读取并备份。`);
    const info = await camera.deviceInfo();
    if (!cameraModelOK(info.model) || info.version !== deviceInfo.version || info.serial !== deviceInfo.serial) {
      throw new Error("连接的相机序列号或固件已变化，写入已取消");
    }
    let after;
    const mismatches = [];
    if (nameOnly) {
      const entry = plan[0];
      status(`正在写入 C${slot.slot}：${entry.label}`);
      attemptedWrite = true;
      await camera.setProperty(entry.code, entry.bytes);
      wrote++;
      after = await readSlot(camera, slot.slot, supported);
      if (!equalBytes(after.nameRaw, entry.bytes)) mismatches.push("C 档名称：原始 PTP 字符串回读与目标不一致");
      const unexpected = unexpectedPropertyChanges(slot, after, plan);
      if (unexpected.length) mismatches.push(`相机还改变了 ${unexpected.length} 项未请求的属性：${unexpected.join("、")}`);
    } else {
      const result = await reconcileRecipe(camera, supported, slot.slot, targetRecipe, {
        originalSlot: slot,
        beforeWrite(entry, pass) {
          status(`正在写入 C${slot.slot}：${entry.label}（第 ${pass} 轮；每项写后立即回读）`);
          attemptedWrite = true;
        },
        afterWrite() { wrote++; },
      });
      after = result.after;
      for (const key of recipeMismatches(after.recipe, targetRecipe)) mismatches.push(`${key} 与目标值不一致`);
      const collateral = collateralMismatches(slot, after);
      if (collateral.length) mismatches.push(`相机还改变了名称或未映射属性：${collateral.join("、")}`);
    }
    if (mismatches.length) throw new Error(`写入后的回读不一致：${mismatches.join("；")}`);
    slots = slots.map((value) => value.slot === slot.slot ? after : value);
    draft = normalizeDraft(after.recipe);
    $("newSlotName").value = after.name;
    $("slotName").textContent = `相机现有名称：${after.name || "未命名"}`;
    refreshSlotLabels();
    backupDone = false;
    $("confirmOverwrite").checked = false;
    status(nameOnly
      ? `C${slot.slot} 名称已写入，原始名称与全部配方属性回读核对通过。继续调整配方前请重新下载备份。`
      : `C${slot.slot} 已写入，目标配方、名称及未映射属性回读核对通过。继续写其他档位前请重新下载备份。`, "success");
  } catch (problem) {
    clearReadState(); // The old snapshot is no longer safe for another write or backup.
    status(`写入中止：${problem.message}${attemptedWrite ? `。已尝试写入，其中 ${wrote} 项收到相机成功响应；最终 C 档状态未通过完整核对。请保留原备份并重新读取相机。` : "。未开始写入；请重新读取相机。"}`, "error");
  } finally {
    if (originalCursor) {
      try { await camera.setProperty(SLOT_CURSOR, originalCursor); }
      catch (restoreError) {
        clearReadState();
        status(`无法恢复原来的 C 档选择器：${restoreError.message}。请检查相机后重新读取。`, "error");
      }
    }
    busy = false;
    update();
  }
}

for (const [key, control] of Object.entries(controls)) {
  control.addEventListener("input", () => {
    if (!draft) return;
    draft[key] = Number(control.value);
    $("confirmOverwrite").checked = false;
    update();
  });
}

$("targetSlot").addEventListener("change", () => setSlotChoice(selectedSlot()));
$("newSlotName").addEventListener("input", () => {
  $("confirmOverwrite").checked = false;
  update();
});
$("confirmOverwrite").addEventListener("change", update);
$("connectButton").addEventListener("click", connect);
$("scanButton").addEventListener("click", scan);
$("backupButton").addEventListener("click", saveBackup);
$("presetSoftPortrait").addEventListener("click", applySoftPortrait);
$("disconnectButton").addEventListener("click", disconnect);
$("writeButton").addEventListener("click", writeSelectedSlot);

if (navigator.usb) {
  navigator.usb.addEventListener("disconnect", (event) => {
    if (camera?.device === event.device) {
      if (busy) status("USB 连接中断，当前操作将失败；请重新连接后读取相机。", "error");
      else disconnect();
    }
  });
}
update();
