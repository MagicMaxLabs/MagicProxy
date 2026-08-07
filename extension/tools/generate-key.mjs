// Generates a stable extension key so the unpacked extension always gets the
// SAME extension ID regardless of who loads it or from where. This is what lets
// the installer hardcode allowed_origins (no per-user ID lookup).
//
// Outputs:
//   - keys/magicproxy.pem        (PRIVATE key — keep secret, git-ignored)
//   - the base64 "key" for manifest.json
//   - the derived extension ID
//
// Run once: node extension/tools/generate-key.mjs
// Re-running rotates the ID; only do that intentionally.
import {
  generateKeyPairSync,
  createPublicKey,
  createHash,
} from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keysDir = join(root, "keys");
const pemPath = join(keysDir, "magicproxy.pem");

if (existsSync(pemPath)) {
  console.error(`Refusing to overwrite existing private key: ${pemPath}`);
  console.error("Delete it manually if you really want to rotate the extension ID.");
  process.exit(1);
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });

// SPKI DER of the public key — this exact bytestring is what Chrome hashes.
const spkiDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const keyB64 = spkiDer.toString("base64");

// Extension ID = first 16 bytes of SHA256(spkiDer), each hex nibble mapped 0-f -> a-p.
const hash = createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

mkdirSync(keysDir, { recursive: true });
writeFileSync(pemPath, pem);

console.log("Private key written to:", pemPath);
console.log("\n--- manifest.json \"key\" ---\n" + keyB64);
console.log("\n--- extension ID ---\n" + id + "\n");
