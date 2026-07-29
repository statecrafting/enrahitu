#!/bin/bash
# enrahitu single-container entrypoint: rauthy (loopback :8081) + the Encore app
# (:8080, which proxies /auth/* to rauthy). Die-together supervision: if either
# process exits, the container exits and the restart policy recovers it.
set -euo pipefail

DATA="${ENRAHITU_DATA_DIR:-/data}"
PUBLIC_URL="${ENRAHITU_PUBLIC_URL:-http://localhost:8080}"
PUBLIC_URL="${PUBLIC_URL%/}"

# Fleet-declared pre-flight (spec 007, amendment 2026-07-23): every name in
# ENRAHITU_REQUIRED_ENV (comma- or space-separated) must be set and non-empty
# before anything starts; all missing names report together, one failure.
if [ -n "${ENRAHITU_REQUIRED_ENV:-}" ]; then
  missing=""
  for name in ${ENRAHITU_REQUIRED_ENV//,/ }; do
    if [ -z "${!name:-}" ]; then
      missing="$missing $name"
    fi
  done
  if [ -n "$missing" ]; then
    echo "[entrypoint] required env not set or empty:$missing" >&2
    exit 1
  fi
fi

node /enrahitu/first-boot.mjs

# secrets.env carries RAUTHY_-prefixed material for the rauthy process and
# ENRAHITU_HIQ_* for the app; written by first-boot.mjs, chmod 0600.
# shellcheck disable=SC1091
. "$DATA/rauthy/secrets.env"

# restore.env carries first-boot's single-shot restore decision (spec 033 §3.5).
# hiqlite applies HQL_BACKUP_RESTORE at boot before the raft node starts, and
# left set in a container with a restart policy it re-applies on EVERY restart,
# discarding everything written since: a crash loop becomes silent, repeated
# data loss. first-boot.mjs records which backup it honoured and writes either
# an export or an unset here, so the operator may set the variable once and
# leave it set. Sourced before either supervised process starts, because both
# hiqlite instances would otherwise inherit it.
# shellcheck disable=SC1091
. "$DATA/restore.env"

proto="${PUBLIC_URL%%://*}"
hostport="${PUBLIC_URL#*://}"
hostport="${hostport%%/*}"
host="${hostport%%:*}"

# ---------------------------------------------------------------------------
# rauthy: bound to loopback, reachable only through the app's /auth proxy.
# Env is scoped to the subshell so nothing leaks into the app process.
# ---------------------------------------------------------------------------
(
  export LISTEN_ADDRESS=127.0.0.1
  export LISTEN_PORT_HTTP=8081
  export LISTEN_SCHEME=http
  export PUB_URL="$hostport"
  if [ "$proto" = "https" ]; then
    # Behind the app proxy + external TLS termination; rauthy then mints
    # https URLs (its issuer-scheme rule is `https unless plain-http listener
    # AND no proxy_mode`).
    export PROXY_MODE=true
    export TRUSTED_PROXIES="127.0.0.0/8"
  else
    # Plain-http public URL = a local trial of the packaged image. rauthy's
    # default __Host- session cookie carries Secure, which Safari refuses to
    # store over http (even on localhost), silently breaking every login
    # with a sub-millisecond 401 (session/CSRF missing, not bad password).
    export COOKIE_MODE=danger-insecure
  fi
  export RP_ID="$host"
  export RP_ORIGIN="$PUBLIC_URL"
  export ENC_KEYS="$RAUTHY_ENC_KEYS"
  export ENC_KEY_ACTIVE="$RAUTHY_ENC_KEY_ACTIVE"
  export HQL_SECRET_RAFT="$RAUTHY_HQL_SECRET_RAFT"
  export HQL_SECRET_API="$RAUTHY_HQL_SECRET_API"
  export BOOTSTRAP_DIR="$DATA/rauthy/bootstrap"
  export BOOTSTRAP_ADMIN_EMAIL="${ENRAHITU_ADMIN_EMAIL:-admin@example.com}"
  BOOTSTRAP_ADMIN_PASSWORD_PLAIN="$(cat "$DATA/rauthy/admin-password")"
  export BOOTSTRAP_ADMIN_PASSWORD_PLAIN
  cd /rauthy
  exec ./rauthy serve
) &
RAUTHY_PID=$!

# Container stop has to reach the supervised processes. The runtime signals
# PID 1, which is this shell; with no trap installed bash's default SIGTERM
# action ends the shell alone and leaves rauthy and the app to be SIGKILLed
# when the grace period expires. rauthy's embedded hiqlite then never releases
# its WAL and state-machine lock files, so every subsequent boot starts unclean
# ("LockFile ... exists already - this is not a clean start!") and can escalate
# to a startup panic ("locked and in use by another process") that the
# die-together policy turns into a crash loop. Installed here rather than after
# the app starts, so a stop during the rauthy health wait is handled too.
shutdown() {
  trap - TERM INT
  echo "[entrypoint] received $1; stopping supervised processes" >&2
  local pids=("$RAUTHY_PID")
  if [ -n "${APP_PID:-}" ]; then
    pids+=("$APP_PID")
  fi
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
  exit 0
}
trap 'shutdown SIGTERM' TERM
trap 'shutdown SIGINT' INT

# Wait for rauthy before the app starts issuing discovery requests.
# (node:24-slim has no curl; node does the probing.)
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:8081/auth/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  if ! kill -0 "$RAUTHY_PID" 2>/dev/null; then
    echo "[entrypoint] rauthy exited during startup" >&2
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] rauthy is up on 127.0.0.1:8081"

