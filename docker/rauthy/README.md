# rauthy dev configuration

`bootstrap/clients.json` declaratively creates the `enrahitu` OIDC client on
rauthy's FIRST boot against an empty volume (rauthy skips bootstrap once its
database has JWKS). The `Plain` secret in that file is **development-only**
and public by design; `npm run dev:idp-secret` copies it to
`keys/rauthy-client-secret` (gitignored), where `lib/secrets.ts` picks it up
as the dev fallback for the `RAUTHY_CLIENT_SECRET` Encore secret.

The production container (Phase 5) generates a fresh secret at first boot
instead; nothing from this directory ships in the image.

Admin UI (through the app proxy): http://localhost:4000/auth/v1/admin.
DEV_MODE seeds rauthy's own dev admin: `admin@localhost` / `123SuperSafe`
(BOOTSTRAP_ADMIN_* env only applies on the prod-init path, so the compose
file does not set it).

To re-run bootstrap from scratch: `docker compose -f docker/compose.dev.yml
down -v` (drops the rauthy volume).
