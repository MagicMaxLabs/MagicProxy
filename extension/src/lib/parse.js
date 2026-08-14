// Share-link and subscription parsing -> normalized profile (see docs/PROTOCOL.md).
//
// Supports: vless://, vmess://, trojan://, ss://, hysteria2:// (and hy2://),
// tuic://, socks://, http://. A subscription is base64 text with one link per line.

function b64decode(s) {
  // URL-safe + padding tolerant.
  let str = s.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch {
    return atob(str);
  }
}

// «Истинное» значение флага в share-ссылках пишут как минимум двумя способами:
// allowInsecure=1 и allowInsecure=true. Проверка только на "1" тихо включала
// строгую проверку сертификата там, где автор ссылки просил обратного, — ссылка
// импортировалась и не подключалась без единой подсказки почему.
function flagTrue(v) {
  return v === "1" || String(v || "").toLowerCase() === "true";
}

function pickTransport(params) {
  const type = params.get("type") || params.get("net") || "";
  if (!type || type === "tcp" || type === "raw" || type === "none") return undefined;
  const t = { type: type === "h2" ? "http" : type };
  const path = params.get("path");
  const host = params.get("host");
  const serviceName = params.get("serviceName") || params.get("servicename");
  if (path) t.path = path;
  if (host) t.host = host;
  if (serviceName) t.serviceName = serviceName;
  return t;
}

function pickTLS(params, defaultSni) {
  const security = (params.get("security") || "").toLowerCase();
  if (security !== "tls" && security !== "reality" && security !== "xtls") {
    return { enabled: false };
  }
  const tls = {
    enabled: true,
    serverName: params.get("sni") || params.get("peer") || defaultSni || "",
    insecure:
      flagTrue(params.get("allowInsecure")) || flagTrue(params.get("insecure")),
  };
  const alpn = params.get("alpn");
  if (alpn) tls.alpn = alpn.split(",").map((s) => s.trim()).filter(Boolean);
  const fp = params.get("fp");
  if (fp) tls.utls = { enabled: true, fingerprint: fp };
  if (security === "reality") {
    tls.reality = {
      enabled: true,
      publicKey: params.get("pbk") || "",
      shortId: params.get("sid") || "",
    };
  }
  return tls;
}

function parseVless(url) {
  const u = new URL(url);
  const p = u.searchParams;
  return {
    type: "vless",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 443,
    uuid: decodeURIComponent(u.username),
    flow: p.get("flow") || "",
    tls: pickTLS(p, u.hostname),
    transport: pickTransport(p),
  };
}

function parseVmess(url) {
  const json = JSON.parse(b64decode(url.slice("vmess://".length)));
  const net = json.net || "tcp";
  const tlsOn = json.tls === "tls" || json.tls === "reality";
  const transport =
    net && net !== "tcp"
      ? {
          type: net === "h2" ? "http" : net,
          path: json.path || undefined,
          host: json.host || undefined,
          serviceName: json.path && net === "grpc" ? json.path : undefined,
        }
      : undefined;
  return {
    type: "vmess",
    name: json.ps || json.add,
    server: json.add,
    port: Number(json.port) || 443,
    uuid: json.id,
    alterId: Number(json.aid) || 0,
    tls: tlsOn
      ? {
          enabled: true,
          serverName: json.sni || json.host || json.add,
          insecure: false,
          alpn: json.alpn
            ? json.alpn.split(",").map((s) => s.trim())
            : undefined,
        }
      : { enabled: false },
    transport,
  };
}

function parseTrojan(url) {
  const u = new URL(url);
  const p = u.searchParams;
  return {
    type: "trojan",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 443,
    password: decodeURIComponent(u.username),
    tls: { ...pickTLS(p, u.hostname), enabled: true },
    transport: pickTransport(p),
  };
}

