// Per-profile chrome.proxy control.
//
// chrome.proxy.settings applies to the profile this extension instance runs in,
// which is exactly what gives us "only this Brave profile goes through the proxy".
//
// We route to the local mixed inbound exposed by the native host as a SOCKS5
// endpoint. SOCKS5 makes Chrome resolve DNS remotely (through the tunnel), which
// avoids DNS leaks.

import { PROXY_MODE } from "../common/constants.js";
import { t } from "./i18n.js";

const DEFAULT_BYPASS = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "<local>",
];

function fixedServersConfig(host, port, bypass = []) {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: "socks5", host, port: Number(port) },
      bypassList: [...DEFAULT_BYPASS, ...bypass],
    },
  };
}

/**
 * Build a PAC script that sends only matching hosts through the local SOCKS
 * proxy and everything else DIRECT.
 * @param {string} host
 * @param {number} port
 * @param {{proxyDomains?: string[], directDomains?: string[]}} rules
 */
// «*.youtube.com» интуитивно означает «весь Ютуб», но shExpMatch с этим шаблоном
// НЕ покрывает голый youtube.com — а ровно такой шаблон стоит плейсхолдером в
// нашем же поле настроек. Дописываем корень рядом с маской сами.
function expandWildcards(list) {
  const out = [];
  for (const d of list || []) {
    out.push(d);
    if (d.startsWith("*.") && d.length > 2) out.push(d.slice(2));
  }
  return out;
}

function pacConfig(host, port, rules = {}) {
  const proxyDomains = expandWildcards(rules.proxyDomains);
  const directDomains = expandWildcards(rules.directDomains);
  const proxyStr = `SOCKS5 ${host}:${Number(port)}`;
  const script = `
function FindProxyForURL(url, host) {
  var PROXY = "${proxyStr}";
  var directList = ${JSON.stringify(directDomains)};
  var proxyList = ${JSON.stringify(proxyDomains)};
  function match(list) {
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (host === d || dnsDomainIs(host, "." + d) || shExpMatch(host, d)) return true;
    }
    return false;
  }
  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1") return "DIRECT";
  if (match(directList)) return "DIRECT";
  // If a proxy list is provided, only those go through the proxy.
  if (proxyList.length > 0) return match(proxyList) ? PROXY : "DIRECT";
  // Otherwise everything not in directList goes through the proxy.
  return PROXY;
}`.trim();
  return {
    mode: "pac_script",
    // mandatory: true — режим правил обязан быть fail-closed, как и всё
    // остальное. Без этого флага любой сбой PAC-скрипта молча роняет ВЕСЬ трафик
    // в DIRECT: профиль ходит напрямую, а точка горит зелёным. С флагом сбой
    // рвёт соединения — заметно и честно.
    pacScript: { data: script, mandatory: true },
  };
}

/**
 * Raised when another extension outranks us for the proxy setting. Chrome stores
 * our value without applying it and `set()` does NOT reject, so this has to be
 * detected by reading levelOfControl afterwards — otherwise the UI would report
 * a working tunnel while traffic goes out directly.
 */
export class ProxyControlError extends Error {
  constructor(levelOfControl) {
    super(
      levelOfControl === "controlled_by_other_extensions"
        ? t("errProxyForeign")
        : t("errProxyBlocked")
    );
    this.name = "ProxyControlError";
    this.levelOfControl = levelOfControl;
  }
}

// --- WebRTC ------------------------------------------------------------------
// WebRTC шлёт UDP (STUN) напрямую, мимо настроек прокси: странице достаточно
// пяти строк JS, чтобы прочитать реальный публичный IP из ICE-кандидатов — при
// включённом прокси это единственный штатный способ его узнать. Политика
// disable_non_proxied_udp разрешает WebRTC только тот UDP, который идёт через
// прокси; Chrome не гонит UDP через SOCKS5, так что фактически WebRTC остаётся
// TURN-relay по TCP — через туннель. Ставится ТОЛЬКО при включённом прокси и
// снимается вместе с ним: цена (качество звонков) платится ровно там, где
// пользователь сам выбрал «весь трафик через сервер».

/** @returns {Promise<boolean>} true, если политика реально действует. */
async function applyWebRTCGuard() {
  const setting = chrome.privacy.network.webRTCIPHandlingPolicy;
  await setting.set({ value: "disable_non_proxied_udp", scope: "regular" });
  // Как и chrome.proxy, set() «успешен» даже когда распоряжается расширение
  // старше нас. Сверяем действующее значение: если чужое расширение держит ту
  // же политику — защита работает, чьими руками — неважно.
  const st = await setting.get({});
  return st.value === "disable_non_proxied_udp";
}

