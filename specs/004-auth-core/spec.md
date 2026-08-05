---
id: "004-auth-core"
title: "The session adapter: rauthy is the principal authority"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 2 shipped before the spec graph existed
depends_on:
  - "002-in-process-hiqlite"
  - "003-coreledger"
establishes:
  - { kind: directory, path: "backend/auth/" }
  - { kind: directory, path: "backend/lib/" }
  - "scripts/generate-keys.ts"
summary: >
  Rewritten 2026-08-03 for the pivot (spec 001 §5.3): a thin adapter, not a
  second auth system. rauthy owns authentication AND principal identity; this
  service keeps only the same-origin httpOnly cookie shell, the CSRF
  double-submit, and rate limiting. `UserAccount` and `RefreshToken` retire,
  because each was a second opinion about a question the IdP already answers,
  and each was wrong in a way nothing could see from outside: the local account
  id became the session's subject, so a principal binding recorded against
  rauthy could never match a session, and the local refresh table made this app
  the arbiter of whether a session was still alive, so revoking a user at the
  IdP left them logged in here. The session now carries the IdP's `sub` and the
  IdP's own refresh token; `email_verified` is threaded because the member
  plane treats a verified address as proof of control. AuditLog survives: what
  happened is application data and outlives whichever authority was asked.
---

# 004: The session adapter

## 1. Purpose

Spec 001 §5.3 decided this: **a thin adapter.** rauthy owns authentication and
principal identity; this service owns the shell around it.

The version this replaces was a complete, self-contained auth system, ported
from template-encore before rauthy was in the picture. It minted its own RS256
pair, kept its own `user_account` rows, and rotated its own DB-backed refresh
tokens. Once rauthy became the IdP, all of that became a **second opinion about
questions the IdP already answers**, and a second opinion in an auth system is
not redundancy: it is a place for the two answers to differ.

They did differ, in two ways that were invisible from outside and are the reason
this rewrite is a fix rather than a tidy-up:

- **The session's subject was the wrong identifier.** `upsertUserFromProfile`
  minted a `UserAccount` with a fresh UUID and signed the access token with
  *that* as `sub`, filing rauthy's own `sub` away as `ssoProviderId`. So the
  principal binding spec 001 §5.3 describes, and which spec 036 §3.8 relies on
  to answer "which member record is yours", **could never match a session**. The
  branch that reads it was dead code, and every member-plane lookup silently
  fell through to matching on an email address instead.
- **The app decided whether a session was alive.** The refresh table meant an
  administrator revoking a user at rauthy left that user logged in here until
  their own token expired, with nothing to notice the difference.

## 2. Territory

- `backend/auth/`: driver discovery (`drivers.ts`), the mock driver (`mock.ts`),
  session renewal (`refresh.ts`), the session surface (`me.ts`, `logout.ts`,
  `csrf-token.ts`), the auth handler (`handler.ts`), login finalization
  (`service.ts`), and the one surviving entity (`entities.ts`, `store.ts`).
  `backend/auth/rauthy.ts` is owned by spec 005.
- `backend/lib/`: `jwt.ts` (issuance + the session envelope), `jwt-verify.ts`,
  `cookies.ts` + `cookie-config.ts`, `csrf.ts`, `rate-limit*.ts`, `roles.ts`,
  `audit.ts`, `security-headers.ts`, `env.ts`, `secrets.ts`, `logger.ts`.
- `scripts/generate-keys.ts`: dev keypair generation. In the container, first
  boot generates the same material (spec 007).

**Retired here**: `user-model.ts`, `refresh-token-model.ts`, and the
`UserAccount` and `RefreshToken` entities.

## 3. Behavior

### 3.1 What the app still does, and why it is not nothing

Handing sessions wholesale to rauthy would mean the SPA holding an IdP token and
sending it as a bearer header, which gives up the properties spec 001 §4.4 and
spec 005 were built for: an httpOnly cookie the page's JavaScript cannot read, a
single origin, and no token in browser-accessible storage.

So the app keeps the shell and gives up the authority:

| Kept | Given to rauthy |
|---|---|
| same-origin httpOnly cookies | who the principal is (`sub`) |
| CSRF double-submit | whether the session is still valid |
| rate limiting on login and renewal | rotation and revocation |
| a short-lived access assertion | the credential that renews it |
| the audit trail | account lifecycle, MFA, self-service |