// userinfo Shadowsocks: либо base64("method:password") — классический SIP002,
// либо (шифры 2022-blake3-*) голый "method:password" с percent-encoding — SIP022.
// Прежний код всегда декодировал base64, и atob() на SIP022-ссылке падал: все
// современные серверы отвергались на импорте. Пароль делится по ПЕРВОМУ
// двоеточию: в имени метода двоеточий не бывает, а в пароле — сколько угодно
// (split(":") резал такой пароль молча).
function splitCred(cred) {
  let dec = null;
  try {
    dec = b64decode(cred);
  } catch {
    dec = null;
  }
  // base64 может «успешно» дать мусор без разделителя — настоящий userinfo
  // обязан содержать «метод:пароль».
  if (!dec || !dec.includes(":")) dec = decodeURIComponent(cred);
  const i = dec.indexOf(":");
  if (i < 0) throw new Error("shadowsocks: userinfo без «метод:пароль»");
  return [dec.slice(0, i), dec.slice(i + 1)];
}

function parseShadowsocks(url) {
  // ss://base64(method:password)@host:port#name
  // or ss://method:percent-encoded-password@host:port#name   (SIP022)
  // or ss://base64(method:password@host:port)#name
  const hashIdx = url.indexOf("#");
  const name = hashIdx >= 0 ? decodeURIComponent(url.slice(hashIdx + 1)) : "";
  let body = url.slice("ss://".length, hashIdx >= 0 ? hashIdx : undefined);
  let method, password, host, port;
  if (body.includes("@")) {
    const atIdx = body.lastIndexOf("@");
    const cred = body.slice(0, atIdx);
    const hostport = body.slice(atIdx + 1);
    [method, password] = splitCred(cred);
    const lastColon = hostport.lastIndexOf(":");
    host = hostport.slice(0, lastColon);
    port = hostport.slice(lastColon + 1).split("?")[0];
  } else {
    const dec = b64decode(body);
    const atIdx = dec.lastIndexOf("@");
    const cred = dec.slice(0, atIdx);
    const hostport = dec.slice(atIdx + 1);
    [method, password] = splitCred(cred);
    const lastColon = hostport.lastIndexOf(":");
    host = hostport.slice(0, lastColon);
    port = hostport.slice(lastColon + 1);
  }
  return {
    type: "shadowsocks",
    name: name || host,
    server: host,
    port: Number(port) || 443,
    method,
    password,
    tls: { enabled: false },
  };
}

