// Background orchestrator: bridges popup/options UI, the native host, and
// chrome.proxy for THIS browser profile.
//
// MV3 service workers are terminated after ~30s idle, which also tears down the
// native port (and thus sing-box). To keep the proxy reliably ON we persist the
// user's INTENT (`desired`) and reconcile reality to it:
//   - a keepalive alarm pings the host (keeps the worker alive) and re-establishes
//     everything if the worker/host died;
//   - a stable inbound port means chrome.proxy rarely needs re-pointing;
//   - if the host dies we keep the proxy pointed at it (fail-closed) rather than
//     leaking traffic directly, then heal on the next reconcile.

import {
  STORAGE_KEYS,
  PROXY_MODE,
  KEEPALIVE_ALARM,
  KEEPALIVE_PERIOD_MIN,
} from "../common/constants.js";
import { native, onEvent, disconnect } from "../lib/native.js";
import * as proxy from "../lib/proxy.js";
import { setStatusIcon, pulseConnecting } from "../lib/badge.js";
import { getProfile, getActiveProfileId, getRouting } from "../lib/profiles.js";

// Only logs + lastError are truly volatile; running state lives in storage.
const state = { logs: [], lastError: null };
const MAX_LOGS = 200;

// --- desired (persisted intent) --------------------------------------------
async function getDesired() {
  const d = await chrome.storage.local.get(STORAGE_KEYS.DESIRED);
  return d[STORAGE_KEYS.DESIRED] || { on: false, profileId: null, port: 0 };
}
// Every intent change bumps this. A reconcile pass captures it at the start and
// refuses to apply its decision if it changed underneath — otherwise a pass that
// began while the proxy was wanted ON finishes by re-applying chrome.proxy after
// the user already turned it OFF (or vice versa).
let intentEpoch = 0;

async function setDesired(patch) {
  const next = { ...(await getDesired()), ...patch };
  // Only an actual change of intent invalidates in-flight work; recording the
  // negotiated port must not abort the pass that just negotiated it.
  if ("on" in patch || "profileId" in patch) intentEpoch++;
  await chrome.storage.local.set({ [STORAGE_KEYS.DESIRED]: next });
  return next;
}

async function persistRuntime(running, port) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.RUNTIME]: { running, port: port || null, lastError: state.lastError },
  });
}

// --- toolbar status ---------------------------------------------------------
function setBadge(running, error = false) {
  const state = error ? "error" : running ? "on" : "off";
  // Fire and forget: the icon is cosmetic and must never block a state change.
  setStatusIcon(state).catch(() => {});
  try {
    chrome.action.setTitle({
      title: error
        ? "MagicProxy — ошибка, откройте расширение"
        : running
          ? "MagicProxy — включено"
          : "MagicProxy — выключено",
    });
  } catch (_) {
    /* action API not ready during early startup */
  }
}

function pushLog(line, level = "info") {
  state.logs.push({ ts: Date.now(), level, line });
  if (state.logs.length > MAX_LOGS) state.logs.shift();
}

// --- keepalive --------------------------------------------------------------
function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
}
function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// --- apply chrome.proxy for the running port --------------------------------
async function applyProxyFor(port) {
  const routing = await getRouting();
  const mode = routing.mode === PROXY_MODE.RULES ? PROXY_MODE.RULES : PROXY_MODE.ALL;
  await proxy.apply({
    mode,
    host: "127.0.0.1",
    port,
    rules: {
      proxyDomains: routing.proxyDomains || [],
      directDomains: routing.directDomains || [],
    },
    bypass: routing.bypass || [],
  });
}

// Start the host + sing-box for a profile on the desired (stable) port.
// Returns the actual port bound (may differ if the desired one was taken).
async function startCore(profile, desiredPort) {
  const routing = await getRouting();
  const result = await native.start({
    profile,
    inbound: { listen: "127.0.0.1", port: desiredPort || 0 },
    routing: {
      final: routing.final,
      rules: routing.rules,
      remoteDns: routing.remoteDns || "",
    },
    // "info" makes sing-box log ~3 lines per TCP connection, each carrying the
    // visited hostname, straight into this worker. Browsing history does not
    // belong in the extension's memory, and it is a lot of native-messaging
    // traffic for nothing.
    logLevel: "warn",
  });
  if (!result.port) throw new Error("host did not return a listen port");
  return result.port;
}

