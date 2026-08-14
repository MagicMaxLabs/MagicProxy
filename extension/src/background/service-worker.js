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
import { setStatusIcon, pulseConnecting, pulseAlert } from "../lib/badge.js";
import {
  getProfile,
  getActiveProfileId,
  setActiveProfileId,
  getRouting,
} from "../lib/profiles.js";
import { t } from "../lib/i18n.js";

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

// coreProfileId — чей конфиг исполняет запущенное ядро. Хост это сказать не может:
// его `status` отвечает только { running, port, uptimeSec }. Помним сами и держим
// в storage, потому что воркер MV3 выгружают через ~30 с и переменная модуля не
// доживёт. Пишется ПЕРЕД запуском ядра, а не после: пасс, который успел стартовать
// ядро и был вытеснен сменой намерения, обязан оставить след, иначе следующий пасс
// примет чужое ядро за своё.
async function persistRuntime(running, port, coreProfileId = null) {
  // foreignAlerted переживает запись: он про то, предупредили ли мы уже о
  // перехвате, и к running/port отношения не имеет. Затирать его здесь значило бы
  // мигать заново на каждом проходе согласования.
  const prev = await getRuntime();
  await chrome.storage.local.set({
    [STORAGE_KEYS.RUNTIME]: {
      running,
      port: port || null,
      coreProfileId,
      foreignAlerted: !!prev.foreignAlerted,
      lastError: state.lastError,
    },
  });
}

async function getRuntime() {
  const d = await chrome.storage.local.get(STORAGE_KEYS.RUNTIME);
  return (
    d[STORAGE_KEYS.RUNTIME] || {
      running: false,
      port: null,
      coreProfileId: null,
      foreignAlerted: false,
    }
  );
}

/**
 * Перехват прокси чужим расширением: помигать точкой в углу иконки.
 *
 * Мигаем ТОЛЬКО на переходе. Попап опрашивает состояние раз в 2 секунды, а
 * будильник согласования — раз в 30; повторять сигнал, пока перехват держится,
 * значило бы дёргать иконку без конца. Флаг лежит в storage, потому что воркер
 * MV3 выгружают и переменная модуля до следующего опроса не доживёт.
 *
 * @param {boolean} hijacked прокси сейчас за чужим расширением
 * @param {boolean} on включён ли прокси по намерению пользователя
 */
async function noteForeignProxy(hijacked, on) {
  const rt = await getRuntime();
  if (hijacked === !!rt.foreignAlerted) return;
  await chrome.storage.local.set({
    [STORAGE_KEYS.RUNTIME]: { ...rt, foreignAlerted: hijacked },
  });
  if (!hijacked) return;
  // Перехват при включённом прокси означает, что трафик идёт НАПРЯМУЮ: наша
  // настройка не действует, а fail-closed тут недостижим — распоряжается чужое
  // расширение. Это красный. При выключенном прокси это предупреждение — янтарный.
  pulseAlert(on ? "error" : "warn", on ? "error" : "off").catch(() => {});
}

// --- toolbar status ---------------------------------------------------------
function setBadge(running, error = false) {
  const state = error ? "error" : running ? "on" : "off";
  // Fire and forget: the icon is cosmetic and must never block a state change.
  setStatusIcon(state).catch(() => {});
  try {
    chrome.action.setTitle({
      title: error ? t("titleError") : running ? t("titleOn") : t("titleOff"),
    });
  } catch (_) {
    /* action API not ready during early startup */
  }
}

// Обрыв соединения самим браузером sing-box пишет как ERROR. Для пользователя
// это не ошибка: вкладку закрыли, страница передумала грузить ресурс. Человек
// открывает «Логи ядра», видит красное слово ERROR и пугается на ровном месте —
// а заодно эти строки вытесняют из кольца на 200 записей действительно полезные.
// На state.lastError они не влияют (проверено 8 августа), поэтому просто не
// сохраняем их.
const BENIGN_CORE_LINES =
  /(connection (upload|download) closed|WSAECONNABORTED|connection reset by peer|broken pipe|use of closed network connection|context canceled)/i;

// Хост говорит по-английски (его сообщения стабильны и попадают в логи), а
// подсказку про чужой TUN-адаптер пользователь должен прочитать на своём языке —
// это единственная хостовая строка, написанная ДЛЯ человека, а не для диагноза.
const TUN_HINT_RE = /^MagicProxy: active TUN adapter detected \(([^)]*)\)/;

