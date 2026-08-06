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
 *   hiqlite secrets (raft/api + its own
 *   encryption key set)                   -> /data/rauthy/secrets.env
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
//
// **The app's hiqlite gets an encryption key of its own** (spec 027 §4 item 5,
// resolved 2026-08-06). Until this line existed the file provisioned rauthy's
// `ENC_KEYS`, both nodes' raft/API secrets, and no encryption key for the app's
// node, so the addon fell back to its publicly-known development key and warned
// on every boot. That was proven rather than inferred: a cold archive restored
// into a fresh volume with all key material deleted served every member, because
// the key that would have stopped it was never one this substrate generated.
// Since the app's node encrypts its backup snapshots with it, every cell was
// writing snapshots anyone could decrypt.
//
// It is a SEPARATE key set from rauthy's rather than a shared one. Spec 032
// reads "a deployment custodies one key set for both hiqlite instances", and
// what that requirement is actually about is custody: one file to hold, one
// archive to keep, which is equally true either way because both live here and
// spec 027 §3.1 puts the whole file in every archive. Sharing the bytes would
// buy nothing and would mean one compromised key set decrypts both the identity
// store and the resource store. Every other secret in this file is already
// generated per store, and the entrypoint hands each store only its own.
const secretsEnvPath = join(rauthyDir, "secrets.env");
if (!existsSync(secretsEnvPath)) {
  const rauthyEncKeyId = `enrahitu${alnum(6)}`;
  const hiqEncKeyId = `enrahitu${alnum(6)}`;
  const lines = [
    `RAUTHY_ENC_KEYS='${rauthyEncKeyId}/${randomBytes(32).toString("base64")}'`,
    `RAUTHY_ENC_KEY_ACTIVE='${rauthyEncKeyId}'`,
    `RAUTHY_HQL_SECRET_RAFT='${alnum(32)}'`,
    `RAUTHY_HQL_SECRET_API='${alnum(32)}'`,
    `ENRAHITU_HIQ_SECRET_RAFT='${alnum(32)}'`,
    `ENRAHITU_HIQ_SECRET_API='${alnum(32)}'`,
    `ENRAHITU_HIQ_ENC_KEYS='${hiqEncKeyId}/${randomBytes(32).toString("base64")}'`,
    `ENRAHITU_HIQ_ENC_KEY_ACTIVE='${hiqEncKeyId}'`,
  ];
  writeFileSync(secretsEnvPath, lines.join("\n") + "\n", { mode: 0o600 });
  console.log("[first-boot] generated runtime secrets");
}
chmodSync(secretsEnvPath, 0o600);

// A volume provisioned before that key existed is named, not migrated.
//
// This file is write-once by design, so the block above does not run again and
// the key is not added retroactively. Generating one here and activating it
// would make every snapshot the node has already written undecryptable, since
// the key those were encrypted under is the addon's fallback and not one this
// volume records; retaining that fallback as a non-active key would mean
// committing a publicly-known key to the repository. Neither is worth doing for
// a volume shape that predates the first release, so the case is reported and
// the operator re-provisions. The addon's own boot warning says the same thing
// less specifically; this one names the cause and the remedy.
if (!readFileSync(secretsEnvPath, "utf8").includes("ENRAHITU_HIQ_ENC_KEYS=")) {
  console.log(
    "[first-boot] this volume's secrets.env predates app hiqlite encryption keys, so the\n" +
      "             app's node will run on the addon's PUBLIC development key and its backup\n" +
      "             snapshots will be decryptable by anyone. Provisioning is write-once and\n" +
      "             a key added now could not decrypt what is already written. Start from a\n" +
      "             fresh volume and restore into it.",
  );
}

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

// --- restore, made single-shot and per-store (spec 033 §3.5, spec 027 §3.3) --
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
//
// **One variable, two nodes** (spec 027 §3.3). `HQL_BACKUP_RESTORE` is
// hiqlite's name, not rauthy's, and this container runs two independent hiqlite
// nodes with two unrelated state machines: rauthy's identity store and the
// app's resource store. A single ambient value naming a single file is read by
// both, and whichever node it was not meant for either refuses the file or,
// worse, accepts it. That was harmless only while the app's store held nothing
// worth restoring, which stopped being true three phases ago.
//
// The fix is the shape spec 037 §3.1 already used for mail credentials: each
// store gets its own operator-facing variable, and the entrypoint scopes each
// into exactly the subshell that should act on it. rauthy's node is offered
// rauthy's snapshot, the app's node is offered the app's, and neither can see
// the other's.
const restoreMarkerPath = join(DATA, "restore-applied.json");
const restoreEnvPath = join(DATA, "restore.env");

