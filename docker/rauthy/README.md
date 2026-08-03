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

## Why the dev client's `access_token_lifetime` is 60 seconds

rauthy issues refresh tokens with `nbf = issued + access_token_lifetime - 60`
(`token_set.rs`): **a refresh token cannot be used until sixty seconds before
the access token it came with expires.** The intent is that a client renews when
its token is nearly spent rather than hoarding fresh refresh tokens.

Two consequences, and the second is the one that bites.

- The app must not expire its own session earlier than rauthy expires its
  access token, or every renewal arrives before `nbf`, is refused with "Token
  is not valid yet", and the user is logged out permanently at the app's TTL
  with no way to recover. The app therefore mints its access token with the
  lifetime rauthy reports in `expires_in` rather than one of its own
  (spec 004 §3.4).
- With the previous value of 1800, renewal was untestable: the e2e would have
  had to idle for 29 minutes. At 60 the `nbf` window opens immediately, so the
  login e2e exercises a real renewal, and the dev loop renews every minute,
  which is exactly where a renewal bug should surface.

**This is a development value.** A deployment sets whatever lifetime it wants on
its own rauthy client; the app follows it, which is the whole point of the
session lifetime being the authority's.
