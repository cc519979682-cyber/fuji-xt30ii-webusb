// Minimal USB/PTP transport for this local X-T30 II recipe editor.
// Packet layout follows ISO 15740 PTP; Fuji recipe property IDs are documented
// in ATTRIBUTION.md. This implementation is original and has no dependencies.

export const FUJI_VENDOR_ID = 0x04cb;
export const PTP_OK = 0x2001;
const TYPE_COMMAND = 1;
const TYPE_DATA = 2;
const TYPE_RESPONSE = 3;
const USB_TIMEOUT_MS = 8000;

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超过 8 秒；请断开后重新连接相机`)), USB_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

export class PTPError extends Error {
  constructor(operation, response) {
    super(`${operation} 被相机拒绝 (PTP 0x${response.toString(16).toUpperCase()})`);
    this.name = "PTPError";
    this.response = response;
  }
}

function container(type, code, transaction, extra = new Uint8Array()) {
  const bytes = new Uint8Array(12 + extra.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length, true);
  view.setUint16(4, type, true);
  view.setUint16(6, code, true);
  view.setUint32(8, transaction, true);
  bytes.set(extra, 12);
  return bytes;
}

function commandParams(params) {
  const bytes = new Uint8Array(params.length * 4);
  const view = new DataView(bytes.buffer);
  params.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return bytes;
}

function parseContainer(bytes) {
  if (bytes.length < 12) throw new Error("USB 返回了不完整的 PTP 数据");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== bytes.length) throw new Error("PTP 数据长度不一致");
  return {
    type: view.getUint16(4, true),
    code: view.getUint16(6, true),
    transaction: view.getUint32(8, true),
    payload: bytes.slice(12),
  };
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }
  need(length) {
    if (this.offset + length > this.bytes.length) throw new Error("相机信息数据不完整");
  }
  u8() { this.need(1); return this.view.getUint8(this.offset++); }
  u16() { this.need(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  str() {
    const count = this.u8();
    this.need(count * 2);
    let value = "";
    for (let i = 0; i < count; i++) {
      const unit = this.u16();
      if (unit !== 0) value += String.fromCharCode(unit);
    }
    return value;
  }
  u16Array() {
    const count = this.u32();
    if (count > 4096) throw new Error("相机属性列表异常");
    const values = [];
    for (let i = 0; i < count; i++) values.push(this.u16());
    return values;
  }
}

export function decodePTPString(bytes) {
  const reader = new Reader(bytes);
  const value = reader.str();
  if (reader.offset !== bytes.length) throw new Error("自定义档名称格式异常");
  return value;
}

export function encodePTPString(value) {
  const chars = Array.from(value);
  if (chars.some((char) => char.codePointAt(0) > 0xffff)) throw new Error("名称含不支持的字符");
  if (chars.length > 254) throw new Error("名称太长");
  const bytes = new Uint8Array(1 + (chars.length + 1) * 2);
  bytes[0] = chars.length + 1;
  const view = new DataView(bytes.buffer);
  chars.forEach((char, index) => view.setUint16(1 + index * 2, char.charCodeAt(0), true));
  return bytes;
}

export function readInteger(bytes, signed = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 2) return signed ? view.getInt16(0, true) : view.getUint16(0, true);
  if (bytes.length === 4) return signed ? view.getInt32(0, true) : view.getUint32(0, true);
  throw new Error(`无法识别的属性宽度：${bytes.length} 字节`);
}

export function encodeInteger(value, width, signed = false) {
  if (!Number.isInteger(value) || ![2, 4].includes(width)) throw new Error("属性数值或长度无效");
  const bytes = new Uint8Array(width);
  const view = new DataView(bytes.buffer);
  if (width === 2) {
    if (signed) view.setInt16(0, value, true);
    else view.setUint16(0, value, true);
  } else if (signed) view.setInt32(0, value, true);
  else view.setUint32(0, value, true);
  return bytes;
}

export class PTPTransport {
  constructor() {
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.transaction = -1; // OpenSession uses PTP transaction ID 0.
    this.pendingBytes = new Uint8Array();
    this.sessionOpen = false;
  }

  async connect() {
    if (!navigator.usb) throw new Error("请用 Chrome 或 Edge 打开本地网页；当前浏览器不支持 WebUSB");
    // Keep the picker inside the original click gesture.
    this.device = await navigator.usb.requestDevice({ filters: [{ vendorId: FUJI_VENDOR_ID }] });
    try {
      await this.device.open();
      if (!this.device.configuration) {
        const first = this.device.configurations[0];
        if (!first) throw new Error("相机没有 USB 配置");
        await this.device.selectConfiguration(first.configurationValue);
      }
      let chosen = null;
      for (const iface of this.device.configuration.interfaces) {
        for (const alternate of iface.alternates) {
          if (alternate.interfaceClass !== 6) continue;
          const endpointIn = alternate.endpoints.find((ep) => ep.type === "bulk" && ep.direction === "in");
          const endpointOut = alternate.endpoints.find((ep) => ep.type === "bulk" && ep.direction === "out");
          if (endpointIn && endpointOut) {
            chosen = { iface, alternate, endpointIn, endpointOut };
            break;
          }
        }
        if (chosen) break;
      }
      if (!chosen) throw new Error("相机未处于 USB RAW转换/备份恢复模式，找不到 PTP 接口");
      this.interfaceNumber = chosen.iface.interfaceNumber;
      try { await this.device.claimInterface(this.interfaceNumber); }
      catch { throw new Error("相机 USB 接口被占用。请退出 X RAW STUDIO、照片和图像捕捉，再试一次"); }
      if (chosen.iface.alternate?.alternateSetting !== chosen.alternate.alternateSetting) {
        await this.device.selectAlternateInterface(this.interfaceNumber, chosen.alternate.alternateSetting);
      }
      this.endpointIn = chosen.endpointIn.endpointNumber;
      this.endpointOut = chosen.endpointOut.endpointNumber;
      const opened = await this.exchange(0x1002, [1]);
      if (opened.response === 0x201e) {
        await this.exchange(0x1003);
        const retry = await this.exchange(0x1002, [1]);
        if (retry.response !== PTP_OK) throw new PTPError("打开会话", retry.response);
      } else if (opened.response !== PTP_OK) {
        throw new PTPError("打开会话", opened.response);
      }
      this.sessionOpen = true;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    const device = this.device;
    if (!device) return;
    if (this.sessionOpen && device.opened) {
      try { await this.exchange(0x1003); } catch { /* cable may be gone */ }
    }
    this.sessionOpen = false;
    try { if (this.interfaceNumber !== null && device.opened) await device.releaseInterface(this.interfaceNumber); } catch { /* ignore */ }
    try { if (device.opened) await device.close(); } catch { /* ignore */ }
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.pendingBytes = new Uint8Array();
  }

  async exchange(operation, params = [], outgoing = null) {
    if (!this.device?.opened || this.endpointIn === null || this.endpointOut === null) throw new Error("相机未连接");
    const tx = ++this.transaction;
    await this.write(container(TYPE_COMMAND, operation, tx, commandParams(params)));
    if (outgoing !== null) await this.write(container(TYPE_DATA, operation, tx, outgoing));
    const first = await this.readContainer();
    if (first.transaction !== tx) throw new Error("PTP 事务编号不匹配");
    let response = first;
    let data = new Uint8Array();
    if (first.type === TYPE_DATA) {
      if (first.code !== operation) throw new Error("PTP 数据操作码不匹配");
      data = first.payload;
      response = await this.readContainer();
      if (response.transaction !== tx) throw new Error("PTP 响应事务编号不匹配");
    }
    if (response.type !== TYPE_RESPONSE) throw new Error("相机未返回 PTP 响应");
    return { response: response.code, data };
  }

  async write(bytes) {
    const result = await bounded(this.device.transferOut(this.endpointOut, bytes), "USB 写入");
    if (result.status !== "ok" || result.bytesWritten !== bytes.length) throw new Error("USB 写入不完整");
  }

  async readContainer() {
    while (this.pendingBytes.length < 12) await this.readMore();
    const view = new DataView(this.pendingBytes.buffer, this.pendingBytes.byteOffset, this.pendingBytes.byteLength);
    const length = view.getUint32(0, true);
    if (length < 12 || length > 2 * 1024 * 1024) throw new Error("PTP 数据包长度异常");
    while (this.pendingBytes.length < length) await this.readMore();
    const packet = this.pendingBytes.slice(0, length);
    this.pendingBytes = this.pendingBytes.slice(length);
    return parseContainer(packet);
  }

  async readMore() {
    const result = await bounded(this.device.transferIn(this.endpointIn, 16 * 1024), "USB 读取");
    if (result.status !== "ok" || !result.data || result.data.byteLength === 0) throw new Error("USB 读取失败");
    const incoming = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    const combined = new Uint8Array(this.pendingBytes.length + incoming.length);
    combined.set(this.pendingBytes);
    combined.set(incoming, this.pendingBytes.length);
    this.pendingBytes = combined;
  }

  async deviceInfo() {
    const result = await this.exchange(0x1001);
    if (result.response !== PTP_OK) throw new PTPError("读取设备信息", result.response);
    const reader = new Reader(result.data);
    reader.u16(); reader.u32(); reader.u16(); reader.str(); reader.u16();
    const operations = reader.u16Array();
    reader.u16Array();
    const properties = reader.u16Array();
    reader.u16Array(); reader.u16Array();
    const manufacturer = reader.str();
    const model = reader.str();
    const version = reader.str();
    const serial = reader.str();
    return { manufacturer, model, version, serial, operations, properties };
  }

  async getProperty(code) {
    const result = await this.exchange(0x1015, [code]);
    if (result.response !== PTP_OK) throw new PTPError(`读取属性 0x${code.toString(16)}`, result.response);
    return result.data;
  }

  async setProperty(code, value) {
    const result = await this.exchange(0x1016, [code], value);
    if (result.response !== PTP_OK) throw new PTPError(`写入属性 0x${code.toString(16)}`, result.response);
  }
}
