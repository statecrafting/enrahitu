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
VOLUME /data
EXPOSE 8080

ENTRYPOINT ["/enrahitu/entrypoint.sh"]
