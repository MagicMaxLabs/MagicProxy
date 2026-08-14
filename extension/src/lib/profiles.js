// Profile storage (chrome.storage.local) — CRUD over the normalized profile schema
// documented in docs/PROTOCOL.md.

import { STORAGE_KEYS, PROXY_MODE } from "../common/constants.js";

function uuid() {
  return crypto.randomUUID();
}

export async function listProfiles() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PROFILES);
  return data[STORAGE_KEYS.PROFILES] || [];
}

export async function getProfile(id) {
  const profiles = await listProfiles();
  return profiles.find((p) => p.id === id) || null;
}

export async function saveProfile(profile) {
  const profiles = await listProfiles();
  if (!profile.id) profile.id = uuid();
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: profiles });
  return profile;
}

export async function deleteProfile(id) {
  const profiles = await listProfiles();
  const next = profiles.filter((p) => p.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: next });
  const active = await getActiveProfileId();
  if (active === id) await setActiveProfileId(null);
}

// Отпечаток профиля для дедупликации: тип, адрес и учётные данные. Имя в
// отпечаток не входит — провайдеры меняют «имя» записи в подписке при каждом
// обновлении, и по имени один и тот же сервер считался бы новым.
function fingerprint(p) {
  return [p.type, p.server, p.port, p.uuid || p.password || p.username || ""].join("|");
}

/**
 * Импорт списка профилей с дедупликацией. Повторный импорт той же подписки
 * раньше удваивал все записи — теперь совпадающие с существующими пропускаются.
 * @returns {{added: object[], skipped: number}}
 */
export async function importProfiles(list) {
  const existing = await listProfiles();
  const seen = new Set(existing.map(fingerprint));
  const added = [];
  let skipped = 0;
  for (const p of list) {
    const fp = fingerprint(p);
    if (seen.has(fp)) {
      skipped++;
      continue;
    }
    seen.add(fp);
    added.push(await saveProfile(p));
  }
  return { added, skipped };
}

export async function getActiveProfileId() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_PROFILE_ID);
  return data[STORAGE_KEYS.ACTIVE_PROFILE_ID] || null;
}

export async function setActiveProfileId(id) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_PROFILE_ID]: id });
}

export async function getRouting() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.ROUTING);
  return (
    data[STORAGE_KEYS.ROUTING] || {
      mode: PROXY_MODE.ALL,
      // for PROXY_MODE.RULES:
      proxyDomains: [],
      directDomains: [],
      bypass: [],
      // sing-box side routing:
      final: "proxy",
      rules: [],
    }
  );
}

export async function setRouting(routing) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ROUTING]: routing });
}
