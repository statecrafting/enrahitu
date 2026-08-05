#!/bin/bash
# enrahitu single-container entrypoint: rauthy (loopback :8081) + the Encore app
# (:8080, which proxies /auth/* to rauthy). Die-together supervision: if either
# process exits, the container exits and the restart policy recovers it.
set -euo pipefail

DATA="${ENRAHITU_DATA_DIR:-/data}"
PUBLIC_URL="${ENRAHITU_PUBLIC_URL:-http://localhost:8080}"
PUBLIC_URL="${PUBLIC_URL%/}"

# Pre-flight (spec 027 §3.5): every condition whose absence would otherwise
# surface later and confusingly, stated before anything starts. Under `set -e` a
# nonzero verdict stops the boot here, which is the point: an occupied port, a
# root-owned volume, or a ledger URL with no scheme each currently fails several
# screens later, after rauthy is up, as something that does not name its cause.
#
# The fleet-declared required-env check (spec 007, amendment 2026-07-23) moved
# INTO the verb rather than being duplicated beside it. Two implementations of a
# contract a fleet configures are two implementations that drift, and the copy
# that lived here was the one nothing could test.
#
# /workspace is the app tree in both topologies: the packaged image copies the
# worktree there, the dev container bind-mounts it. It holds no dependency of
# its own for exactly this reason, since the dev container reaches this line
# before its first `npm ci`.
node /workspace/scripts/ops/preflight.mjs

node /enrahitu/first-boot.mjs

# secrets.env carries RAUTHY_-prefixed material for the rauthy process and
# ENRAHITU_HIQ_* for the app; written by first-boot.mjs, chmod 0600.
# shellcheck disable=SC1091
. "$DATA/rauthy/secrets.env"

# restore.env carries first-boot's single-shot restore decisions (spec 033 §3.5,
# spec 027 §3.3). hiqlite applies HQL_BACKUP_RESTORE at boot before the raft node
# starts, and left set in a container with a restart policy it re-applies on
# EVERY restart, discarding everything written since: a crash loop becomes
# silent, repeated data loss. first-boot.mjs records which backup it honoured and
# writes either an export or an unset here, so the operator may set the variable
# once and leave it set.
#
# There are TWO decisions, one per store, and they stay prefixed until the
# moment they enter the process that should act on them. This container runs two
# independent hiqlite nodes, and HQL_BACKUP_RESTORE is hiqlite's own name, so a
# single ambient value naming a single file is read by both: whichever node it
# was not meant for either refuses the file or, worse, accepts it.
# shellcheck disable=SC1091
. "$DATA/restore.env"

# An inherited HQL_BACKUP_RESTORE reaches neither node (spec 027 §3.3). Scrubbed
# rather than mapped, for the same reason SMTP_* is scrubbed below: an
# orchestrator exporting hiqlite's variable for some other workload must not
# silently arm a restore here. first-boot.mjs has already run and named it in the
# log, so this is loud rather than quiet.
unset HQL_BACKUP_RESTORE

# Map one store's prefixed decision onto hiqlite's own variable, and drop BOTH
# prefixed names, so a child process can see its own file and never the other's.
# Called from inside each supervised process's subshell, which is what makes
# "neither variable is visible in the other's environment" a fact about the
# environment rather than an intention (spec 027 §4 item 9).
export_restore_env() {
  local src="$1"
  if [ -n "${!src:-}" ]; then
    export HQL_BACKUP_RESTORE="${!src}"
    echo "[entrypoint] restoring $src into ${2}" >&2
  fi
  unset ENRAHITU_RESTORE_RAUTHY ENRAHITU_RESTORE_APP
}

# Ambient mail configuration is removed before anything starts (spec 026 §3.1).
#
# The prefix alone does not deliver what §3.1 claims for it. Mapping
# ENRAHITU_SMTP_* onto SMTP_* stops an ambient variable being mapped, and does
# nothing at all about it being INHERITED: rauthy reads SMTP_URL from its
# environment either way, so an orchestrator that exports a shared SMTP_* for
# some other workload would silently configure this IdP's mail path with nobody
# having asked. Scrubbing first is what makes ENRAHITU_SMTP_* the only surface
# that can configure mail here.
#
# It runs at top level rather than in the rauthy subshell so the app process is
# covered too: an ambient SMTP_PASSWORD is a credential, and the app has no more
# business holding one it inherited than one we handed it.
scrub_smtp_env() {
  local name
  for name in ${!SMTP_*}; do
    unset "$name"
  done
}

