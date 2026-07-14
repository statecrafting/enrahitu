/**
 * Generates the RS256 keypairs used to sign access and refresh tokens.
 * Writes PEM files into keys/ (gitignored). Run via `npm run generate-keys`.
 *
 * For non-dev environments, set the matching Encore secrets from these PEM
 * files (JWT_PRIVATE_KEY / JWT_PUBLIC_KEY / JWT_REFRESH_PRIVATE_KEY /
 * JWT_REFRESH_PUBLIC_KEY) rather than shipping key files.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const keysDir = join(dirname(fileURLToPath(import.meta.url)), "..", "keys");

function writePair(prefix: string): void {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(join(keysDir, `${prefix}-private.pem`), privateKey, { mode: 0o600 });
  writeFileSync(join(keysDir, `${prefix}-public.pem`), publicKey, { mode: 0o644 });
  console.log(`wrote ${prefix}-private.pem and ${prefix}-public.pem`);
}

mkdirSync(keysDir, { recursive: true });
writePair("access");
writePair("refresh");
console.log("done: RS256 access + refresh keypairs written to keys/");
