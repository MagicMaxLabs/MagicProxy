import {
  listProfiles,
  saveProfile,
  deleteProfile,
  getActiveProfileId,
  getRouting,
  setRouting,
} from "../lib/profiles.js";
import { parseSubscription, looksLikeSubscriptionUrl } from "../lib/parse.js";
import { PRIVACY_URL, SECURITY_URL } from "../common/constants.js";

const $ = (id) => document.getElementById(id);

function send(cmd, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ cmd, ...extra }, (r) =>
      resolve(r || { ok: false, error: "no response" })
    );
  });
}

// --- Profiles table ---------------------------------------------------------
async function renderProfiles() {
  const [profiles, activeId] = await Promise.all([
    listProfiles(),
    getActiveProfileId(),
  ]);
  const body = $("profileBody");
  body.innerHTML = "";
  for (const p of profiles) {
    const tr = document.createElement("tr");

    const tdRadio = document.createElement("td");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "active";
    radio.checked = p.id === activeId;
    // Через service worker, а не setActiveProfileId(): при работающем прокси
    // смену профиля надо ещё и применить — перезапустить ядро под новый конфиг.
    // Тот же дефект, что был в попапе.
    radio.addEventListener("change", async () => {
      radio.disabled = true;
      const resp = await send("setProfile", { profileId: p.id });
      radio.disabled = false;
      if (!resp.ok) alert(`Не удалось переключить профиль: ${resp.error}`);
    });
    tdRadio.appendChild(radio);

    const tdName = document.createElement("td");
    tdName.textContent = p.name || "(без имени)";
    const tdType = document.createElement("td");
    tdType.textContent = p.type;
    const tdServer = document.createElement("td");
    tdServer.textContent = `${p.server}:${p.port}`;

    const tdActions = document.createElement("td");
    // Настоящие кнопки, а не <span>: фокус и Enter/Space достаются бесплатно.
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "link";
    edit.textContent = "изменить";
    edit.addEventListener("click", () => openEditor(p));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link danger";
    del.textContent = "удалить";
    del.addEventListener("click", async () => {
      // Подтверждение обязательно: профиль — это выданные однажды UUID и ключи,
      // копии которых у пользователя может больше не быть.
      const label = p.name ? `«${p.name}»` : `${p.server}:${p.port}`;
      if (!confirm(`Удалить профиль ${label}? Данные для подключения будут потеряны.`)) return;
      await deleteProfile(p.id);
      renderProfiles();
    });
    tdActions.append(edit, del);

    tr.append(tdRadio, tdName, tdType, tdServer, tdActions);
    body.appendChild(tr);
  }
}

// --- Import -----------------------------------------------------------------
$("importBtn").addEventListener("click", async () => {
  const text = $("importBox").value.trim();
  if (!text) return;
  const res = $("importResult");

  // Same trap as in onboarding: a subscription URL would be parsed as an HTTP
  // proxy on port 443 and imported as a profile that can never connect. Fetching
  // subscriptions is not implemented yet, so say so plainly rather than lie.
  if (looksLikeSubscriptionUrl(text)) {
    res.textContent =
      "Это ссылка на подписку. Загрузка подписок по ссылке пока не поддерживается — открой её в браузере и вставь сюда её содержимое.";
    res.className = "hint bad";
    return;
  }

  const { profiles, errors } = parseSubscription(text);
  for (const p of profiles) await saveProfile(p);
  // A bare count ("ошибок: 1") tells the user nothing about what to fix.
  res.textContent =
    `Импортировано: ${profiles.length}` +
    (errors.length ? ` · не разобрано ${errors.length}: ${errors[0].error}` : "");
  res.className = errors.length ? "hint bad" : "hint ok";
  $("importBox").value = "";
  renderProfiles();
});

// --- JSON editor ------------------------------------------------------------
let editingId = null;

