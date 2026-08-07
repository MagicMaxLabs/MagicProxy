// Per-profile chrome.proxy control.
//
// chrome.proxy.settings applies to the profile this extension instance runs in,
// which is exactly what gives us "only this Brave profile goes through the proxy".
//
// We route to the local mixed inbound exposed by the native host as a SOCKS5
// endpoint. SOCKS5 makes Chrome resolve DNS remotely (through the tunnel), which
// avoids DNS leaks.

import { PROXY_MODE } from "../common/constants.js";

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
function pacConfig(host, port, rules = {}) {
  const proxyDomains = rules.proxyDomains || [];
  const directDomains = rules.directDomains || [];
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
    pacScript: { data: script },
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
        ? "прокси управляется другим расширением — отключите его и попробуйте снова"
        : "браузер не позволяет управлять настройками прокси в этом профиле"
    );
    this.name = "ProxyControlError";
    this.levelOfControl = levelOfControl;
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
    throw new ProxyControlError(state.levelOfControl);
  }
  return config;
}

export async function clear() {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

export async function current() {
  return chrome.proxy.settings.get({ incognito: false });
}
