// Plain-Node round-trip check for the addon, no Encore involved.
// Usage: node sanity.mjs   (from addon/, after `npm run build`)
import hiqlite from "./index.js";

const t0 = Date.now();
await hiqlite.init();
console.log(`init: ok in ${Date.now() - t0}ms`);
console.log("health:", await hiqlite.health());

await hiqlite.kvPut("spike", "through plain node -> napi -> hiqlite", null);
console.log("kvGet(spike):", await hiqlite.kvGet("spike"));
console.log("kvGet(absent):", await hiqlite.kvGet("absent"));

await hiqlite.kvPut("ttl", "expires fast", 1);
console.log("kvGet(ttl) fresh:", await hiqlite.kvGet("ttl"));
await new Promise((r) => setTimeout(r, 1500));
console.log("kvGet(ttl) after 1.5s:", await hiqlite.kvGet("ttl"));

console.log("counterAdd(hits, 1):", await hiqlite.counterAdd("hits", 1));
console.log("counterAdd(hits, 41):", await hiqlite.counterAdd("hits", 41));
console.log("counterGet(hits):", await hiqlite.counterGet("hits"));
await hiqlite.counterDel("hits");
console.log("counterGet(hits) after del:", await hiqlite.counterGet("hits"));

console.log("sanity: PASS");
process.exit(0);
