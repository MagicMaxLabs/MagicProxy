import { listProfiles, getActiveProfileId } from "../lib/profiles.js";
import { STORAGE_KEYS } from "../common/constants.js";

const el = {
  hostStatus: document.getElementById("hostStatus"),
  hostBanner: document.getElementById("hostBanner"),
  profileSelect: document.getElementById("profileSelect"),
  toggleBtn: document.getElementById("toggleBtn"),
  statusLine: document.getElementById("statusLine"),
  logView: document.getElementById("logView"),
  optionsLink: document.getElementById("optionsLink"),
};

// Known native-messaging failures are surfaced in English by Chrome. Users of a
// Russian UI should not be reading "Specified native messaging host not found."
function humanError(msg = "") {
  // Must stay narrow: a bare /not found/ also matches the core's own
  // "sing-box binary not found near …", which would tell a user whose host IS
  // installed that it is not — contradicting the banner right above it.
  if (/native messaging host not found/i.test(msg))
    return "Фоновый компонент не установлен";
  if (/sing-box binary not found/i.test(msg))
    return "Сетевое ядро не найдено — возможно, его удалил антивирус";
  if (/disconnected|Native host has exited/i.test(msg))
    return "Фоновый компонент неожиданно завершился";
  if (/Access to the specified native messaging host is forbidden/i.test(msg))
    return "Фоновый компонент не разрешает подключение этому расширению";
  return msg;
}

function send(cmd, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ cmd, ...extra }, (resp) =>
      resolve(resp || { ok: false, error: "no response" })
    );
  });
}

let desiredOn = false;
// True from the moment the toggle is clicked until its request resolves.
let busy = false;

// Host health gates the toggle: without a working core, turning the proxy "on"
// can only fail, and it used to fail by printing a raw English exception.
let hostReady = false;

function openOnboarding() {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/onboarding.html") });
  window.close();
}

async function refreshHostStatus() {
  const resp = await send("hostVersion");
  const core = resp.ok && resp.data ? resp.data.singbox : null;
  // resp.ok alone is not enough: the host answers "unavailable" when it is running
  // but the core is missing, and that used to render as a healthy green pill.
  // Three outcomes, matching onboarding.js probe(): "unavailable" = the host could
  // not find the core, "unknown" = it found it but could not execute it (the
  // antivirus-quarantine case). Treating "unknown" as healthy showed a green pill
  // AND hid the banner — the only permanent link to the screen written for it.
  hostReady = !!(resp.ok && core && core !== "unavailable" && core !== "unknown");

  if (hostReady) {
    el.hostStatus.textContent = `host ${resp.data.host}`;
    el.hostStatus.className = "pill pill--ok";
    el.hostStatus.title = `sing-box ${core}`;
    el.hostBanner.classList.add("hidden");
  } else {
    el.hostStatus.textContent = "host ✗";
    el.hostStatus.className = "pill pill--err";
    el.hostStatus.title = resp.error || "сетевое ядро недоступно";
    el.hostBanner.textContent = resp.ok
      ? "Сетевое ядро не запускается — открыть инструкцию"
      : "Фоновый компонент не установлен — установить";
    el.hostBanner.classList.remove("hidden");
  }
}