const TEMPLATES = {
  vless: {
    name: "VLESS Reality", type: "vless", server: "example.com", port: 443,
    uuid: "", flow: "xtls-rprx-vision",
    tls: { enabled: true, serverName: "www.microsoft.com", insecure: false,
      utls: { enabled: true, fingerprint: "chrome" },
      reality: { enabled: true, publicKey: "", shortId: "" } },
  },
  "vless-ws": {
    name: "VLESS WS", type: "vless", server: "example.com", port: 443, uuid: "",
    tls: { enabled: true, serverName: "example.com", utls: { enabled: true, fingerprint: "chrome" } },
    transport: { type: "ws", path: "/ws", host: "example.com" },
  },
  vmess: {
    name: "VMess", type: "vmess", server: "example.com", port: 443, uuid: "", alterId: 0,
    tls: { enabled: true, serverName: "example.com" },
    transport: { type: "ws", path: "/", host: "example.com" },
  },
  trojan: {
    name: "Trojan", type: "trojan", server: "example.com", port: 443, password: "",
    tls: { enabled: true, serverName: "example.com" },
  },
  shadowsocks: {
    name: "Shadowsocks", type: "shadowsocks", server: "example.com", port: 8388,
    method: "2022-blake3-aes-128-gcm", password: "", tls: { enabled: false },
  },
  shadowtls: {
    name: "SS + ShadowTLS", type: "shadowsocks", server: "example.com", port: 443,
    method: "2022-blake3-aes-128-gcm", password: "",
    tls: { enabled: true, serverName: "www.microsoft.com", utls: { enabled: true, fingerprint: "chrome" } },
    shadowtls: { version: 3, password: "" },
  },
  hysteria2: {
    name: "Hysteria2", type: "hysteria2", server: "example.com", port: 443, password: "",
    tls: { enabled: true, serverName: "example.com", insecure: false },
    // No obfs stub: an obfs block with an empty password is fatal to the core, so
    // the template would not start as shipped. Add obfs only if your server uses it.
    hysteria2: { upMbps: 50, downMbps: 200 },
  },
  hysteria: {
    name: "Hysteria v1", type: "hysteria", server: "example.com", port: 443,
    tls: { enabled: true, serverName: "example.com", insecure: false },
    hysteria1: { authStr: "", upMbps: 100, downMbps: 100, obfs: "" },
  },
  tuic: {
    name: "TUIC", type: "tuic", server: "example.com", port: 443, uuid: "", password: "",
    tls: { enabled: true, serverName: "example.com", alpn: ["h3"] },
    tuic: { congestionControl: "bbr", udpRelayMode: "native" },
  },
  anytls: {
    name: "AnyTLS", type: "anytls", server: "example.com", port: 443, password: "",
    tls: { enabled: true, serverName: "example.com", insecure: false },
  },
  wireguard: {
    name: "WireGuard", type: "wireguard", server: "engage.cloudflareclient.com", port: 2408,
    wireguard: { privateKey: "", peerPublicKey: "", preSharedKey: "",
      localAddress: ["172.16.0.2/32"], mtu: 1408, reserved: [0, 0, 0] },
  },
  ssh: {
    name: "SSH", type: "ssh", server: "example.com", port: 22,
    username: "root", password: "", privateKey: "",
    // Ключ хоста обязателен: без него любой сервер на пути может выдать себя за
    // ваш и забрать пароль. Получить: ssh-keyscan -t ed25519 example.com
    hostKey: "",
  },
  socks: {
    name: "SOCKS", type: "socks", server: "example.com", port: 1080,
    socksVersion: "5", username: "", password: "", tls: { enabled: false },
  },
  http: {
    name: "HTTP(S) proxy", type: "http", server: "example.com", port: 8080,
    username: "", password: "",
    tls: { enabled: false, serverName: "example.com" },
  },
};

function openEditor(profile) {
  editingId = profile ? profile.id : null;
  $("editorTitle").textContent = profile ? "Изменить профиль" : "Новый профиль";
  $("editorType").value = "";
  $("editorJson").value = JSON.stringify(profile || TEMPLATES.vless, null, 2);
  $("editorResult").textContent = "";
  $("editorOverlay").classList.remove("hidden");
}

$("editorType").addEventListener("change", () => {
  const tpl = TEMPLATES[$("editorType").value];
  if (!tpl) return;
  const keepId = editingId ? { id: editingId } : {};
  $("editorJson").value = JSON.stringify({ ...tpl, ...keepId }, null, 2);
});

function closeEditor() {
  $("editorOverlay").classList.add("hidden");
  editingId = null;
}

function parseEditor() {
  const obj = JSON.parse($("editorJson").value);
  if (editingId) obj.id = editingId;
  return obj;
}

$("addBtn").addEventListener("click", () => openEditor(null));

