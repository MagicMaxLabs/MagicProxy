// Native Messaging client: request/response over a long-lived port to the Go host.
//
// Chrome launches the host process on connectNative() and terminates it when the
// port disconnects. We keep the port alive while a proxy is active and reconnect
// lazily on demand.

import { NATIVE_HOST_NAME } from "../common/constants.js";

let port = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }
const eventListeners = new Set(); // (event) => void

function nextId() {
  seq += 1;
  return `req-${Date.now()}-${seq}`;
}

function handleMessage(msg) {
  if (msg && msg.event) {
    for (const fn of eventListeners) {
      try {
        fn(msg);
      } catch (e) {
        console.error("[native] event listener error", e);
      }
    }
    return;
  }
  const entry = msg && msg.id ? pending.get(msg.id) : null;
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.result ?? {});
  else entry.reject(new Error(msg.error || "native host error"));
}

function handleDisconnect() {
  const err = chrome.runtime.lastError;
  const reason = err ? err.message : "disconnected";
  console.warn("[native] host disconnected:", reason);
  port = null;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`native host disconnected: ${reason}`));
  }
  pending.clear();
  for (const fn of eventListeners) {
    try {
      fn({ event: "disconnected", payload: { reason } });
    } catch (_) {
      /* ignore */
    }
  }
}

export function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);
  return port;
}

export function disconnect() {
  if (port) {
    try {
      port.disconnect();
    } catch (_) {
      /* ignore */
    }
    port = null;
  }
}

export function isConnected() {
  return port !== null;
}

export function onEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

/**
 * Send a request and await the correlated response.
 * @param {string} type
 * @param {object} payload
 * @param {number} timeoutMs
 */
export function request(type, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = connect();
    } catch (e) {
      reject(new Error(`cannot start native host: ${e.message}`));
      return;
    }
    const id = nextId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`native host timeout for "${type}"`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      p.postMessage({ id, type, payload });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`failed to post to native host: ${e.message}`));
    }
  });
}

export const native = {
  ping: () => request("ping"),
  version: () => request("version"),
  start: (payload) => request("start", payload, 30000),
  stop: () => request("stop"),
  status: () => request("status"),
  test: (profile) => request("test", { profile }, 30000),
  checkUpdate: () => request("checkUpdate", {}, 30000),
  updateCore: () => request("updateCore", {}, 120000),
};