// --- reconcile reality to intent (idempotent, single-flight) ----------------
let reconciling = null;
let reconcilingEpoch = -1;

function reconcile() {
  // Single-flight ONLY while intent is unchanged. A caller that just changed the
  // intent must never be handed the promise of a pass computed for the old one —
  // that made enable() report success for work it never caused.
  if (reconciling && reconcilingEpoch === intentEpoch) return reconciling;
  const startEpoch = intentEpoch;
  const run = reconciling
    ? reconciling.catch(() => {}).then(() => doReconcile(startEpoch))
    : doReconcile(startEpoch);
  reconciling = run.finally(() => {
    if (reconciling === run) reconciling = null;
  });
  reconcilingEpoch = startEpoch;
  return reconciling;
}

// Every background caller of reconcile() used to swallow failures with an empty
// .catch(), so a persistent failure left the badge green and lastError null —
// the user was told they were protected while nothing worked. Record it instead.
function reconcileInBackground() {
  return reconcile().catch(async (e) => {
    state.lastError = e.message;
    setBadge(false, true);
    const d = await getDesired();
    await persistRuntime(false, d.port);
  });
}

async function doReconcile(startEpoch = intentEpoch) {
  // Abort before touching chrome.proxy, the badge or the alarm if the user changed
  // their mind while we were inside a 30 s native.start().
  const superseded = () => intentEpoch !== startEpoch;

  const desired = await getDesired();

  if (!desired.on) {
    await proxy.clear();
    stopKeepalive();
    setBadge(false);
    await persistRuntime(false, null);
    return { running: false };
  }

  const profile = await getProfile(desired.profileId);
  if (!profile) {
    // Unrecoverable, not transient: retrying forever would pin the profile to a
    // dead port with no way out from the UI. Stand down cleanly instead.
    await proxy.clear();
    stopKeepalive();
    await setDesired({ on: false });
    state.lastError = "профиль удалён — прокси выключен";
    setBadge(false, true);
    await persistRuntime(false, null);
    return { running: false };
  }

  // Is the core already running (same worker + host session)?
  let status = null;
  try {
    status = await native.status();
  } catch (_) {
    status = null;
  }

  let port;
  if (status && status.running && status.port) {
    port = status.port;
  } else {
    port = await startCore(profile, desired.port);
  }
  if (superseded()) return { running: false, superseded: true };
  if (port !== desired.port) await setDesired({ port });

  await applyProxyFor(port);
  if (superseded()) {
    // Intent flipped while we were applying. Undo rather than leave the browser
    // pointed at a proxy the user just switched off.
    await proxy.clear();
    return { running: false, superseded: true };
  }
  startKeepalive();
  setBadge(true);
  state.lastError = null;
  await persistRuntime(true, port);
  return { running: true, port };
}

// --- public actions ---------------------------------------------------------
export async function enable(profileId) {
  const id = profileId || (await getActiveProfileId());
  if (!id) throw new Error("не выбран профиль");
  state.lastError = null;
  await setDesired({ on: true, profileId: id });
  try {
    const r = await reconcile();
    // "Connecting" pulse, started only after the tunnel is actually up so it never
    // implies success that did not happen. Not awaited: it is purely cosmetic and
    // must not delay the popup's response.
    pulseConnecting("on").catch(() => {});
    return { port: r.port, profileId: id };
  } catch (e) {
    state.lastError = e.message;
    setBadge(false, true);
    await persistRuntime(false, null);
    throw e;
  }
}

export async function disable() {
  await setDesired({ on: false });
  stopKeepalive();
  // A reconcile started before this click read desired.on === true and can still
  // be inside native.start() (up to 30 s). Let it finish before we tear down,
  // otherwise it re-applies chrome.proxy afterwards and the proxy the user just
  // switched off comes back on.
  if (reconciling) {
    try {
      await reconciling;
    } catch (_) {
      /* its failure is not ours to report */
    }
  }
  // A superseded pass may have re-armed the alarm before noticing; clear it again
  // now that nothing else is in flight.
  stopKeepalive();
  await proxy.clear();
  try {
    await native.stop();
  } catch (e) {
    console.warn("[sw] stop failed:", e.message);
  }
  disconnect();
  state.lastError = null;
  setBadge(false);
  await persistRuntime(false, null);
  return { ok: true };
}

