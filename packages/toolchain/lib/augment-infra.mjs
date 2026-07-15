/**
 * Merge a base Encore infra config with the hosted services/gateways
 * discovered by the compile step, exactly as `encore build docker` does when
 * it writes the image's /encore/infra.config.json. Without hosted_services /
 * hosted_gateways the runtime hosts nothing ("no api server or gateway to
 * serve").
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function augmentInfraConfig(baseInfraPath, compileResultPath, outPath) {
  const compileResult = JSON.parse(readFileSync(compileResultPath, "utf8"));
  const entrypoint = compileResult.outputs[0].entrypoints[0];
  const infra = JSON.parse(readFileSync(baseInfraPath, "utf8"));
  infra.hosted_services = entrypoint.services;
  infra.hosted_gateways = entrypoint.gateways;
  infra.cors ??= {};
  writeFileSync(outPath, JSON.stringify(infra, null, 2));
  return infra;
}

// CLI form (used by scripts/docker-build.sh inside the image worktree):
//   node augment-infra.mjs <base-infra.json> <compile-result.json> <out.json>
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, compileResult, out] = process.argv.slice(2);
  if (!base || !compileResult || !out) {
    console.error("usage: augment-infra.mjs <base-infra.json> <compile-result.json> <out.json>");
    process.exit(1);
  }
  augmentInfraConfig(base, compileResult, out);
  console.log(`[augment-infra] ${out}`);
}