async function loadProfiles() {
  const [profiles, activeId] = await Promise.all([
    listProfiles(),
    getActiveProfileId(),
  ]);
  el.profileSelect.innerHTML = "";
  if (profiles.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "— нет профилей —";
    opt.value = "";
    el.profileSelect.appendChild(opt);
    el.toggleBtn.disabled = true;
    return;
  }
  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} · ${p.type}`;
    if (p.id === activeId) opt.selected = true;
    el.profileSelect.appendChild(opt);
  }
  applyToggleAvailability();
}

// Gating the toggle on host health must NEVER block turning the proxy OFF.
// The design is deliberately fail-closed: when the host dies, chrome.proxy stays
// pointed at the (now dead) local port so traffic cannot leak out directly. If the
// off switch were also disabled, the user would be left with a profile that has no
// internet and no way to recover from the UI.
function applyToggleAvailability() {
  // While the user's own enable/disable is still in flight, the 2 s refresh must
  // not re-enable or relabel the button: storage already holds the NEW intent, so
  // the poll would flip the label and a second click would fire the opposite
  // action against a request that has not finished.
  if (busy) return;
  const hasProfile = el.profileSelect.value !== "";
  el.toggleBtn.disabled = desiredOn ? false : !hostReady || !hasProfile;
}

function renderState(s) {
  desiredOn = !!s.on;
  el.toggleBtn.textContent = desiredOn ? "Выключить" : "Включить";
  el.toggleBtn.className = desiredOn ? "toggle toggle--on" : "toggle toggle--off";
  // Intent just changed, so the off-switch exemption may now apply.
  applyToggleAvailability();
  if (s.lastError) {
    el.statusLine.textContent = `Ошибка: ${humanError(s.lastError)}`;
    el.statusLine.className = "status status--err";
  } else if (desiredOn && s.running) {
    el.statusLine.textContent = `Активно · 127.0.0.1:${s.port}`;
    el.statusLine.className = "status status--on";
  } else if (s.healing) {
    el.statusLine.textContent = "Восстанавливаю соединение…";
    el.statusLine.className = "status";
  } else if (s.foreignProxy) {
    // Прокси профиля держит другое расширение. Снять его мы не можем, но молчать
    // нельзя: без этой строки попап писал бы «Выключено», пока браузер не работает.
    el.statusLine.textContent = "Выключено. Прокси профиля занят другим расширением";
    el.statusLine.className = "status status--warn";
  } else {
    el.statusLine.textContent = "Выключено";
    el.statusLine.className = "status status--off";
  }
}

async function refreshState() {
  const resp = await send("state");
  if (resp.ok) renderState(resp.data);
}

async function refreshLogs() {
  const resp = await send("logs");
  if (resp.ok && Array.isArray(resp.data)) {
    el.logView.textContent = resp.data
      .slice(-60)
      .map((l) => l.line)
      .join("\n");
  }
}

// Смену профиля выполняет service worker: записать выбор в storage мало, работающее
// ядро надо перезапустить под новый конфиг. Раньше здесь стоял только setActiveProfileId(),
// и прежний сервер оставался рабочим до цикла «выключить — включить».
el.profileSelect.addEventListener("change", async () => {
  if (busy) return;
  const id = el.profileSelect.value || null;
  const wasOn = desiredOn;
  busy = true;
  el.profileSelect.disabled = true;
  if (wasOn) {
    el.toggleBtn.disabled = true;
    el.statusLine.textContent = "Переключаю профиль…";
    el.statusLine.className = "status";
  }
  const resp = await send("setProfile", { profileId: id });
  busy = false;
  el.profileSelect.disabled = false;
  if (!resp.ok) {
    el.statusLine.textContent = `Ошибка: ${humanError(resp.error)}`;
    el.statusLine.className = "status status--err";
  }
  await refreshState();
  if (wasOn) await refreshLogs();
});

el.toggleBtn.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  el.toggleBtn.disabled = true;
  // Пока запрос в полёте, список профилей заблокирован: иначе выбор уедет вперёд
  // намерения, и на экране будет один профиль, а в работе другой.
  el.profileSelect.disabled = true;
  el.statusLine.textContent = desiredOn ? "Останавливаю…" : "Запускаю…";
  el.statusLine.className = "status";
  const resp = desiredOn
    ? await send("disable")
    : await send("enable", { profileId: el.profileSelect.value });
  busy = false;
  el.toggleBtn.disabled = false;
  el.profileSelect.disabled = false;
  if (!resp.ok) {
    el.statusLine.textContent = `Ошибка: ${humanError(resp.error)}`;
    el.statusLine.className = "status status--err";
  }
  await refreshState();
  await refreshLogs();
});

el.optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Two permanent routes back to the setup instructions. Previously the only signal
// was a tooltip on a pill, so a user who closed the onboarding tab had no way back.
el.hostBanner.addEventListener("click", openOnboarding);
el.hostStatus.addEventListener("click", () => {
  if (!hostReady) openOnboarding();
});

(async function init() {
  // Read the persisted intent straight from storage first. Everything else has to
  // talk to the native host, which can take up to 15 s; during that window the
  // button would otherwise read "Включить" to a user who is already ON.
  const d = await chrome.storage.local.get(STORAGE_KEYS.DESIRED);
  desiredOn = !!(d[STORAGE_KEYS.DESIRED] && d[STORAGE_KEYS.DESIRED].on);
  el.toggleBtn.textContent = desiredOn ? "Выключить" : "Включить";
  el.toggleBtn.className = desiredOn ? "toggle toggle--on" : "toggle toggle--off";
  // Строка состояния тоже обязана отражать намерение сразу. Раньше чинилась только
  // надпись на кнопке, а строка держала разметочное «Выключено» до конца опроса
  // хоста — а это круг Native Messaging на разбуженном воркере. Включённый
  // пользователь секунду видел, что у него всё выключено.
  el.statusLine.textContent = desiredOn ? "Проверяю соединение…" : "Выключено";
  el.statusLine.className = desiredOn ? "status" : "status status--off";
  // An ON user can act immediately; an OFF user waits for the host probe.
  if (desiredOn) el.toggleBtn.disabled = false;

  // Sequential, not Promise.all: loadProfiles() reads hostReady to decide whether
  // the toggle can be enabled, so the host probe has to finish first.
  await refreshHostStatus();
  await loadProfiles();
  await refreshState();
  await refreshLogs();
  setInterval(() => {
    refreshState();
    if (desiredOn) refreshLogs();
  }, 2000);
})();
