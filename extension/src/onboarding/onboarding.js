// First-run / recovery page.
//
// Three real states, not two. The old page collapsed "host not installed" and
// "host installed but core unavailable" into one screen that told the second group
// to download an installer they already have — sending them round a loop.

import { DOWNLOAD_MIRRORS, RELEASES_URL } from "../common/constants.js";
import { parseSubscription, looksLikeSubscriptionUrl } from "../lib/parse.js";
import { saveProfile, listProfiles, setActiveProfileId } from "../lib/profiles.js";

const $ = (id) => document.getElementById(id);
const STATES = ["checking", "ready", "missing", "coreBlocked"];

function show(which) {
  for (const id of STATES) $(id).classList.toggle("hidden", id !== which);
}

function send(cmd, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ cmd, ...extra }, (r) =>
      resolve(r || { ok: false, error: "no response" })
    );
  });
}

/**
 * Distinguishes the three cases the UI must not conflate:
 *   "ready"       — host answered and reports a real core version
 *   "coreBlocked" — host answered but the core is missing/quarantined
 *   "missing"     — host did not answer at all (not installed / not registered)
 */
async function probe() {
  try {
    const resp = await send("hostVersion");
    if (!resp.ok) return { state: "missing", error: resp.error };
    const sb = resp.data && resp.data.singbox;
    // Three failure spellings, not one: "unavailable" means the host could not
    // find the binary at all, while "unknown" means it found it but running
    // `sing-box version` failed — the antivirus-quarantine case, where the file
    // exists on disk but cannot execute. Both must NOT read as ready.
    if (!sb || sb === "unavailable" || sb === "unknown") {
      return { state: "coreBlocked", data: resp.data };
    }
    return { state: "ready", data: resp.data };
  } catch (e) {
    // Never leave the page on the spinner because of an unexpected throw.
    return { state: "missing", error: e && e.message };
  }
}

// --- polling so the page notices the installer finishing, with no click --------
let poll = null;
let pollStarted = 0;
let currentState = null;
const POLL_MS = 3000;
const POLL_GIVE_UP_MS = 5 * 60 * 1000;

function startPolling() {
  if (poll) return;
  pollStarted = Date.now();
  poll = setInterval(async () => {
    // Backing off after a few minutes is fine; going silent is not. The manual
    // "Проверить снова" buttons and the focus listener stay live regardless.
    if (Date.now() - pollStarted > POLL_GIVE_UP_MS) return stopPolling();
    const r = await probe();
    // Re-render on ANY state change, not just on success: missing -> coreBlocked
    // is a real transition (the user ran the installer but antivirus ate the
    // core), and swallowing it would leave the wrong advice on screen.
    if (r.state !== currentState) render(r);
  }, POLL_MS);
}
function stopPolling() {
  if (poll) clearInterval(poll);
  poll = null;
}

function render(result) {
  $("statusLine").textContent = "";
  currentState = result.state;
  if (result.state === "ready") {
    stopPolling();
    const d = result.data || {};
    $("hostInfo").textContent = `Компонент ${d.host || "?"}, ядро ${d.singbox || "?"}`;
    show("ready");
    return;
  }
  show(result.state);
  startPolling();
}

async function recheck() {
  $("statusLine").textContent = "Проверяю…";
  render(await probe());
}

// --- download mirrors ---------------------------------------------------------
function renderMirrors() {
  const primary = DOWNLOAD_MIRRORS[0];
  $("downloadBtn").href = primary ? primary.url : RELEASES_URL;

  const rest = DOWNLOAD_MIRRORS.slice(1);
  if (rest.length === 0) {
    // Only one source exists today; do not pretend otherwise.
    $("mirrorsLabel").textContent = "Страница релиза (контрольные суммы, прошлые версии):";
    const a = document.createElement("a");
    a.href = RELEASES_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = RELEASES_URL;
    $("mirrors").replaceChildren(a);
    return;
  }
  const frag = document.createDocumentFragment();
  rest.forEach((m, i) => {
    if (i) frag.append(" · ");
    const a = document.createElement("a");
    a.href = m.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = m.label;
    frag.append(a);
  });
  $("mirrors").replaceChildren(frag);
}

// --- quick import from the ready screen ---------------------------------------
$("quickImportBtn").addEventListener("click", async () => {
  const text = $("quickImport").value.trim();
  const msg = $("quickImportMsg");
  if (!text) {
    msg.textContent = "Вставь ссылку на сервер.";
    msg.className = "hint";
    return;
  }
  // A SUBSCRIPTION URL would otherwise be parsed as an "HTTP proxy" profile,
  // activated, and reported as success — parse.js routes anything http(s):// to
  // parseProxyUri. Providers hand out exactly this to new users.
  //
  // Discriminator is the PATH: a proxy URL is host:port with no path, while a
  // subscription is a fetchable link like https://host/sub/<token>. Matching on
  // "starts with https" alone would reject genuine HTTPS-proxy links.
  if (looksLikeSubscriptionUrl(text)) {
    const msg = $("quickImportMsg");
    msg.textContent =
      "Похоже, это ссылка на подписку, а не на сервер. Открой настройки — там есть импорт подписок.";
    msg.className = "hint bad";
    return;
  }

  const { profiles, errors } = parseSubscription(text);
  if (!profiles.length) {
    msg.textContent = errors.length
      ? `Не удалось разобрать ссылку: ${errors[0].error}`
      : "Не удалось разобрать ссылку.";
    msg.className = "hint bad";
    return;
  }
  for (const p of profiles) await saveProfile(p);
  // Without an active profile the popup renders a table with nothing selected and
  // a disabled button, which reads as "nothing happened".
  const all = await listProfiles();
  if (all.length) await setActiveProfileId(profiles[0].id || all[0].id);
  msg.textContent = `Добавлено серверов: ${profiles.length}. Открой 🪄 на панели и нажми «Включить».`;
  msg.className = "hint ok";
  $("quickImport").value = "";
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("recheckCore").addEventListener("click", recheck);
$("recheckMissing").addEventListener("click", recheck);

// Coming back from the installer should just work, without touching anything.
// Deliberately NOT gated on `poll`: polling gives up after a few minutes, and
// gating here on the same handle would make the page permanently inert.
window.addEventListener("focus", async () => {
  if (currentState && currentState !== "ready") render(await probe());
});

renderMirrors();
(async () => {
  show("checking");
  render(await probe());
})();
