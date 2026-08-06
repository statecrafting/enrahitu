/**
 * The operator manual's variable table cannot silently rot (spec 028 §4 item 1).
 *
 * `docs/OPERATIONS.md` documents every `ENRAHITU_*` variable an operator can
 * set. A table maintained by hand drifts the moment someone adds a variable and
 * documents it nowhere, and the drift is invisible: the manual still reads as
 * complete. So the names are enumerated from source and checked against the
 * table rather than trusted.
 *
 * §4 item 1 names three sources. `backend/lib/client-identity.ts` is added as a
 * fourth because §3.1 requires `ENRAHITU_TRUSTED_PROXY_HOPS` documented and that
 * is the only file it appears in: a check that omitted it would pass while the
 * one variable the TLS section turns on went undocumented.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANUAL = join(ROOT, "docs", "OPERATIONS.md");

const SOURCES = [
  "docker/entrypoint.sh",
  "docker/first-boot.mjs",
  "backend/lib/env.ts",
  "backend/lib/client-identity.ts",
];

/**
 * Names that appear in source as a bash prefix expansion (`${!ENRAHITU_SMTP_*}`)
 * rather than as a variable. They are the scrub loops, so the token captured is
 * the prefix itself and there is nothing for the table to document.
 */
const PREFIX_TOKENS = new Set([
  "ENRAHITU_HIQ_",
  "ENRAHITU_MAIL_",
  "ENRAHITU_SMTP_",
  "ENRAHITU_RESTORE_",
]);

function declaredNames(): string[] {
  const found = new Set<string>();
  for (const rel of SOURCES) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const match of text.matchAll(/ENRAHITU_[A-Z0-9_]+/g)) {
      if (!PREFIX_TOKENS.has(match[0])) found.add(match[0]);
    }
  }
  return [...found].sort();
}

describe("docs/OPERATIONS.md: the variable table covers what the code reads", () => {
  it("documents every ENRAHITU_* name the substrate reads", () => {
    const manual = readFileSync(MANUAL, "utf8");
    const undocumented = declaredNames().filter((name) => !manual.includes(`\`${name}\``));
    // Named rather than counted: the failure has to say which variable, or the
    // person who added one learns only that something is missing.
    expect(undocumented).toEqual([]);
  });

  it("enumerates a plausible number of names, so a broken regex fails loudly", () => {
    // A source rename or a regex mistake would make the check above pass over
    // an empty set and report success for a manual documenting nothing.
    expect(declaredNames().length).toBeGreaterThan(15);
  });

  it("covers every section §3.1 requires", () => {
    const manual = readFileSync(MANUAL, "utf8");
    for (const heading of [
      "## 1. Install",
      "## 2. Put it behind TLS",
      "## 3. Wire the probes",
      "## 4. Scrape the metrics",
      "## 5. Configure mail",
      "## 6. Back up and restore",
      "## 7. Upgrade",
      "## 8. Size it",
      "## 9. Troubleshoot",
    ]) {
      expect(manual).toContain(heading);
    }
  });

  it("marks each secret-bearing variable as a secret", () => {
    // An operator who cannot tell which values are credentials will put one in
    // a plain manifest. These are the ones that decrypt data or authenticate.
    const manual = readFileSync(MANUAL, "utf8");
    for (const name of [
      "ENRAHITU_METRICS_TOKEN",
      "ENRAHITU_SMTP_PASSWORD",
      "ENRAHITU_MAIL_PASSWORD",
      "ENRAHITU_HIQ_ENC_KEYS",
      "ENRAHITU_HIQ_SECRET_RAFT",
      "ENRAHITU_HIQ_SECRET_API",
    ]) {
      const row = manual.split("\n").find((l) => l.includes(`\`${name}\``) && l.startsWith("|"));
      expect(row, `${name} has no table row`).toBeDefined();
      expect(row, `${name} is not marked as a secret`).toContain("**yes**");
    }
  });
});