function parseHysteria2(url) {
  const u = new URL(url.replace(/^hy2:\/\//, "hysteria2://"));
  const p = u.searchParams;
  const obfsType = p.get("obfs");
  // Пароль Hysteria2 — это ВЕСЬ userinfo. URL-парсер делит его по первому
  // двоеточию на username:password, и прежний код брал только username —
  // пароль с двоеточием молча усекался.
  const user = decodeURIComponent(u.username || "");
  const pass = decodeURIComponent(u.password || "");
  return {
    type: "hysteria2",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 443,
    password: pass ? `${user}:${pass}` : user,
    tls: {
      enabled: true,
      serverName: p.get("sni") || u.hostname,
      insecure: flagTrue(p.get("insecure")),
    },
    hysteria2: obfsType
      ? { obfs: { type: obfsType, password: p.get("obfs-password") || "" } }
      : {},
  };
}

function parseTuic(url) {
  const u = new URL(url);
  const p = u.searchParams;
  return {
    type: "tuic",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 443,
    uuid: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    tls: {
      enabled: true,
      serverName: p.get("sni") || u.hostname,
      insecure: flagTrue(p.get("allow_insecure")),
      alpn: (p.get("alpn") || "h3").split(",").map((s) => s.trim()),
    },
    tuic: {
      congestionControl: p.get("congestion_control") || "bbr",
      udpRelayMode: p.get("udp_relay_mode") || "native",
    },
  };
}

function parseProxyUri(url, type) {
  const u = new URL(url);
  const p = u.searchParams;
  const isHttps = url.startsWith("https://");
  return {
    type,
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || (type === "http" ? (isHttps ? 443 : 8080) : 1080),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    // https:// = HTTP proxy tunnelled over TLS (HTTPS proxy).
    tls: isHttps
      ? {
          enabled: true,
          serverName: p.get("sni") || u.hostname,
          insecure: flagTrue(p.get("insecure")) || flagTrue(p.get("allowInsecure")),
        }
      : { enabled: false },
  };
}

function parseAnytls(url) {
  const u = new URL(url);
  const p = u.searchParams;
  return {
    type: "anytls",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 443,
    password: decodeURIComponent(u.username || u.password || ""),
    tls: {
      enabled: true,
      serverName: p.get("sni") || u.hostname,
      insecure: flagTrue(p.get("insecure")) || flagTrue(p.get("allowInsecure")),
    },
  };
}

function parseHysteria1(url) {
  const u = new URL(url);
  const p = u.searchParams;
  return {
    type: "hysteria",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 443,
    tls: {
      enabled: true,
      serverName: p.get("peer") || p.get("sni") || u.hostname,
      insecure: flagTrue(p.get("insecure")),
    },
    hysteria1: {
      authStr: p.get("auth") || p.get("auth_str") || "",
      upMbps: Number(p.get("upmbps") || p.get("up")) || 0,
      downMbps: Number(p.get("downmbps") || p.get("down")) || 0,
      // Секрет обфускации лежит в obfsParam=; obfs= — это НАЗВАНИЕ метода
      // (обычно xplus). Прежний код отправлял название вместо секрета, и
      // соединение молча зависало. Часть панелей кладёт секрет прямо в obfs= —
      // поэтому он остаётся запасным значением.
      obfs: p.get("obfsParam") || p.get("obfs-password") || p.get("obfs") || "",
    },
  };
}

function parseSsh(url) {
  const u = new URL(url);
  return {
    type: "ssh",
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    server: u.hostname,
    port: Number(u.port) || 22,
    username: u.username ? decodeURIComponent(u.username) : "root",
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: { enabled: false },
  };
}

/**
 * True when a line looks like a SUBSCRIPTION URL rather than a server link.
 *
 * Without this, parseLink() routes any http(s):// input to parseProxyUri and a
 * provider's subscription link silently becomes an "HTTP proxy on port 443"
 * profile that imports cleanly and never works. The discriminator is the path: a
 * proxy URL is host:port with no path, a subscription is a fetchable URL with one.
 * Matching on the scheme alone would reject genuine HTTPS-proxy links.
 */
export function looksLikeSubscriptionUrl(text) {
  const t = String(text || "").trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  try {
    const u = new URL(t);
    return u.pathname.length > 1 && u.username === "" && u.password === "";
  } catch (_) {
    return false;
  }
}

/** Parse a single share link into a normalized profile (without id). */
export function parseLink(raw) {
  const url = raw.trim();
  if (url.startsWith("vless://")) return parseVless(url);
  if (url.startsWith("vmess://")) return parseVmess(url);
  if (url.startsWith("trojan://")) return parseTrojan(url);
  if (url.startsWith("ss://")) return parseShadowsocks(url);
  if (url.startsWith("hysteria2://") || url.startsWith("hy2://"))
    return parseHysteria2(url);
  if (url.startsWith("hysteria://")) return parseHysteria1(url);
  if (url.startsWith("tuic://")) return parseTuic(url);
  if (url.startsWith("anytls://")) return parseAnytls(url);
  if (url.startsWith("ssh://")) return parseSsh(url);
  if (url.startsWith("socks5://") || url.startsWith("socks4://") || url.startsWith("socks://"))
    return parseProxyUri(url, "socks");
  if (url.startsWith("http://") || url.startsWith("https://"))
    return parseProxyUri(url, "http");
  throw new Error(`unsupported link scheme: ${url.slice(0, 12)}…`);
}

/**
 * Parse a subscription (base64 or plaintext, one link per line) into profiles.
 * Invalid lines are skipped and returned in `errors`.
 */
export function parseSubscription(text) {
  let content = text.trim();
  // Subscriptions are usually base64 of the whole body.
  if (!/:\/\//.test(content)) {
    try {
      content = b64decode(content);
    } catch {
      /* leave as-is */
    }
  }
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const profiles = [];
  const errors = [];
  for (const line of lines) {
    try {
      profiles.push(parseLink(line));
    } catch (e) {
      errors.push({ line, error: e.message });
    }
  }
  return { profiles, errors };
}
