#!/usr/bin/env node
/**
 * Idempotent first-boot provisioning for the enrahitu container. Everything
 * lands under the /data volume; existing material is never overwritten, so
 * restarts and upgrades keep their identity.
 *
 * Generates (first boot only):
 * - RS256 JWT keypairs (access + refresh) -> /data/keys/*.pem
 * - the rauthy OIDC client secret         -> /data/keys/rauthy-client-secret
 * - the rauthy admin bootstrap password   -> /data/rauthy/admin-password
 * - rauthy runtime secrets (enc keys, hiqlite raft/api) and the app's own
 *   hiqlite secrets                       -> /data/rauthy/secrets.env
 * - the declarative rauthy client bootstrap (redirect URIs derived from
 *   ENRAHITU_PUBLIC_URL)                    -> /data/rauthy/bootstrap/clients.json
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.ENRAHITU_DATA_DIR ?? "/data";
const PUBLIC_URL = (process.env.ENRAHITU_PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, "");

const keysDir = join(DATA, "keys");
const rauthyDir = join(DATA, "rauthy");
const bootstrapDir = join(rauthyDir, "bootstrap");
for (const dir of [
  join(DATA, "ledger"),
  join(DATA, "hiqlite"),
  keysDir,
  rauthyDir,
  join(rauthyDir, "db"),
  bootstrapDir,
]) {
  mkdirSync(dir, { recursive: true });
}

/** Alphanumeric secret of exactly `length` chars (rauthy validates charset). */
function alnum(length) {
  let out = "";
  while (out.length < length) {
    out += randomBytes(48).toString("base64").replace(/[+/=]/g, "");
  }
  return out.slice(0, length);
}

function writeOnce(path, value, mode = 0o600) {
  if (existsSync(path)) return false;
  writeFileSync(path, value, { mode });
  return true;
}

// --- JWT signing keys (same shape as scripts/generate-keys.ts) -------------
for (const prefix of ["access", "refresh"]) {
  const priv = join(keysDir, `${prefix}-private.pem`);
  const pub = join(keysDir, `${prefix}-public.pem`);
  if (existsSync(priv) && existsSync(pub)) continue;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(priv, privateKey, { mode: 0o600 });
  writeFileSync(pub, publicKey, { mode: 0o644 });
  console.log(`[first-boot] generated ${prefix} RS256 keypair`);
}

// --- rauthy OIDC client secret (shared: rauthy bootstrap + app env) --------
const clientSecretPath = join(keysDir, "rauthy-client-secret");
if (writeOnce(clientSecretPath, alnum(64))) {
  console.log("[first-boot] generated rauthy client secret");
}
const clientSecret = readFileSync(clientSecretPath, "utf8").trim();

// --- rauthy admin bootstrap password ---------------------------------------
const adminPasswordPath = join(rauthyDir, "admin-password");
if (writeOnce(adminPasswordPath, alnum(24))) {
  console.log(
    `[first-boot] rauthy admin: ${process.env.ENRAHITU_ADMIN_EMAIL ?? "admin@example.com"} ` +
      `(password stored at ${adminPasswordPath})`,
  );
}

// --- runtime secrets sourced by the entrypoint ------------------------------
const secretsEnvPath = join(rauthyDir, "secrets.env");
if (!existsSync(secretsEnvPath)) {
  const encKeyId = `enrahitu${alnum(6)}`;
  const lines = [
    `RAUTHY_ENC_KEYS='${encKeyId}/${randomBytes(32).toString("base64")}'`,
    `RAUTHY_ENC_KEY_ACTIVE='${encKeyId}'`,
    `RAUTHY_HQL_SECRET_RAFT='${alnum(32)}'`,
    `RAUTHY_HQL_SECRET_API='${alnum(32)}'`,
    `ENRAHITU_HIQ_SECRET_RAFT='${alnum(32)}'`,
    `ENRAHITU_HIQ_SECRET_API='${alnum(32)}'`,
  ];
  writeFileSync(secretsEnvPath, lines.join("\n") + "\n", { mode: 0o600 });
  console.log("[first-boot] generated runtime secrets");
}
chmodSync(secretsEnvPath, 0o600);

// --- declarative rauthy client bootstrap ------------------------------------
// Applied by rauthy only while its database is uninitialized, so writing it
// on every boot is harmless; deriving it from ENRAHITU_PUBLIC_URL keeps first
// boot and config in one place.
const clients = [
  {
    id: "enrahitu",
    name: "enrahitu",
    secret: { Plain: clientSecret },
    redirect_uris: [`${PUBLIC_URL}/api/v1/auth/rauthy/callback`],
    post_logout_redirect_uris: [`${PUBLIC_URL}/`],
    allowed_origins: [PUBLIC_URL],
    enabled: true,
    flows_enabled: ["authorization_code", "refresh_token"],
    access_token_alg: "RS256",
    id_token_alg: "RS256",
    auth_code_lifetime: 60,
    access_token_lifetime: 1800,
    scopes: ["openid", "email", "profile", "groups"],
    default_scopes: ["openid"],
    challenges: ["S256"],
    force_mfa: false,
  },
];
writeFileSync(join(bootstrapDir, "clients.json"), JSON.stringify(clients, null, 2), {
  mode: 0o600,
});

console.log("[first-boot] ready");
