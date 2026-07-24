# enrahitu final image: the app (built with the vendored Encore toolchain,
# docker/Dockerfile.base) + rauthy in one container. Build via
# scripts/docker-build.sh (which produces the BASE_IMAGE from a clean git
# worktree and asserts its entrypoint).
ARG BASE_IMAGE=enrahitu-api:latest

FROM ghcr.io/sebadob/rauthy:0.36.0 AS rauthy

FROM ${BASE_IMAGE}

# rauthy: single dynamically-linked binary (Debian, same family as
# node:24-slim); bound to loopback :8081 by the entrypoint and reached only
# through the app's /auth/* proxy.
COPY --from=rauthy /app/rauthy /rauthy/rauthy
COPY docker/rauthy/config.prod.toml /rauthy/config.toml
COPY docker/first-boot.mjs /enrahitu/first-boot.mjs
COPY docker/entrypoint.sh /enrahitu/entrypoint.sh
RUN chmod 0755 /enrahitu/entrypoint.sh /rauthy/rauthy

# All durable state: CoreLedger file, app hiqlite, rauthy hiqlite, key material.
# Owned by node BEFORE the VOLUME declaration, so a fresh named volume inherits
# writable ownership for the non-root runtime user.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080

# Non-root (spec 007, amendment 2026-07-23b): uid/gid 1000, matching the
# fleet's pod securityContext (runAsUser 1000 + fsGroup 1000, statecraft
# spec 006). Everything the runtime writes lives under /data; both
# listeners are unprivileged ports. A legacy root-owned volume needs a
# one-time chown -R 1000:1000 (or --user 0 as the escape hatch).
USER node

ENTRYPOINT ["/enrahitu/entrypoint.sh"]