# Mail passthrough (spec 026 §3.1): ENRAHITU_SMTP_* into rauthy's own SMTP_*.
#
# Called from inside the rauthy subshell, which is the whole point of it being
# a function rather than inline exports: mail credentials must not enter the app
# process environment, and ENRAHITU_SMTP_PASSWORD is a secret the app has no
# business holding.
#
# Only variables that are SET are exported. An unset one is not exported as
# empty, because rauthy distinguishes absent from empty for several of these:
# an empty SMTP_URL is a configured-but-blank relay rather than an unconfigured
# one, and the two behave differently.
#
# The ENRAHITU_ prefix is load bearing beyond consistency. Without it an ambient
# SMTP_* in the host or orchestrator environment would silently reconfigure the
# IdP's mail path with nobody having asked for it.
#
# Every rauthy name is `SMTP_` plus the same suffix, so this loops over suffixes
# rather than listing pairs. A table of pairs is a table that can drift.
export_smtp_env() {
  local suffix src
  for suffix in URL PORT USERNAME PASSWORD FROM STARTTLS_ONLY CONNECT_RETRIES DANGER_INSECURE; do
    src="ENRAHITU_SMTP_$suffix"
    if [ -n "${!src+set}" ]; then
      export "SMTP_$suffix=${!src}"
    fi
  done
}

scrub_smtp_env

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
  export_restore_env ENRAHITU_RESTORE_RAUTHY "rauthy's identity store"
  export_smtp_env
  # The other half of spec 037 §3.1's two-surfaces rule. The subshell inherits
  # the whole environment, so without this rauthy would hold the APPLICATION's
  # relay credentials: not because anything maps them (nothing does, rauthy
  # reads SMTP_*), but because inheritance is the default and a credential
  # sitting in a process that has no use for it is still that process's blast
  # radius. Two surfaces means two holders, which has to be enforced in both
  # directions or it is one surface with extra prefixes.
  for name in ${!ENRAHITU_MAIL_*}; do
    unset "$name"
  done
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

# The IdP's mail surface leaves the app process here (spec 037 §3.1).
#
# rauthy captured these in its own subshell above, so unsetting them now is
# free, and it is what makes "ENRAHITU_SMTP_* is absent from the application
# process" a fact rather than an intention. Spec 026 scrubbed the MAPPED names
# (SMTP_*) and left the prefixed originals inherited, which was correct for what
# 026 claimed and is not enough for what 037 claims: ENRAHITU_SMTP_PASSWORD is
# the IdP's relay credential, and an application that never sends through that
# relay has no business holding it.
for name in ${!ENRAHITU_SMTP_*}; do
  unset "$name"
done

# The encore build docker image start command (asserted against the base
# image by scripts/docker-build.sh).
cd /workspace
# One supervisor for both topologies (spec 033 §3.3). Development and
# production differ only in the app command: the dev container mounts source
# and runs the watch loop, the packaged image runs the built bundle. Everything
# above this line (first-boot, rauthy on loopback, the readiness wait, the
# signal traps, die-together) is shared, which is the point. The signal
# handling in particular was hard won and must not exist in two copies.
# The app runs in its own subshell for the same reason rauthy does (spec 027
# §3.3): it is the second hiqlite node, so its restore decision has to enter
# this process and no other. `exec` makes the subshell become the app, so
# $APP_PID is still the process the traps signal and `wait -n` observes.
(
  export_restore_env ENRAHITU_RESTORE_APP "the app's resource store"
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
    exec node /workspace/scripts/dev-watch.mjs
  else
    exec node --enable-source-maps /workspace/.encore/build/combined/combined/main.mjs
  fi
) &
APP_PID=$!

# Die together: first exit takes the container down; restart policy recovers.
set +e
wait -n "$RAUTHY_PID" "$APP_PID"
STATUS=$?
echo "[entrypoint] a supervised process exited (status $STATUS); stopping container" >&2
kill "$RAUTHY_PID" "$APP_PID" 2>/dev/null
wait
exit "$STATUS"
