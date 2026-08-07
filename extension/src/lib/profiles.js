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
