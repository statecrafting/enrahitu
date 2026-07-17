//! enrahitu's in-process hiqlite capability.
//!
//! hiqlite runs INSIDE the Encore.ts Node process on this addon's own tokio
//! runtime (napi-rs `tokio_rt` feature). Encore's Rust runtime lives in a
//! separate dylib (`encore-runtime.node`); the two runtimes coexist in one
//! process. This was proven end to end by the template-encore Shape A spike
//! (statecrafting/template-encore PR #40) and hardened here:
//!
//! - config comes from `ENRAHITU_HIQ_*` env vars instead of hardcoded values
//! - the data dir persists across restarts (the spike wiped a temp dir)
//! - `init()` is exported so the app pays raft election at boot, not on the
//!   first request (spike caveat #5)
//!
//! Surface (v0): cache/KV with per-key TTL + raft-replicated counters.
//! Single-node by default; the same knobs cover a future clustered deployment.

use hiqlite::macros::CacheVariants;
use hiqlite::{Client, Node, NodeConfig};
use napi_derive::napi;
use tokio::sync::OnceCell;

/// One logical cache per concern: plain KV entries and monotonic counters
/// live in separate hiqlite cache indexes so their key spaces never collide.
#[derive(Debug, CacheVariants)]
enum Cache {
    Kv,
    Counters,
}

/// The embedded hiqlite client, started once and kept for the process
/// lifetime. Its raft/API servers run as background tasks on the addon's
/// tokio runtime.
static CLIENT: OnceCell<Client> = OnceCell::const_new();

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn hql_err(ctx: &str, e: hiqlite::Error) -> napi::Error {
    napi::Error::from_reason(format!("hiqlite {ctx} failed: {e}"))
}

/// Start (or return) the single-node hiqlite instance, bound to loopback.
///
/// Env knobs (all optional in dev):
/// - `ENRAHITU_HIQ_DATA_DIR`    raft WAL + snapshot dir (default `./.data/hiqlite`)
/// - `ENRAHITU_HIQ_NODE_ID`     numeric node id (default `1`)
/// - `ENRAHITU_HIQ_ADDR_RAFT`   raft listener (default `127.0.0.1:8100`)
/// - `ENRAHITU_HIQ_ADDR_API`    api listener (default `127.0.0.1:8200`)
/// - `ENRAHITU_HIQ_SECRET_RAFT` / `ENRAHITU_HIQ_SECRET_API`
///   listener auth secrets, >= 16 chars (dev defaults are fine on loopback;
///   the container entrypoint sets real ones in production)
async fn client() -> napi::Result<&'static Client> {
    CLIENT
        .get_or_try_init(|| async {
            let data_dir = env_or("ENRAHITU_HIQ_DATA_DIR", "./.data/hiqlite");
            std::fs::create_dir_all(&data_dir).map_err(|e| {
                napi::Error::from_reason(format!("hiqlite data dir {data_dir}: {e}"))
            })?;

            let node_id: u64 = env_or("ENRAHITU_HIQ_NODE_ID", "1")
                .parse()
                .map_err(|e| napi::Error::from_reason(format!("ENRAHITU_HIQ_NODE_ID: {e}")))?;

            let config = NodeConfig {
                node_id,
                nodes: vec![Node {
                    id: node_id,
                    addr_raft: env_or("ENRAHITU_HIQ_ADDR_RAFT", "127.0.0.1:8100"),
                    addr_api: env_or("ENRAHITU_HIQ_ADDR_API", "127.0.0.1:8200"),
                }],
                data_dir: data_dir.into(),
                secret_raft: env_or("ENRAHITU_HIQ_SECRET_RAFT", "enrahitu-dev-raft-secret"),
                secret_api: env_or("ENRAHITU_HIQ_SECRET_API", "enrahitu-dev-api-secret"),
                log_statements: false,
                ..NodeConfig::default()
            };

            hiqlite::start_node_with_cache::<Cache>(config)
                .await
                .map_err(|e| hql_err("init", e))
        })
        .await
}

/// Start the embedded hiqlite node (idempotent). Call once at service init.
#[napi]
pub async fn init() -> napi::Result<()> {
    client().await?;
    Ok(())
}

/// Confirms the addon is loaded and hiqlite is up inside this process.
#[napi]
pub async fn health() -> napi::Result<String> {
    client().await?;
    Ok("ok".to_string())
}

/// Store a string value under `key`, with an optional TTL in seconds.
#[napi]
pub async fn kv_put(key: String, value: String, ttl_secs: Option<i64>) -> napi::Result<()> {
    client()
        .await?
        .put(Cache::Kv, key, &value, ttl_secs)
        .await
        .map_err(|e| hql_err("kv_put", e))
}

/// Read the string value stored under `key`, or `null` if absent/expired.
#[napi]
pub async fn kv_get(key: String) -> napi::Result<Option<String>> {
    client()
        .await?
        .get::<Cache, String, String>(Cache::Kv, key)
        .await
        .map_err(|e| hql_err("kv_get", e))
}

/// Delete the value stored under `key` (no-op if absent).
#[napi]
pub async fn kv_del(key: String) -> napi::Result<()> {
    client()
        .await?
        .delete(Cache::Kv, key)
        .await
        .map_err(|e| hql_err("kv_del", e))
}

/// Add `delta` to the counter under `key` and return the new value.
/// Counters are raft-replicated and atomic; this is the rate-limit primitive.
#[napi]
pub async fn counter_add(key: String, delta: i64) -> napi::Result<i64> {
    client()
        .await?
        .counter_add(Cache::Counters, key, delta)
        .await
        .map_err(|e| hql_err("counter_add", e))
}

/// Read the counter under `key`, or `null` if it was never set.
#[napi]
pub async fn counter_get(key: String) -> napi::Result<Option<i64>> {
    client()
        .await?
        .counter_get(Cache::Counters, key)
        .await
        .map_err(|e| hql_err("counter_get", e))
}

/// Set the counter under `key` to a fixed value.
#[napi]
pub async fn counter_set(key: String, value: i64) -> napi::Result<()> {
    client()
        .await?
        .counter_set(Cache::Counters, key, value)
        .await
        .map_err(|e| hql_err("counter_set", e))
}

/// Delete the counter under `key`, freeing its memory.
#[napi]
pub async fn counter_del(key: String) -> napi::Result<()> {
    client()
        .await?
        .counter_del(Cache::Counters, key)
        .await
        .map_err(|e| hql_err("counter_del", e))
}
