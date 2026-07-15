import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// Drive the scaffold verb through its real CLI (`node scripts/stamp.mjs`,
// spec 014 §3) against a temp copy of a minimal fixture tree, per §4. The tree
// mimics a fresh clone: the two scripts, the provenance schema, and minimal
// manifests + template.toml + README. It deliberately omits spec-spine.toml so
// the derived-regeneration step stands down (it only runs in a governed repo;
// the real E2E in §4 exercises that path against this whole repo).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const exampleCert = join(repoRoot, "scripts", "fixtures", "born-with.example.json");

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, ".stagecraft"), { recursive: true });
  cpSync(join(repoRoot, "scripts", "stamp.mjs"), join(dir, "scripts", "stamp.mjs"));
  cpSync(join(repoRoot, "scripts", "verify-born-with.mjs"), join(dir, "scripts", "verify-born-with.mjs"));
  cpSync(join(repoRoot, ".stagecraft", "born-with.schema.json"), join(dir, ".stagecraft", "born-with.schema.json"));
  cpSync(join(repoRoot, "template.toml"), join(dir, "template.toml"));
  // Both flavor directories, mimicking the chassis before pruning (spec 015).
  // A marker file in each proves the prune is recursive, not a shallow rmdir.
  mkdirSync(join(dir, "frontend"), { recursive: true });
  mkdirSync(join(dir, "frontend-react"), { recursive: true });
  writeFileSync(join(dir, "frontend", "marker.txt"), "vue flavor\n");
  writeFileSync(join(dir, "frontend-react", "marker.txt"), "react flavor\n");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "enrahitu",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "enrahitu-dev",
          "build:web": "npm --prefix frontend run build",
          "dev:web": "npm --prefix frontend run dev",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "enrahitu",
        version: "0.1.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "enrahitu", version: "0.1.0" },
          addon: { name: "@enrahitu/hiqlite-native", version: "0.1.0" },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "README.md"), "# enrahitu\n\nTemplate readme.\n");
  return dir;
}

const trees: string[] = [];
function tree(): string {
  const dir = makeTree();
  trees.push(dir);
  return dir;
}

function stamp(dir: string, args: string[]) {
  const res = spawnSync(process.execPath, [join(dir, "scripts", "stamp.mjs"), ...args], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const readJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const readText = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const dirExists = (dir: string, name: string) => existsSync(join(dir, name));

afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true });
});

const HAPPY = ["--app-name", "my-app", "--org", "acme", "--stamped-from", "a".repeat(40)];

describe("stamp: happy path", () => {
  it("substitutes the app name, places the cert, and writes the lineage marker", () => {
    const dir = tree();
    const { status, stdout } = stamp(dir, [...HAPPY, "--cert", exampleCert]);
    expect(status).toBe(0);

    expect(readJson(dir, "package.json").name).toBe("my-app");

    const readme = readText(dir, "README.md");
    expect(readme).toContain("## Stamped");
    expect(readme).toContain("- app: `my-app`");
    expect(readme).toContain("- org: `acme`");
    expect(readme).toContain(`enrahitu @ \`${"a".repeat(40)}\``);

    // The cert was placed and validated.
    expect(readJson(dir, ".stagecraft/born-with.json").app.name).toBe("example-app");
    expect(stdout).toContain("(validated)");

    // No governed corpus in the fixture, so derived regeneration stands down.
    expect(stdout).toContain("derived truth: skipped");
  });
});

describe("stamp: lockfile name sync", () => {
  it("syncs both lock name fields and leaves substrate names intact", () => {
    const dir = tree();
    expect(stamp(dir, HAPPY).status).toBe(0);

    const lock = readJson(dir, "package-lock.json");
    expect(lock.name).toBe("my-app");
    expect(lock.packages[""].name).toBe("my-app");
    // The addon crate is chassis, not the app: its name must be untouched.
    expect(lock.packages.addon.name).toBe("@enrahitu/hiqlite-native");
  });
});