/**
 * The two stores, each with the variable an operator sets for it.
 *
 * `scoped` is the name written into restore.env. The entrypoint maps it onto
 * hiqlite's own HQL_BACKUP_RESTORE inside the owning process's subshell, which
 * is what keeps one node from ever seeing the other's file.
 */
const RESTORE_STORES = [
  { key: "rauthy", env: "ENRAHITU_RESTORE_RAUTHY", scoped: "ENRAHITU_RESTORE_RAUTHY", label: "rauthy's identity store" },
  { key: "app", env: "ENRAHITU_RESTORE_APP", scoped: "ENRAHITU_RESTORE_APP", label: "the app's resource store" },
];

let restoreMarker = {};
if (existsSync(restoreMarkerPath)) {
  try {
    restoreMarker = JSON.parse(readFileSync(restoreMarkerPath, "utf8"));
  } catch {
    // An unreadable marker is treated as absent. The alternative is refusing
    // to boot over a corrupt bookkeeping file, which is a worse failure than
    // re-applying a restore the operator explicitly asked for.
    restoreMarker = {};
  }
}

// A marker written before the split recorded one decision for one ambient
// variable, so it cannot say which store was restored. It is carried forward
// untouched rather than interpreted: guessing which node it meant is the exact
// ambiguity this change exists to end.
if (typeof restoreMarker.backup === "string") {
  restoreMarker = { legacy: restoreMarker };
}

const restoreLines = [];
let restoreMarkerChanged = false;

for (const store of RESTORE_STORES) {
  const request = (process.env[store.env] ?? "").trim();
  if (!request) {
    // No request this boot: make sure a stale decision from a previous boot
    // cannot leak into this one.
    restoreLines.push(`unset ${store.scoped}`);
    continue;
  }
  const applied = restoreMarker[store.key] ?? null;
  if (applied?.backup === request) {
    restoreLines.push(`unset ${store.scoped}`);
    console.log(
      `[first-boot] ${store.env} is still set to "${request}", already applied at ` +
        `${applied.appliedAt}; ignoring it. Delete ${restoreMarkerPath} to force a re-restore.`,
    );
    continue;
  }
  restoreMarker[store.key] = {
    backup: request,
    appliedAt: new Date().toISOString(),
    previous: applied,
  };
  restoreMarkerChanged = true;
  // Single-quoted and escaped: a backup identifier is operator-supplied and
  // this file is sourced by bash.
  const quoted = `'${request.replace(/'/g, `'\\''`)}'`;
  restoreLines.push(`export ${store.scoped}=${quoted}`);
  console.log(
    `[first-boot] restore requested for ${store.label} from "${request}"; recorded at ` +
      `${restoreMarkerPath}. It will not be applied again on the next restart.`,
  );
}

if (restoreMarkerChanged) {
  writeFileSync(restoreMarkerPath, JSON.stringify(restoreMarker, null, 2), { mode: 0o600 });
}
writeFileSync(restoreEnvPath, restoreLines.join("\n") + "\n", { mode: 0o600 });

// An ambient HQL_BACKUP_RESTORE is named and ignored, never guessed at.
//
// It is not honoured for either store, because honouring it would require
// choosing one, and choosing wrong offers rauthy's snapshot to the app's node.
// It is not a boot failure either: the variable is hiqlite's own name, so an
// orchestrator exporting it for some other workload would otherwise take this
// container down. The entrypoint scrubs it so neither node inherits it; this
// line is what stops that scrub from being silent.
if ((process.env.HQL_BACKUP_RESTORE ?? "").trim()) {
  console.log(
    "[first-boot] HQL_BACKUP_RESTORE is set and is being ignored: this container runs two\n" +
      "             hiqlite nodes and the variable names only one file. Set\n" +
      "             ENRAHITU_RESTORE_RAUTHY for the identity store or ENRAHITU_RESTORE_APP\n" +
      "             for the app's resource store.",
  );
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