async function clearWebRTCGuard() {
  try {
    const setting = chrome.privacy.network.webRTCIPHandlingPolicy;
    const st = await setting.get({});
    if (st.levelOfControl === "controlled_by_this_extension") {
      await setting.clear({ scope: "regular" });
    }
  } catch (e) {
    console.warn("[proxy] clearWebRTCGuard failed:", e.message);
  }
}

export async function apply({ mode, host = "127.0.0.1", port, rules = {}, bypass = [] }) {
  let config;
  if (mode === PROXY_MODE.ALL) {
    config = fixedServersConfig(host, port, bypass);
  } else if (mode === PROXY_MODE.RULES) {
    config = pacConfig(host, port, rules);
  } else {
    return clear();
  }
  await chrome.proxy.settings.set({ value: config, scope: "regular" });

  // Verify the setting actually took effect for this profile.
  const state = await chrome.proxy.settings.get({});
  if (state.levelOfControl !== "controlled_by_this_extension") {
    // Значение уже сохранено, хотя и не действует: set() отработал, а старше нас
    // оказалось чужое расширение. Убираем его за собой. Иначе оно ждёт своего
    // часа: чужое расширение когда-нибудь уберут, Chrome применит наш забытый
    // конфиг на порт, где давно ничего не слушает, и профиль останется без
    // интернета без единой видимой причины. Ровно так выглядела авария
    // 8 августа, только там забытый конфиг остался от прежней регистрации.
    try {
      await chrome.proxy.settings.clear({ scope: "regular" });
    } catch (e) {
      console.warn("[proxy] rollback after lost control failed:", e.message);
    }
    throw new ProxyControlError(state.levelOfControl);
  }
  // Прокси наш — закрываем и WebRTC. Отказ защиты не отменяет туннель (он уже
  // работает), но должен быть виден вызывающему: тот пишет предупреждение в логи.
  const webrtcGuarded = await applyWebRTCGuard().catch((e) => {
    console.warn("[proxy] applyWebRTCGuard failed:", e.message);
    return false;
  });
  return { config, webrtcGuarded };
}

/**
 * Снять прокси. Никогда не бросает исключение и никогда не оставляет настройку
 * за собой молча.
 *
 * Прежняя версия делала один `clear()` и пробрасывала отказ наверх. Одного
 * неудачного вызова хватало, чтобы профиль остался с настройкой на порт, где
 * ничего не слушает: браузер показывает ERR_PROXY_CONNECTION_FAILED, и починить
 * это из интерфейса было нечем. Профиль без интернета — худший исход из
 * возможных, он важнее любой другой ошибки, поэтому здесь есть и проверка
 * результата, и запасной путь.
 */
export async function clear() {
  // WebRTC-политика живёт и умирает вместе с прокси. Снятие здесь, а не в
  // каждом вызывающем: у clear() много путей (выключение, откат отменённого
  // прохода, страховка при старте воркера), и все обязаны вернуть звонкам
  // обычное поведение.
  await clearWebRTCGuard();
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (e) {
    console.warn("[proxy] clear failed:", e.message);
  }
  try {
    const state = await chrome.proxy.settings.get({});
    if (state.levelOfControl !== "controlled_by_this_extension") return;
    // Настройка всё ещё наша. Ставим системную явно — это возвращает связь даже
    // если clear() почему-то не сработал, — и пробуем снять ещё раз.
    await chrome.proxy.settings.set({ value: { mode: "system" }, scope: "regular" });
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (e) {
    console.warn("[proxy] clear verification failed:", e.message);
  }
}

/**
 * Кто сейчас распоряжается настройкой прокси этого профиля.
 * Возвращает значение levelOfControl или null, если прочитать не удалось.
 */
export async function controlLevel() {
  try {
    return (await chrome.proxy.settings.get({})).levelOfControl;
  } catch (e) {
    console.warn("[proxy] controlLevel failed:", e.message);
    return null;
  }
}

/** Снять прокси, только если он всё ещё наш. Дешёвая страховка для опроса. */
export async function clearIfOurs() {
  try {
    const state = await chrome.proxy.settings.get({});
    if (state.levelOfControl === "controlled_by_this_extension") await clear();
  } catch (e) {
    console.warn("[proxy] clearIfOurs failed:", e.message);
  }
}

export async function current() {
  return chrome.proxy.settings.get({ incognito: false });
}