async function getState() {
  const desired = await getDesired();
  let running = false;
  let port = desired.port;
  if (desired.on) {
    try {
      const s = await native.status();
      running = !!(s && s.running);
      if (s && s.port) port = s.port;
    } catch (_) {
      running = false;
    }
    // A live core is not the same as a live tunnel. levelOfControl is verified in
    // apply(), which only runs during a reconcile — so between reconciles another
    // extension can seize the proxy and the popup would keep printing "Активно".
    if (running) {
      try {
        const lvl = (await chrome.proxy.settings.get({})).levelOfControl;
        if (lvl !== "controlled_by_this_extension") {
          running = false;
          state.lastError = new proxy.ProxyControlError(lvl).message;
        }
      } catch (_) {
        /* if we cannot read it, leave the host's answer alone */
      }
    }
    // Opening the popup while intended-on but not actually running heals it.
    if (!running) reconcileInBackground();
  }
  return {
    on: desired.on,
    running,
    healing: desired.on && !running,
    port,
    activeProfileId: desired.profileId,
    lastError: state.lastError,
  };
}

// --- host events ------------------------------------------------------------
onEvent(async (evt) => {
  if (evt.event === "log") {
    pushLog(evt.payload.line, evt.payload.level);
  } else if (evt.event === "state") {
    // sing-box reported it stopped. If the user still wants it on, leave the
    // proxy in place (fail-closed) and let the next reconcile restart it.
    if (evt.payload && evt.payload.running === false) {
      const desired = await getDesired();
      if (desired.on) {
        setBadge(false, true);
        await persistRuntime(false, desired.port);
      }
    }
  } else if (evt.event === "disconnected") {
    const desired = await getDesired();
    if (desired.on) {
      // Host/worker connection lost. Keep the proxy pointed at the stable port
      // (don't leak direct); the keepalive alarm will restart the host.
      setBadge(false, true);
      await persistRuntime(false, desired.port);
    }
  }
});

// --- message router for popup/options ---------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.cmd) {
        case "enable":
          sendResponse({ ok: true, data: await enable(msg.profileId) });
          break;
        case "disable":
          sendResponse({ ok: true, data: await disable() });
          break;
        case "state":
          sendResponse({ ok: true, data: await getState() });
          break;
        case "logs":
          sendResponse({ ok: true, data: state.logs });
          break;
        case "hostVersion":
          sendResponse({ ok: true, data: await native.version() });
          break;
        case "test":
          sendResponse({ ok: true, data: await native.test(msg.profile) });
          break;
        case "checkUpdate":
          sendResponse({ ok: true, data: await native.checkUpdate() });
          break;
        case "updateCore":
          if ((await getDesired()).on) await disable();
          sendResponse({ ok: true, data: await native.updateCore() });
          break;
        default:
          sendResponse({ ok: false, error: `unknown cmd: ${msg?.cmd}` });
      }
    } catch (e) {
      state.lastError = e.message;
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

// --- lifecycle --------------------------------------------------------------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) reconcileInBackground();
});

// Browser start: restore the proxy if it was intended on (auto-reconnect),
// otherwise make sure it's cleared.
chrome.runtime.onStartup.addListener(() => {
  reconcileInBackground();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  reconcileInBackground();
  if (details.reason !== "install") return;
  // ALWAYS onboard. This used to be gated on the host being unreachable, which
  // meant the most likely order — run the installer first, then add the extension —
  // produced no onboarding at all: no prompt to pin the toolbar icon, no way to add
  // a first server, no confirmation that anything had worked. The page itself
  // decides what to show; see onboarding.js probe().
  chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/onboarding.html") });
});

// Every time the worker spins up: reflect state and self-heal if needed.
(async () => {
  const desired = await getDesired();
  setBadge(desired.on);
  reconcileInBackground();
})();
