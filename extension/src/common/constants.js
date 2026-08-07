// Shared constants for MagicProxy extension.

// Must match the "name" field in the native messaging host manifest
// (installer/com.magicproxy.host.json) and the registry key written by
// setup.ps1 / installer/magicproxy.iss.
export const NATIVE_HOST_NAME = "com.magicproxy.host";

// Where the onboarding page sends users to download the installer.
//
// This is the product's single point of failure: the Chrome Web Store is served by
// Google and is usually reachable where objects.githubusercontent.com is not, so a
// GitHub-only download means the extension installs fine and then can never be
// completed — for exactly the users this exists for. Hence a mirror list.
//
// Order matters: the first reachable entry becomes the primary button, and the rest
// stay VISIBLE (never hidden behind a disclosure) because someone whose network is
// blocking the first one cannot be expected to go hunting.
//
// Each entry links DIRECTLY to the asset, not to a release page — a release page
// offers four look-alike files and makes the user choose.
// TODO: put an independent domain first once magicmaxlabs owns one.
export const DOWNLOAD_MIRRORS = [
  {
    label: "GitHub",
    url: "https://github.com/magicmaxlabs/MagicProxy/releases/latest/download/MagicProxy-Setup.exe",
  },
];

// Release page, for checksums and older versions.
export const RELEASES_URL = "https://github.com/magicmaxlabs/MagicProxy/releases/latest";

// chrome.storage.local keys
export const STORAGE_KEYS = {
  PROFILES: "profiles",
  ACTIVE_PROFILE_ID: "activeProfileId",
  ROUTING: "routing",
  SETTINGS: "settings",
  RUNTIME: "runtime", // volatile mirror for UI: { running, port, lastError }
  DESIRED: "desired", // persisted intent: { on, profileId, port }
};

// Alarm that keeps the service worker alive and self-heals the proxy.
export const KEEPALIVE_ALARM = "magicproxy-keepalive";
// How often to ping the host / reconcile (minutes). 0.5 = 30s (Chrome minimum).
export const KEEPALIVE_PERIOD_MIN = 0.5;

// Proxy application modes
export const PROXY_MODE = {
  OFF: "off", // no proxy for this profile (direct/system)
  ALL: "all", // route everything through the local proxy
  RULES: "rules", // PAC: route by rules, bypass the rest
};

export const SUPPORTED_TYPES = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "hysteria",
  "tuic",
  "anytls",
  "wireguard",
  "ssh",
  "socks", // SOCKS5/SOCKS4, with or without auth
  "http", // HTTP or HTTPS proxy, with or without auth
];

// Default local inbound listen address. Port 0 => host auto-picks a free port.
export const DEFAULT_INBOUND = { listen: "127.0.0.1", port: 0 };