function pushLog(line, level = "info") {
  if (BENIGN_CORE_LINES.test(line)) return;
  const tun = TUN_HINT_RE.exec(line);
  if (tun) line = t("tunHint", [tun[1]]) || line;
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
  const applied = await proxy.apply({
    mode,
    host: "127.0.0.1",
    port,
    rules: {
      proxyDomains: routing.proxyDomains || [],
      directDomains: routing.directDomains || [],
    },
    bypass: routing.bypass || [],
  });
  // Туннель работает, а WebRTC-защиту держит кто-то другой с другой политикой —
  // редкий конфликт с другим privacy-расширением. Туннель из-за этого не рвём,
  // но молчать нельзя: реальный IP может быть виден сайтам.
  if (applied && applied.webrtcGuarded === false) {
    pushLog(t("warnWebrtcForeign"), "warn");
  }
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
  // Сравнивать надо с ТЕМ ЖЕ промисом, который лежит в reconciling. Раньше здесь
  // стояло `reconciling = run.finally(() => { if (reconciling === run) ... })`, а в
  // reconciling попадает производный промис, не run, — условие не выполнялось
  // никогда, и reconciling навсегда оставался непустым.
  //
  // Цена ошибки была велика: при неизменившемся намерении reconcile() возвращал
  // старый завершённый промис и не выполнял ничего. Будильник согласования
  // работал вхолостую, а самолечение случалось только при перезапуске воркера,
  // который обнуляет переменные модуля. Отсюда и «чужое расширение выключил, а
  // ошибка с красной точкой остались»: проход, который всё бы починил, не
  // запускался.
  const tracked = run.finally(() => {
    if (reconciling === tracked) reconciling = null;
  });
  reconciling = tracked;
  reconcilingEpoch = startEpoch;
  return tracked;
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
    // Единственная точка, где перехват виден при закрытом попапе и включённом
    // прокси: applyProxyFor() падает именно здесь.
    if (e.name === "ProxyControlError") await noteForeignProxy(true, true);
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
    state.lastError = t("errProfileDeleted");
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

  // Живое ядро, собранное под другой профиль, надо заменить, а не переиспользовать.
  // Без этой проверки смена профиля в попапе оставляла работать прежний сервер, и
  // помогал только цикл «выключить — включить»: он один действительно гасил ядро.
  // Неизвестный coreProfileId тоже считаем чужим — перезапуск дешевле, чем тихо
  // оставить пользователя на не том сервере.
  const runtime = await getRuntime();
  // Читается ДО любой записи в этом проходе: по нему видно, поднимаемся ли мы из
  // нерабочего состояния. Нужно для пульсации — мигать на каждом проходе
  // согласования, а их теперь раз в 30 секунд, было бы мучением.
  //
  // «Здоровы» — это не только running. Короткий перехват не успевает уронить ни
  // один проход, running остаётся true, а точка уже красная от пульсации тревоги;
  // без учёта foreignAlerted возврат в строй проходил бы молча.
  const wasHealthy = !!runtime.running && !state.lastError && !runtime.foreignAlerted;
  const wrongProfile = !!(
    status &&
    status.running &&
    runtime.coreProfileId !== desired.profileId
  );

  let port;
  if (status && status.running && status.port && !wrongProfile) {
    port = status.port;
  } else {
    if (wrongProfile) {
      // chrome.proxy на время подмены остаётся направленным на тот же порт: разрыв
      // получается fail-closed, а не утечкой напрямую в момент переключения.
      try {
        await native.stop();
      } catch (e) {
        console.warn("[sw] stop before profile switch failed:", e.message);
      }
      if (superseded()) return { running: false, superseded: true };
    }
    await persistRuntime(false, desired.port, desired.profileId);
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
  await persistRuntime(true, port, desired.profileId);
  // Управление у нас — значит перехват кончился, и о следующем надо предупредить
  // заново.
  await noteForeignProxy(false, true);
  // Зелёная пульсация на ПЕРЕХОДЕ в рабочее состояние — и после нажатия кнопки, и
  // после самостоятельного восстановления (чужое расширение убрали, хост ожил).
  // Раньше она жила в enable() и поэтому доставалась только ручному включению:
  // прокси возвращался сам, а пользователь этого не видел. Не ждём завершения —
  // это косметика, она не должна задерживать ответ попапу.
  if (!wasHealthy) pulseConnecting("on").catch(() => {});
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
    // Пульсация переехала в doReconcile: она нужна на любом переходе в рабочее
    // состояние, а не только на ручном включении. Условие «только после того, как
    // туннель действительно поднялся» там сохранено — она стоит после
    // applyProxyFor() и потому не может пообещать успех, которого не было.
    return { port: r.port, profileId: id };
  } catch (e) {
    state.lastError = e.message;
    setBadge(false, true);
    await persistRuntime(false, null);
    // enable() ловит ошибку сам и до обработчика reconcileInBackground() не
    // доходит — поэтому о перехвате надо сказать здесь отдельно.
    if (e.name === "ProxyControlError") await noteForeignProxy(true, true);
    throw e;
  }
}