describe("stamp: slot validation", () => {
  it("rejects an invalid app name and mutates nothing", () => {
    const dir = tree();
    const { status, stderr } = stamp(dir, ["--app-name", "Bad_Name", "--org", "acme"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("must match");
    // Validation is step 1, before any write: the manifest is unchanged.
    expect(readJson(dir, "package.json").name).toBe("enrahitu");
  });

  it("rejects a missing org", () => {
    const dir = tree();
    const { status, stderr } = stamp(dir, ["--app-name", "my-app"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("--org is required");
  });

  it("rejects a frontend flavor outside the allowed list", () => {
    const dir = tree();
    const { status, stderr } = stamp(dir, [...HAPPY, "--frontend", "svelte"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("allowed list");
  });
});

describe("stamp: frontend flavor selection", () => {
  it("react-rr7 prunes the vue dir and repoints build:web/dev:web at frontend-react", () => {
    const dir = tree();
    const { status, stdout } = stamp(dir, [...HAPPY, "--frontend", "react-rr7"]);
    expect(status).toBe(0);

    // The unselected flavor is gone; the selected one survives.
    expect(dirExists(dir, "frontend")).toBe(false);
    expect(dirExists(dir, "frontend-react")).toBe(true);

    // The root scripts now drive the survivor.
    const { scripts } = readJson(dir, "package.json");
    expect(scripts["build:web"]).toBe("npm --prefix frontend-react run build");
    expect(scripts["dev:web"]).toBe("npm --prefix frontend-react run dev");
    expect(stdout).toContain("frontend -> frontend-react/");
  });

  it("vue (default) prunes the react dir and leaves build:web/dev:web on frontend", () => {
    const dir = tree();
    // No --frontend flag: the default (vue) applies.
    expect(stamp(dir, HAPPY).status).toBe(0);

    expect(dirExists(dir, "frontend-react")).toBe(false);
    expect(dirExists(dir, "frontend")).toBe(true);

    const { scripts } = readJson(dir, "package.json");
    expect(scripts["build:web"]).toBe("npm --prefix frontend run build");
    expect(scripts["dev:web"]).toBe("npm --prefix frontend run dev");
  });

  it("re-stamping the same flavor is idempotent", () => {
    const dir = tree();
    expect(stamp(dir, [...HAPPY, "--frontend", "react-rr7"]).status).toBe(0);
    // Second run: the vue dir is already gone, the scripts already repointed.
    expect(stamp(dir, [...HAPPY, "--frontend", "react-rr7"]).status).toBe(0);

    expect(dirExists(dir, "frontend")).toBe(false);
    expect(dirExists(dir, "frontend-react")).toBe(true);
    expect(readJson(dir, "package.json").scripts["build:web"]).toBe(
      "npm --prefix frontend-react run build",
    );
  });
});

describe("stamp: idempotent re-run", () => {
  it("re-running with the same slots exits 0 and leaves exactly one Stamped section", () => {
    const dir = tree();
    expect(stamp(dir, HAPPY).status).toBe(0);
    expect(stamp(dir, HAPPY).status).toBe(0);

    expect(readJson(dir, "package.json").name).toBe("my-app");
    const occurrences = readText(dir, "README.md").match(/^## Stamped$/gm) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});

describe("stamp: failing cert", () => {
  it("fails the stamp and rolls back the placed cert", () => {
    const dir = tree();
    const bad = JSON.parse(readFileSync(exampleCert, "utf8"));
    bad.agenticPostureBinding.posture = "supervised"; // not in the closed posture set
    const badPath = join(dir, "bad-cert.json");
    writeFileSync(badPath, JSON.stringify(bad));

    const { status, stderr } = stamp(dir, [...HAPPY, "--cert", badPath]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("cert failed validation");
    // The rejected cert was rolled back, not left on disk.
    expect(() => readJson(dir, ".stagecraft/born-with.json")).toThrow();
  });
});
