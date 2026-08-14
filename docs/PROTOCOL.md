# Протокол расширение ↔ нативный хост

Транспорт — Chrome Native Messaging: каждое сообщение это
`[uint32 LE длина][UTF-8 JSON]`. Ограничение Chrome: сообщение хост→расширение
≤ 1 МБ.

## Запрос (расширение → хост)

```jsonc
{
  "id": "req-uuid",          // корреляционный id
  "type": "start",           // ping | version | start | stop | status | test
  "payload": { ... }         // зависит от type
}
```

## Ответ (хост → расширение)

```jsonc
{
  "id": "req-uuid",          // тот же id
  "ok": true,
  "result": { ... },         // при ok=true
  "error": "текст"           // при ok=false
}
```

## События (хост → расширение, без запроса)

```jsonc
{ "event": "log",   "payload": { "level": "info", "line": "..." } }
{ "event": "state", "payload": { "running": true, "port": 23808 } }
```

## Типы запросов

### `ping`
`payload: {}` → `result: { pong: true }`

### `version`
→ `result: { host: "0.1.0", singbox: "1.x.y" }`

### `start`
```jsonc
{
  "profile": { /* см. схему профиля ниже */ },
  "inbound": { "listen": "127.0.0.1", "port": 0 },   // 0 = автоподбор
  "routing": {
    "final": "proxy",                                  // proxy | direct
    "rules": [ { "domainSuffix": ["ru"], "outbound": "direct" } ]
  },
  "logLevel": "info"
}
```
→ `result: { "listen": "127.0.0.1", "port": 23808, "socks": true, "http": true }`

### `stop`
`payload: {}` → `result: { stopped: true }`

### `status`
→ `result: { "running": true, "port": 23808, "uptimeSec": 42 }`

### `test`
`payload: { profile }` — валидация конфига через `sing-box check` (без запуска).
→ `result: { valid: true }` либо `ok:false, error`.

### `checkUpdate`
Спрашивает GitHub о свежем релизе sing-box. Выполняется в горутине — `ping` и
`status` продолжают отвечать; сетевые вызовы с таймаутом.
→ `result: { "current": "1.13.14", "latest": "1.13.16", "updateAvailable": true, "downloadUrl": "…" }`

### `updateCore`
Останавливает ядро, скачивает свежий релиз и атомарно заменяет `sing-box.exe`
(старый файл откладывается в `.bak` и возвращается при неудаче). Смена мажорной
версии отклоняется — она приезжает только с обновлением самого MagicProxy.
Параллельный второй запрос получает ошибку. Выполняется в горутине.
→ `result: { "updated": true, "version": "1.13.16" }`

## Схема нормализованного профиля

```jsonc
{
  "id": "uuid",
  "name": "My VLESS",
  // vless|vmess|trojan|shadowsocks|hysteria2|hysteria|tuic|anytls|wireguard|ssh|socks|http
  "type": "vless",
  "server": "example.com",
  "port": 443,

  // --- креды по типу ---
  "uuid": "…",             // vless, vmess, tuic
  "password": "…",         // trojan, shadowsocks, hysteria2, hysteria, tuic, anytls, socks/http, ssh
  "username": "…",         // socks/http, ssh (user)
  "method": "…",           // shadowsocks (напр. 2022-blake3-aes-128-gcm)
  "alterId": 0,            // vmess
  "flow": "xtls-rprx-vision", // vless
  "socksVersion": "5",     // socks: "5" (по умолчанию) | "4" | "4a"
  "privateKey": "…",       // ssh (PEM-ключ, альтернатива паролю)
  "hostKey": "…",          // ssh, ОБЯЗАТЕЛЕН: строка "ssh-ed25519 AAAA…" из
                           // ssh-keyscan; без него хост отказывает запуску
                           // (иначе MITM забирает пароль)

  // --- TLS ---
  "tls": {
    "enabled": true,
    "serverName": "example.com",
    "insecure": false,
    "alpn": ["h2", "http/1.1"],
    "utls": { "enabled": true, "fingerprint": "chrome" },
    "reality": { "enabled": true, "publicKey": "…", "shortId": "…" }
  },

  // --- транспорт (v2ray-стиль) ---
  "transport": {
    "type": "ws",          // ws|grpc|http|httpupgrade|quic|""(tcp)
    "path": "/",
    "host": "cdn.example.com",
    "serviceName": "grpcsvc",
    "headers": { }
  },

  // --- прочее ---
  "hysteria2": { "upMbps": 50, "downMbps": 200, "obfs": { "type": "salamander", "password": "…" } },
  "hysteria1": { "upMbps": 100, "downMbps": 100, "obfs": "obfs-string", "authStr": "…" },
  "tuic": { "congestionControl": "bbr", "udpRelayMode": "native" },

  // --- wireguard (эмитится как endpoint sing-box) ---
  "wireguard": {
    "privateKey": "base64…",
    "peerPublicKey": "base64…",
    "preSharedKey": "base64…",     // опционально
    "localAddress": ["10.0.0.2/32"],
    "mtu": 1408,                     // опционально
    "reserved": [0, 0, 0]            // опционально (напр. для WARP)
  },

  // --- shadowtls (маскировка; type = внутренний протокол, обычно shadowsocks) ---
  // При наличии этого поля внутренний outbound теряет server/port/tls и ходит
  // через detour на отдельный shadowtls-outbound (он держит server/port + TLS).
  "shadowtls": {
    "version": 3,                    // 1 | 2 | 3 (по умолчанию 3)
    "password": "…"                  // обязателен для v2/v3
  }
}
```

Хост транслирует это в outbound sing-box. Незнакомые/пустые поля опускаются.