# ---------------------------------------------------------------------------
# the Encore app
# ---------------------------------------------------------------------------
# Defaults, not overrides: the packaged image sets neither, so both land on the
# production value exactly as before. The dev topology (spec 033) sets them, and
# without the `:-` idiom used elsewhere in this block they were silently
# clobbered, with two consequences that looked nothing like their cause.
# NODE_ENV=production made the first-run `npm ci` below omit devDependencies,
# so the build toolchain was absent and the watch loop could not compile; it
# also disables the mock auth driver, leaving a dev container with no way to
# sign in. AUTH_DRIVER=rauthy overrode the driver the topology asked for.
export NODE_ENV="${NODE_ENV:-production}"
export AUTH_DRIVER="${AUTH_DRIVER:-rauthy}"
export FRONTEND_URL="$PUBLIC_URL"
export RAUTHY_ISSUER="$PUBLIC_URL/auth/v1/"
export RAUTHY_CLIENT_ID=enrahitu
export RAUTHY_REDIRECT_URI="$PUBLIC_URL/api/v1/auth/rauthy/callback"
export RAUTHY_UPSTREAM="http://127.0.0.1:8081"
export ENRAHITU_KEYS_DIR="$DATA/keys"
# infra.config.json binds the app's secrets to these env vars ($env refs,
# resolved at runtime); the material was generated by first-boot.mjs.
JWT_PRIVATE_KEY="$(cat "$DATA/keys/access-private.pem")"
JWT_PUBLIC_KEY="$(cat "$DATA/keys/access-public.pem")"
JWT_REFRESH_PRIVATE_KEY="$(cat "$DATA/keys/refresh-private.pem")"
JWT_REFRESH_PUBLIC_KEY="$(cat "$DATA/keys/refresh-public.pem")"
RAUTHY_CLIENT_SECRET="$(cat "$DATA/keys/rauthy-client-secret")"
export JWT_PRIVATE_KEY JWT_PUBLIC_KEY JWT_REFRESH_PRIVATE_KEY JWT_REFRESH_PUBLIC_KEY RAUTHY_CLIENT_SECRET
# /metrics bearer token (spec 025): provisioned by first-boot, so the packaged
# image authenticates its metrics endpoint by default. An explicitly supplied
# value wins, letting a fleet inject one shared token across cells.
ENRAHITU_METRICS_TOKEN="${ENRAHITU_METRICS_TOKEN:-$(cat "$DATA/keys/metrics-token")}"
export ENRAHITU_METRICS_TOKEN
export ENRAHITU_LEDGER_URL="${ENRAHITU_LEDGER_URL:-file:$DATA/ledger/enrahitu.db}"
export ENRAHITU_HIQ_DATA_DIR="$DATA/hiqlite"
# rauthy's embedded hiqlite owns 8100/8200 in this network namespace.
export ENRAHITU_HIQ_ADDR_RAFT=127.0.0.1:8300
export ENRAHITU_HIQ_ADDR_API=127.0.0.1:8400

# The encore build docker image start command (asserted against the base
# image by scripts/docker-build.sh).
cd /workspace
# One supervisor for both topologies (spec 033 §3.3). Development and
# production differ only in the app command: the dev container mounts source
# and runs the watch loop, the packaged image runs the built bundle. Everything
# above this line (first-boot, rauthy on loopback, the readiness wait, the
# signal traps, die-together) is shared, which is the point. The signal
# handling in particular was hard won and must not exist in two copies.
if [ "${ENRAHITU_DEV:-0}" = "1" ]; then
  # node_modules is a named volume, not the host's: the addon and the napi
  # runtime are per-platform binaries, and a macOS host's tree cannot be used
  # by a linux container. The volume starts empty, so the first boot populates
  # it and later boots skip. Keyed on the toolchain rather than on the
  # directory, because an interrupted install leaves the directory present and
  # useless.
  if [ ! -d /workspace/node_modules/@statecrafting/toolchain ]; then
    echo "[entrypoint] installing dependencies into the container's node_modules (first run)"
    npm --prefix /workspace ci
  fi
  echo "[entrypoint] development mode: watching sources"
  node /workspace/scripts/dev-watch.mjs &
else
  node --enable-source-maps /workspace/.encore/build/combined/combined/main.mjs &
fi
APP_PID=$!

# Die together: first exit takes the container down; restart policy recovers.
set +e
wait -n "$RAUTHY_PID" "$APP_PID"
STATUS=$?
echo "[entrypoint] a supervised process exited (status $STATUS); stopping container" >&2
kill "$RAUTHY_PID" "$APP_PID" 2>/dev/null
wait
exit "$STATUS"