### 3.2 The principal is the IdP's subject

The access token's `sub` is rauthy's `sub`, verbatim. That single change is what
makes `member.sub` (spec 036 §3.1) a binding that can actually match, and it is
why the domain needs no translation table between "the person logged in" and
"the person on this record".

`email_verified` rides alongside, and is carried because it is an
**authorization input rather than decoration**: spec 036 §3.8 falls back to
matching a session to a member record by email address for members enrolled
before they ever log in, and matching on an address nobody proved control of
would let an account read another member's dues. Absent claim means false. An
IdP that does not say is an IdP that did not verify.

**`preferred_username` no longer stands in for a missing email.** It used to,
and that was the hole underneath the fallback: a display handle that no provider
verifies, and several let the user choose, was being written into the field the
member plane matches on. An absent email claim now yields an absent email, which
links nothing.

### 3.3 No local account row

Nothing is written at login. A principal exists because rauthy says so.

The fields that retired with the table were all answers this app was in no
position to give. `isActive` is rauthy's to decide, and it enforces it by
declining to renew the session, which is stronger than a boolean this app would
have had to keep in step. `lastLoginAt` and `createdAt` described a row rather
than a person.

`GET /api/v1/auth/me` therefore reads from the session, and what it reports is
what the IdP said at most one access-token lifetime ago.

### 3.4 Renewal is a round-trip to the authority

The session cookie carries a **signed envelope**, and the distinction between an
envelope and a credential is the point: it carries no identity, grants nothing
on presentation, and is worthless without what the authority put inside it. The
signature is integrity only, so a browser cannot hand back an envelope naming a
different driver.