// Смена профиля обязана дойти до НАМЕРЕНИЯ, а не только до выбора в интерфейсе.
// Активный профиль хранится в двух разных ключах: ACTIVE_PROFILE_ID читает попап,
// а цикл согласования читает desired.profileId. Попап писал только первый — отсюда
// и брался работающий прежний сервер.
export async function setProfile(profileId) {
  const id = profileId || null;
  await setActiveProfileId(id);
  const desired = await getDesired();
  // Выключённому прокси переключать нечего: профиль подхватится при включении.
  if (!desired.on || !id || desired.profileId === id) return { switched: false };
  state.lastError = null;
  await setDesired({ profileId: id });
  try {
    const r = await reconcile();
    return { switched: true, port: r.port };
  } catch (e) {
    state.lastError = e.message;
    setBadge(false, true);
    await persistRuntime(false, null);
    if (e.name === "ProxyControlError") await noteForeignProxy(true, true);
    throw e;
  }
}

export async function disable() {
  await setDesired({ on: false });
  stopKeepalive();
  // Прокси снимается ПЕРВЫМ действием, до всякого ожидания. Раньше сначала ждали
  // незавершённый проход, и пока тот сидел внутри native.start() (до 30 с) или
  // падал, профиль оставался без интернета: chrome.proxy указывал на порт, где
  // уже никто не слушает. Возврат связи не должен ждать ничего.
  await proxy.clear();
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
  // Второй раз — на случай, если добитый проход успел применить настройку заново.
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
  // Выключённое состояние проверяется на две беды сразу.
  //
  // Первая: «намерение выключено, а прокси всё ещё наш» — в нём профиль сидит без
  // интернета. Попап опрашивает состояние каждые 2 секунды, поэтому такое не
  // переживёт даже одного открытия попапа, каким бы путём ни возникло: отказом
  // clear(), гибелью воркера посреди disable() или чем-то, чего мы ещё не знаем.
  //
  // Вторая: прокси держит чужое расширение. Снять его мы не можем — Chrome не даёт
  // одному расширению трогать настройки другого, — но обязаны сказать. Иначе попап
  // пишет «Выключено», пока профиль не работает из-за чужой настройки: ровно так
  // выглядела авария 8 августа, и час ушёл на поиск виновника вручную.
  //
  // Имя виновника мы намеренно НЕ показываем: для этого нужно разрешение
  // `management`, а оно даёт список всех установленных расширений. Для прокси-
  // расширения это и лишний доступ к личным данным, и заметный минус на ревью в
  // магазине. Факта и подсказки, где искать, достаточно.
  let foreignProxy = false;
  if (!desired.on) {
    await proxy.clearIfOurs();
    foreignProxy = (await proxy.controlLevel()) === "controlled_by_other_extensions";
    await noteForeignProxy(foreignProxy, false);
  }
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
        // Перехват на ходу: прокси включён, а распоряжается им уже не наше
        // расширение. Трафик в этот момент идёт напрямую — самый тревожный из
        // возможных случаев, поэтому мигаем красным.
        await noteForeignProxy(lvl === "controlled_by_other_extensions", true);
        if (lvl !== "controlled_by_this_extension") {
          running = false;
          state.lastError = new proxy.ProxyControlError(lvl).message;
        } else if (state.lastError) {
          // Ядро живо и прокси наш — прежняя ошибка устарела. Без этой ветки попап
          // показывал бы её до следующего успешного прохода согласования, а точка
          // горела бы красным поверх работающего туннеля.
          state.lastError = null;
          setBadge(true);
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
    foreignProxy,
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
        case "setProfile":
          sendResponse({ ok: true, data: await setProfile(msg.profileId) });
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
        case "updateCore": {
          // Текст в настройках обещает «прокси будет временно выключен» — и
          // раньше это была неправда: disable() выполнялся, а обратного пути не
          // было. Включаем обратно в finally: и после успеха, и после неудачи
          // (replaceFile отбрасывает недокачанное, старое ядро остаётся на
          // месте, так что включаться безопасно в обоих случаях).
          const wasOn = (await getDesired()).on;
          if (wasOn) await disable();
          try {
            sendResponse({ ok: true, data: await native.updateCore() });
          } finally {
            if (wasOn)
              await enable().catch((e) =>
                console.warn("[sw] re-enable after core update failed:", e.message)
              );
          }
          break;
        }
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

// --- перехват прокси чужим расширением --------------------------------------

// Перехват надо замечать и при закрытом попапе. Опросом это недостижимо: когда
// прокси выключен, будильник согласования снят, и getState() выполняется только
// пока попап открыт, — поэтому раньше точка начинала мигать лишь после нажатия
// на кнопку расширения.
//
// Здесь подписка на само событие. Регистрация на верхнем уровне модуля
// обязательна: так Chrome будит выгруженный воркер MV3 ради этого события.
// Мигание держит воркер живым само — оно вызывает chrome.action.setIcon каждые
// 60 мс, и таймер простоя не успевает истечь.
chrome.proxy.settings.onChange.addListener(async (details) => {
  const desired = await getDesired();
  const level = details.levelOfControl;
  // Читается ДО noteForeignProxy: та сбрасывает флаг, а он нам нужен как признак
  // «мы уже сообщили о перехвате».
  const rt = await getRuntime();
  const wasHijacked = !!rt.foreignAlerted;
  const hijacked = level === "controlled_by_other_extensions";
  // Сбрасывать флаг здесь нельзя: проход согласования читает его, чтобы понять,
  // что поднимается из нерабочего состояния, и мигнуть зелёным. Снимет его сам
  // проход, когда всё получится.
  if (hijacked) await noteForeignProxy(true, !!desired.on);

  // Перехват кончился, а прокси нам нужен — приводим себя в порядок немедленно.
  //
  // Уровень тут бывает ДВУХ видов, и это выяснилось только на живом прогоне:
  //   controllable_by_this_extension — настройкой не распоряжается никто. Так
  //     бывает, если во время перехвата успел пройти цикл согласования: apply()
  //     упал и откатил наше значение. Прокси надо применить заново.
  //   controlled_by_this_extension — наше значение всё это время оставалось
  //     сохранённым (отката не было, потому что перехват длился меньше периода
  //     будильника), и Chrome вернул его в силу сам. Туннель уже работает, но
  //     точка осталась красной, а lastError — прежним.
  // Второй случай и есть обычный: пользователь включает и выключает чужое
  // расширение за секунды, задолго до срабатывания будильника.
  //
  // От петли защищает условие «мы сейчас в нерабочем состоянии»: после успешного
  // прохода runtime.running = true и lastError = null, и события от нашего же
  // apply() сюда больше не проходят. Плюс сам reconcile() однопоточен — событие,
  // прилетевшее посреди нашего apply(), получит уже идущий проход, а не новый.
  // Признак «надо привести себя в порядок» — это ИМЕННО факт бывшего перехвата, а
  // не нерабочее состояние. Живой прогон показал разницу: перехват длился секунды,
  // ни один проход согласования не успел упасть, поэтому runtime.running остался
  // true, а lastError пустым — красной точку сделала одна лишь пульсация. Проверка
  // на «сломаны» такой случай пропускала, и цвет чинил только будильник.
  //
  // Остальные два условия оставлены для долгого перехвата, когда проход всё же
  // успел упасть и откатить наше значение.
  if (hijacked) return;
  if (desired.on && (wasHijacked || !rt.running || state.lastError)) {
    await reconcileInBackground();
  } else if (wasHijacked) {
    // Прокси выключен, а перехват кончился: согласовывать нечего, но флаг снять
    // надо — иначе о следующем перехвате мы промолчим.
    await noteForeignProxy(false, false);
  }
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
  // Бейдж — из ФАКТА (runtime), не из намерения: зелёный обязан исходить только
  // из подтверждённого успеха. Раньше здесь стояло setBadge(desired.on), и
  // воркер, проснувшийся при сломанном туннеле, на время прохода согласования
  // рисовал зелёное поверх нерабочего прокси.
  const rt = await getRuntime();
  setBadge(desired.on && !!rt.running);
  // Если воркер убили посреди disable(), настройка могла остаться применённой при
  // выключённом намерении. Снимаем сразу, не дожидаясь прохода согласования.
  if (!desired.on) await proxy.clearIfOurs();
  reconcileInBackground();
})();
