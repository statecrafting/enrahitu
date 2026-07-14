#!/usr/bin/env node
// Copies the DEV-ONLY rauthy client secret from the committed bootstrap file
// into keys/rauthy-client-secret (gitignored), where lib/secrets.ts picks it
// up as the dev fallback for the RAUTHY_CLIENT_SECRET Encore secret.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clients = JSON.parse(
  readFileSync(join(root, "docker", "rauthy", "bootstrap", "clients.json"), "utf8"),
);
const enrahitu = clients.find((c) => c.id === "enrahitu");
const secret = enrahitu?.secret?.Plain;
if (!secret) {
  console.error("no Plain secret for client 'enrahitu' in docker/rauthy/bootstrap/clients.json");
  process.exit(1);
}
mkdirSync(join(root, "keys"), { recursive: true });
writeFileSync(join(root, "keys", "rauthy-client-secret"), secret, { mode: 0o600 });
console.log("wrote keys/rauthy-client-secret (dev fallback for RAUTHY_CLIENT_SECRET)");