// Экспорт — страховка от «удалил, а копии нигде нет»: UUID и ключи выдаются в
// панели провайдера один раз, восстановить их после потери часто нечем.
// Формат — JSON-массив профилей; любой элемент можно вставить обратно через
// «Новый профиль (JSON)» как есть.
$("exportBtn").addEventListener("click", async () => {
  const res = $("exportResult");
  const profiles = await listProfiles();
  if (!profiles.length) {
    res.textContent = "Экспортировать нечего — профилей нет.";
    res.className = "hint bad";
    return;
  }
  const blob = new Blob([JSON.stringify(profiles, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `magicproxy-profiles-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  res.textContent = `Сохранено профилей: ${profiles.length}. Файл содержит пароли и ключи — храните его как пароль.`;
  res.className = "hint ok";
});

$("editorCancel").addEventListener("click", closeEditor);

$("editorSave").addEventListener("click", async () => {
  const res = $("editorResult");
  try {
    const obj = parseEditor();
    await saveProfile(obj);
    closeEditor();
    renderProfiles();
  } catch (e) {
    res.textContent = `JSON: ${e.message}`;
    res.className = "hint bad";
  }
});

$("editorTest").addEventListener("click", async () => {
  const res = $("editorResult");
  let obj;
  try {
    obj = parseEditor();
  } catch (e) {
    res.textContent = `JSON: ${e.message}`;
    res.className = "hint bad";
    return;
  }
  res.textContent = "Проверяю…";
  res.className = "hint";
  const resp = await send("test", { profile: obj });
  if (resp.ok && resp.data?.valid) {
    res.textContent = "Конфиг валиден ✓";
    res.className = "hint ok";
  } else {
    res.textContent = `Ошибка: ${resp.error || "невалидный конфиг"}`;
    res.className = "hint bad";
  }
});

// --- Routing ----------------------------------------------------------------
function splitLines(v) {
  return v
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadRouting() {
  const r = await getRouting();
  $("routingMode").value = r.mode || "all";
  $("proxyDomains").value = (r.proxyDomains || []).join("\n");
  $("directDomains").value = (r.directDomains || []).join("\n");
  toggleRulesFields();
}

function toggleRulesFields() {
  $("rulesFields").style.display =
    $("routingMode").value === "rules" ? "block" : "none";
}
$("routingMode").addEventListener("change", toggleRulesFields);

$("saveRoutingBtn").addEventListener("click", async () => {
  const current = await getRouting();
  const next = {
    ...current,
    mode: $("routingMode").value,
    proxyDomains: splitLines($("proxyDomains").value),
    directDomains: splitLines($("directDomains").value),
  };
  await setRouting(next);
  const res = $("routingResult");
  res.textContent = "Сохранено ✓ (применится при следующем включении)";
  res.className = "hint ok";
});

// --- Updates ----------------------------------------------------------------
$("checkUpdateBtn").addEventListener("click", async () => {
  const res = $("updateResult");
  res.textContent = "Проверяю…";
  res.className = "hint";
  const resp = await send("checkUpdate");
  if (!resp.ok) {
    res.textContent = `Ошибка: ${resp.error}`;
    res.className = "hint bad";
    return;
  }
  const { current, latest, updateAvailable } = resp.data;
  if (updateAvailable) {
    res.textContent = `Установлено ${current}, доступно ${latest}`;
    res.className = "hint";
    $("updateCoreBtn").disabled = false;
  } else {
    res.textContent = `Актуально (${current || "?"})`;
    res.className = "hint ok";
    $("updateCoreBtn").disabled = true;
  }
});

$("updateCoreBtn").addEventListener("click", async () => {
  const res = $("updateResult");
  res.textContent = "Скачиваю и обновляю (прокси будет временно выключен)…";
  res.className = "hint";
  $("updateCoreBtn").disabled = true;
  const resp = await send("updateCore");
  if (resp.ok && resp.data?.updated) {
    res.textContent = `Обновлено до ${resp.data.version} ✓`;
    res.className = "hint ok";
  } else {
    res.textContent = `Ошибка: ${resp.error || "не удалось обновить"}`;
    res.className = "hint bad";
    $("updateCoreBtn").disabled = false;
  }
});

// --- Раздел «Данные» ---------------------------------------------------------
// Открываем в новой вкладке через chrome.tabs: на странице настроек расширения
// обычный href уводит из неё, а вернуться потом некуда.
for (const [id, url] of [["privacyLink", PRIVACY_URL], ["securityLink", SECURITY_URL]]) {
  const el = $(id);
  if (el) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url });
    });
  }
}

// --- Init -------------------------------------------------------------------
renderProfiles();
loadRouting();
