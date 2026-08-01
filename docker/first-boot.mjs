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

// --- /metrics bearer token (spec 025 §3.4) ----------------------------------
// Provisioned like every other secret, so the packaged image is authenticated
// by default rather than opt-in. The endpoint stays always-on and unflagged
// (spec 022): this authenticates it, it does not gate it off. An operator
// reads the token out of the volume to configure a scraper.
const metricsTokenPath = join(keysDir, "metrics-token");
if (writeOnce(metricsTokenPath, alnum(48))) {
  console.log(`[first-boot] generated /metrics bearer token (stored at ${metricsTokenPath})`);
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

// --- restore, made single-shot (spec 033 §3.5, spec 032 §3.9) ---------------
//
// hiqlite restores a backup at boot when HQL_BACKUP_RESTORE is set, BEFORE the
// raft node starts, and its own documentation says to remove the value after
// the restart. That instruction is a runbook step standing between a tenant and
// their data: left set in a container with a restart policy, the backup is
// re-applied on EVERY restart and everything written since is discarded. A
// crash loop then becomes silent, repeated data loss, and the operator sees a
// container that keeps restarting rather than one that keeps deleting.
//
// So it is designed out rather than documented around. The value the operator
// set is recorded in a marker on the volume the first time it is honoured;
// subsequent boots see the marker, unset the variable for the child processes,
// and say so. The operator sets it once and may leave it set forever.
//
// Changing the variable to a DIFFERENT backup is a new restore and is honoured:
// the marker records which backup was applied, not merely that one was.
// This runs as its own process, so it cannot unset a variable in the
// entrypoint's shell. It therefore writes its decision to restore.env, which
// the entrypoint sources before starting either supervised process, exactly
// the handshake already used for secrets.env. Keeping the decision in one
// place (here) and the application in one place (the entrypoint) is what
// stops the two from drifting into disagreement.
const restoreRequest = (process.env.HQL_BACKUP_RESTORE ?? "").trim();
const restoreMarkerPath = join(DATA, "restore-applied.json");
const restoreEnvPath = join(DATA, "restore.env");

if (restoreRequest) {
  let applied = null;
  if (existsSync(restoreMarkerPath)) {
    try {
      applied = JSON.parse(readFileSync(restoreMarkerPath, "utf8"));
    } catch {
      // An unreadable marker is treated as absent. The alternative is refusing
      // to boot over a corrupt bookkeeping file, which is a worse failure than
      // re-applying a restore the operator explicitly asked for.
      applied = null;
    }
  }

  if (applied?.backup === restoreRequest) {
    writeFileSync(restoreEnvPath, "unset HQL_BACKUP_RESTORE\n", { mode: 0o600 });
    console.log(
      `[first-boot] HQL_BACKUP_RESTORE is still set to "${restoreRequest}", already applied at ` +
        `${applied.appliedAt}; ignoring it. Delete ${restoreMarkerPath} to force a re-restore.`,
    );
  } else {
    writeFileSync(
      restoreMarkerPath,
      JSON.stringify(
        { backup: restoreRequest, appliedAt: new Date().toISOString(), previous: applied },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    // Single-quoted and escaped: a backup identifier is operator-supplied and
    // this file is sourced by bash.
    const quoted = `'${restoreRequest.replace(/'/g, `'\\''`)}'`;
    writeFileSync(restoreEnvPath, `export HQL_BACKUP_RESTORE=${quoted}\n`, { mode: 0o600 });
    console.log(
      `[first-boot] restore requested from "${restoreRequest}"; recorded at ${restoreMarkerPath}. ` +
        `It will not be applied again on the next restart.`,
    );
  }
} else {
  // No request this boot: make sure a stale decision from a previous boot
  // cannot leak into this one.
  writeFileSync(restoreEnvPath, "unset HQL_BACKUP_RESTORE\n", { mode: 0o600 });
}

// --- mail, stated rather than silent (spec 026 §3.2) ------------------------
//
// rauthy treats mail as optional and degrades quietly, so nothing fails loudly
// and every flow that depends on delivery becomes a dead end at the moment a
// user needs it most: a forgotten password on the one account this file
// bootstrapped, a new user who can never verify an address, an operator who
// cannot invite a colleague.
//
// This is a notice and not a failure. A local trial of the packaged image must
// keep working with no mail server. A fleet that wants SMTP to be mandatory has
// ENRAHITU_REQUIRED_ENV (spec 007) already: adding ENRAHITU_SMTP_URL to it turns
// this notice into a hard pre-flight failure without this file deciding the
// policy for everyone.
if (!process.env.ENRAHITU_SMTP_URL) {
  console.log(
    "[first-boot] no ENRAHITU_SMTP_URL: password reset, email verification,\n" +
      "             registration, and invitation will not deliver. The\n" +
      "             bootstrapped admin is the only usable account.",
  );
}

console.log("[first-boot] ready");