- **rauthy**: the envelope holds the IdP's own refresh token. `POST
  /api/v1/auth/refresh` forwards it to rauthy's token endpoint and re-mints from
  the claims that come back. A refresh grant returns no id token, so the claims
  come from userinfo, asked about the subject the envelope pinned at login;
  pinning it also means a renewal cannot quietly change who the session belongs
  to. Roles and `email_verified` are **re-read on every renewal** rather than
  carried forward, so a role removed at the IdP takes effect within one
  access-token lifetime. A refused grant is the ordinary shape of "this session
  is over" and answers 401.

  **The session's lifetime is the authority's, and this is load bearing rather
  than tidy.** rauthy stamps every refresh token with

  ```
  nbf = issued + access_token_lifetime - 60      # token_set.rs
  ```

  so a refresh token **cannot be used until sixty seconds before the access
  token it came with expires**. The intent is that a client renews when its
  token is nearly spent rather than hoarding fresh refresh tokens.

  The consequence is not obvious and is severe. If this app expired its own
  session earlier than rauthy expires its access token, every renewal would
  arrive before `nbf`, be refused with `Token is not valid yet`, and **every user
  would be logged out at the app's TTL with no way to recover**. With the app's
  original fixed 15 minutes against rauthy's default 30, that is exactly what
  would have shipped: a session that dies at fifteen minutes, permanently, in
  production only.

  So the app mints its access token with the lifetime rauthy reports in
  `expires_in` rather than one of its own. Following the authority's clock is
  the same decision as following its `sub`: if rauthy owns the session, it owns
  when the session ends.

  This was found by an end-to-end test rather than by reading, and could not
  have been found any other way: every unit test passed, and the failure needs a
  real IdP issuing a real refresh token to appear at all.
- **mock**: the envelope names a profile index. It is the development driver and
  has no authority to ask, so renewal is refused outright when the mock driver
  is disabled, which it is in production. A session that renews itself with no
  authority behind it is a permanent credential.

Logout clears the cookies, which discards the only copy of the refresh token the
app ever held, and then sends the browser through rauthy's end-session endpoint.
**That redirect is no longer a courtesy but the actual logout** (spec 005): it is
what ends the session at the authority, and without it the browser still holds a
live rauthy session and the next login succeeds with no prompt.

### 3.5 What is deliberately lost

Rotation and revocation semantics become rauthy's to define. This is the cost
spec 001 §5.3 accepted in exchange for having exactly one session authority, and
it is worth stating as a loss rather than filed as a detail:

- The app can no longer revoke one session without revoking at rauthy.
- Reuse detection of a rotated refresh token is rauthy's if it does it at all.
- The window between a revocation at the IdP and its effect here is one
  access-token lifetime (15 minutes), where the old design could in principle
  have been immediate. It never was, because nothing consulted the IdP.

### 3.6 Migration, and the discontinuity in the audit trail

`user_account` and `refresh_token` are **not dropped**. A deployment upgrading
through this change has rows in them, and they are the only record of who logged
in before the cutover; dropping them at boot to reclaim two unused tables would
destroy that. They are left in place, unread, for an operator to remove.

Every session in flight at the cutover is invalidated, because the envelope
shape changed and the old refresh tokens no longer verify. Users log in again
once. That is the honest cost of the change and there is no version of it that
preserves a session whose subject is about to become a different identifier.

**`AuditLog` records written before and after refer to the same person by two
different identifiers**: the old local account id, and the IdP subject. That
discontinuity is permanent and is recorded here rather than discovered later, in
the same spirit as spec 036 §3.2's reasoning about tenants entering primary
keys. The cutover date is the translation rule.

## 4. Acceptance

1. The access token's subject is the IdP's `sub`, so a `member.sub` recorded
   against rauthy matches the session (§3.2).
2. `email_verified` is carried into the session, defaults to false when the
   claim is absent, and is never true when there is no address to qualify.
3. `preferred_username` never becomes the session's email; an absent email
   claim yields an absent email.
4. The member plane links by `sub`, falls back only to a VERIFIED address, and
   links nothing for a session carrying no subject (spec 036 §3.8).
5. The session envelope round-trips, and a shape this app does not issue is
   refused even when correctly signed.
6. Renewal forwards the IdP's refresh token and re-mints from the returned
   claims; a refused grant answers 401 and clears the cookies.
7. Renewal on a mock envelope is refused when the mock driver is disabled.
8. Logout clears the cookies and, with a hint and a configured driver, redirects
   through rauthy's end-session endpoint.
9. No `user_account` or `refresh_token` row is read or written by any code path.
10. The app's access token expires no earlier than the authority's, so a renewal
    never arrives before the refresh token's `nbf` (§3.4). Asserted in the login
    e2e by decoding the renewed token: `exp - iat` equals rauthy's configured
    `access_token_lifetime`.
11. The whole flow is exercised browser-real (spec 017): login, `/me`, renewal,
    CSRF logout, RP-initiated logout, and 401 afterwards, all on one origin.

## 5. Phase A seam (amended by spec 021, 2026-07-20)

Three hooks land in this spec's territory under the governance seam:
the secret accessors in `lib/secrets.ts` adjudicate `secret.read` of
their specific secret name before returning material; the rate limiter
consumes the governed hiq facade (its counter grants carry the
`keyPrefix: "rl:"` constraint, and every call passes its bucket key);
and the auth schema boot in `store.ts` runs inside a
`runAsService("auth", ...)` scope so its module-eval DDL is attributed
and adjudicated as `db.migrate`. Deny semantics follow the existing
typed-error convention (`APIError.permissionDenied` with a
`KERNEL_DENIED` detail code).

## 6. Observability seam (amended by spec 022, 2026-07-22)

The auth service's middleware chain gains spec 022's `obsMiddleware`
outermost (`[obsMiddleware, securityHeaders, csrfMiddleware,
apiRateLimit]`): request spans and the metrics families measure the
whole chain, including CSRF rejections and rate-limit 429s. The
middleware is measurement only; auth semantics, ordering of the
existing three, and the CSRF exemptions are unchanged.

## 7. Admin gate seams (amended by spec 023, 2026-07-22)

Four lib/auth seams move with the operator dashboard:

- `lib/jwt.ts` splits verification out: `lib/jwt-verify.ts` holds
  `verifyAccessToken` (+ ISSUER/AUDIENCE and the claims type) and imports
  only the public-key accessor, so a service that merely verifies
  sessions declares `secret.read` on `jwt_public_key` alone.
  `lib/jwt.ts` re-exports it; issuance and refresh handling stay put.
- `lib/roles.ts` gains `operatorRole()`: the model's `auth.operatorRole`
  (stamp-time truth), so a stamped app gates on its own name.
- `lib/env.ts` gains `adminUiEnabled` (`ADMIN_UI_ENABLED`, default true):
  the spec 023 runtime kill switch.
- The mock driver gains a fourth principal (`operator@example.com`)
  holding the model's operator role, so the gate is exercisable without
  a real IdP.

## 8. RP-initiated logout seam (amended by spec 005, 2026-07-23)

`logout.ts` composes spec 005's RP-initiated logout: it reads the
`oidc_id_hint` cookie (name and path-scoped options live in
`lib/cookie-config.ts`; the cookie is set and owned by the rauthy
driver), and when the hint is present and the driver configured,
returns spec 005's end-session URL as `redirectUrl` instead of the
frontend root. `clearAuthCookies` clears the hint cookie alongside
the three auth cookies (clearing an absent cookie is harmless, so the
mock driver path is unaffected). Revocation, audit, CSRF posture, and
the 200-with-JSON response shape are unchanged.

## Amendment (2026-07-25): forge-proof client identity (spec 025)

`clientKey` in `backend/lib/rate-limit.ts` and `clientIp` in
`backend/auth/http.ts` both derived the caller from the leftmost
`X-Forwarded-For` value, with no notion of which hop was trustworthy;
`clientIp` preferred that header over the socket address it already
held. Since the packaged image is exposed directly, a caller set its own
header and drew a fresh bucket per request, so both rate-limit tiers
counted an attacker-chosen string.

Both derivations now route through `backend/lib/client-identity.ts`
(spec 025 §3.2), which believes the header only to the depth an operator
declares in `ENRAHITU_TRUSTED_PROXY_HOPS`, counting from the right so a
forged leading entry is ignored. The raw path always resolves, falling
back to the transport peer, which makes the auth tier (the one guarding
brute force and account lockout) forge-proof in every mode.

The typed tier cannot do the same: Encore's `APICallMeta` carries headers
and no peer address. With no declared proxy it therefore keys on the
endpoint under a coarse shared ceiling rather than on a header a caller
controls, which is honest degradation instead of an unenforceable
per-client limit. `ENRAHITU_TRUSTED_PROXY_HOPS` restores the precise
tier. `API_LIMIT`, `AUTH_LIMIT`, the fixed-window arithmetic, and the
fail-open-on-backend-error policy are unchanged.

## Amendment (2026-08-02): a non-auth secret in the auth library (spec 037)

`lib/secrets.ts` gains `mailPasswordValue()`, adjudicating
`secret.read` of `enrahitu_mail_password` like every other accessor here
(§5's rule is unchanged and is the reason this belongs here rather than in
`backend/mail/`).

**It is worth naming that this secret has nothing to do with authentication.**
The module is not "the auth service's secrets"; it is the one place in the tree
permitted to bind `encore.dev/config`, which the extraction ban-list enforces. A
second binding site elsewhere would mean two places where credential material
enters the process and only one of them adjudicating, so the module's boundary
is the ban, not the subject matter. This spec owns the file because of where the
file sits, and a reader looking for the mail relay's password should expect to
find it here.

It is deliberately NOT rauthy's relay password. Spec 037 §3.1 keeps the
application's mail credentials and the IdP's on separate surfaces held by
separate processes; `ENRAHITU_SMTP_PASSWORD` never enters this process at all,
and the entrypoint now enforces that (spec 007's amendment of the same date).

## Amendment (2026-08-04): CoreLedger's boot seam gains an opt-in migrate (spec 027)

`ENRAHITU_MIGRATE_ON_BOOT`, default false, applies pending CoreLedger migrations
inside `dbReady` under the `auth` service's existing attribution.

The placement wants stating, because it looks arbitrary otherwise: this file is
the only place anything opens the ledger at boot, so it is the only boot seam
CoreLedger has. An app whose migrations must run before its first request has
nowhere earlier to put them.

It is off by default and stays off by default. Boot-time migration ties schema
change to process restart, so a crash loop becomes a migration loop, and once a
topology runs more than one app container against one ledger it races (spec 027
§3.4). The supported path is the operator plane's apply endpoint. This exists for
the single-container case where the simplicity is worth it, and being opt-in is
what keeps the deployments it is wrong for from ever meeting it.
