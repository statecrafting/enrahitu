---
id: "026-idp-mail-delivery"
title: "IdP mail delivery: the second user"
status: approved
created: "2026-07-25"
implementation: complete
depends_on:
  - "005-rauthy-same-origin"
  - "007-single-container-packaging"
  - "033-dev-substrate"
establishes:
  - "docker/smtp.env.example"
summary: >
  rauthy ships inside the image with exactly one bootstrapped admin and
  no mail configuration anywhere: not in docker/rauthy/config.prod.toml,
  not in the entrypoint's rauthy subshell, not in first-boot. Password
  reset, email verification, user registration, and invitation are
  therefore all silently inert. For a template whose stated deliverable
  is a complete authenticated application, the first user works and the
  second cannot be onboarded. This spec passes an ENRAHITU_SMTP_*
  operator surface through the entrypoint into rauthy's SMTP_* variables,
  scoped to the rauthy subshell so nothing leaks into the app process,
  and converts the unconfigured case from silent breakage into a stated
  limitation logged at boot.
---

# 026: IdP mail delivery

## 1. Purpose

`docker/rauthy/config.prod.toml` is ten lines and configures a cluster
and a data directory. `docker/entrypoint.sh` exports encryption keys,
hiqlite secrets, the public URL, the bootstrap admin, and the cookie
mode. Neither mentions mail, and a grep for `SMTP` across `docker/`
returns nothing.

rauthy treats mail as optional and degrades quietly, so nothing fails
loudly. What actually happens is that every flow depending on delivery
becomes a dead end at the moment a user needs it most: a forgotten
admin password on the one account the image bootstrapped, a new user
who can never verify an address, an operator who cannot invite a
colleague. The single-admin bootstrap in `docker/first-boot.mjs` is
sound as a starting state precisely because there is a path to a second
user. Today there is not.

This is a small change with disproportionate value: the difference
between a demonstration and an installation.

## 2. Territory

This spec owns `docker/smtp.env.example`: the documented operator
surface, in the form an operator actually uses it (an env file passed
to `docker run --env-file` or referenced from a compose service).

It amends, without owning:

- `docker/entrypoint.sh` (spec 007): the mapping described in section
  3.1, inside the existing rauthy subshell.
- `docker/first-boot.mjs` (spec 007): the boot-time notice in section
  3.2.
- `docker/rauthy/config.prod.toml` (spec 005): unchanged in this spec.
  Mail is deployment-varying and therefore belongs in environment, not
  in a baked config file.

## 3. Behavior

### 3.1 The passthrough

The container's operator surface is `ENRAHITU_`-prefixed like every
other knob it accepts. The entrypoint maps each present variable into
rauthy's own name inside the subshell that already scopes rauthy's
environment, so the app process never sees mail credentials:

| container variable | rauthy variable |
|---|---|
| `ENRAHITU_SMTP_URL` | `SMTP_URL` |
| `ENRAHITU_SMTP_PORT` | `SMTP_PORT` |
| `ENRAHITU_SMTP_USERNAME` | `SMTP_USERNAME` |
| `ENRAHITU_SMTP_PASSWORD` | `SMTP_PASSWORD` |
| `ENRAHITU_SMTP_FROM` | `SMTP_FROM` |
| `ENRAHITU_SMTP_STARTTLS_ONLY` | `SMTP_STARTTLS_ONLY` |
| `ENRAHITU_SMTP_CONNECT_RETRIES` | `SMTP_CONNECT_RETRIES` |
| `ENRAHITU_SMTP_DANGER_INSECURE` | `SMTP_DANGER_INSECURE` |

Names verified against the rauthy source, which also defines
`SMTP_CONN_MODE`, `SMTP_ROOT_CA`, `SMTP_XOAUTH`, `SMTP_OAUTH_TOKEN`,
and `SMTP_MICROSOFT_GRAPH_URI`. Those are deliberately not mapped: the
table above covers password-authenticated and unauthenticated SMTP,
which is what a self-hosted deployment uses. Graph and XOAUTH are a
named extension, not a gap.

Only variables that are set are exported. An unset variable is not
exported as empty, because rauthy distinguishes absent from empty for
several of these.

The prefix is load bearing beyond consistency, and **the mapping alone
does not deliver what it is for.** The intent is that an ambient `SMTP_*`
in the host or orchestrator environment cannot silently reconfigure the
IdP's mail path without an operator having said so. Mapping
`ENRAHITU_SMTP_*` onto `SMTP_*` stops an ambient variable being *mapped*
and does nothing whatever about it being *inherited*: rauthy reads
`SMTP_URL` from its environment either way, so an orchestrator exporting
a shared `SMTP_*` for some other workload would configure this IdP's mail
exactly as before.

So the entrypoint **scrubs `SMTP_*` before either process starts**, and
only then maps. That is what makes `ENRAHITU_SMTP_*` the sole surface
that can configure mail here. The scrub runs at top level rather than in
the rauthy subshell so the application process is covered too: an ambient
`SMTP_PASSWORD` is a credential, and the app has no more business holding
one it inherited than one this spec handed it.

`ENRAHITU_SMTP_PASSWORD` is a secret and is named in the operational
documentation (spec 028) as one, alongside the existing rule that
secrets reach the container through the orchestrator rather than the
image.

### 3.2 The unconfigured case, stated rather than silent

When `ENRAHITU_SMTP_URL` is absent, `docker/first-boot.mjs` logs one
notice naming exactly what is inert:

```
[first-boot] no ENRAHITU_SMTP_URL: password reset, email verification,
             registration, and invitation will not deliver. The
             bootstrapped admin is the only usable account.
```

This is a notice, not a failure. A local trial of the packaged image
must keep working with no mail server, and `ENRAHITU_REQUIRED_ENV`
(spec 007) already exists for a fleet that wants to make SMTP
mandatory for its own deployments: adding `ENRAHITU_SMTP_URL` to that
list turns the notice into a hard precondition without this spec
deciding the policy.

### 3.3 Verification, and the mail catcher that makes it possible

The first version of this section conceded that "the delivery path is not
exercised by CI: a live SMTP server is external state." That concession
was avoidable. **A mail catcher makes the external state internal**, and
the dev topology (spec 033) gains one.

`docker/compose.yml` runs Mailpit alongside the app: MIT-licensed, a
single static binary, an SMTP sink on 1025 and a web UI on 8025 that a
developer reads like an inbox. It is chosen over MailHog (unmaintained),
Maildev, and Inbucket because it is the only one that is both a static
binary and carries a REST API, and the API is the half that matters here:
an automated test can fetch what was delivered instead of a human
squinting at a UI. The app service points the same `ENRAHITU_SMTP_*`
surface at it, which is the property worth having: **dev and production
differ in which relay is configured, not in whether the code path runs.**

Two layers, because they fail differently:

- **The mapping**, in `docker/entrypoint.test.ts`, which is where a defect
  would actually be. A set variable reaches the rauthy environment under
  its rauthy name; an unset one is absent rather than empty; an ambient
  `SMTP_*` is removed rather than honoured; and no `SMTP_*` reaches the
  app process. The assertions lift the real functions out of the shipped
  script, so they break when someone edits the entrypoint rather than
  when someone edits a copy of it. `docker/first-boot.test.ts` covers the
  section 3.2 notice on both sides of the condition.
- **Delivery**, in the running topology. A password reset requested
  through the app's own origin arrives in Mailpit, addressed from the
  configured `ENRAHITU_SMTP_FROM` rather than a rauthy default, carrying
  a reset link on the app's origin. That last detail is worth stating:
  spec 005's same-origin invariant holds through the mail path as well,
  which nothing previously checked.

What is still not automated is a browser following that link to a
completed password change. The pieces now exist for it (spec 017's
Playwright harness plus Mailpit's REST API, which is why the REST API
decided the tool choice) and it lands with the next change to that
harness. Naming it here keeps the seam from being mistaken for an
oversight: rauthy guards the reset request with a proof of work, so the
test has to solve one, which is a test-harness concern rather than a
delivery one.

## 4. Acceptance

1. Every variable in the section 3.1 table, when set on the container,
   is present in the rauthy process environment under its rauthy name
   and absent from the app process environment.
2. An unset `ENRAHITU_SMTP_*` variable produces no corresponding
   `SMTP_*` in the rauthy environment, not an empty one.
3. With no SMTP configured, first boot emits the section 3.2 notice and
   the container reaches a healthy state exactly as before this spec.
4. `docker/smtp.env.example` exists, documents every mapped variable,
   and carries a worked example for one authenticated relay and one
   unauthenticated internal relay.
5. Adding `ENRAHITU_SMTP_URL` to `ENRAHITU_REQUIRED_ENV` causes the
   documented pre-flight failure, with no change to this spec's code.
6. An `SMTP_*` variable already present in the container's environment is
   removed rather than honoured, and an `ENRAHITU_SMTP_*` for the same
   setting wins (§3.1).
7. In the dev topology, a password reset requested through the app's own
   origin is delivered to the mail catcher, from the configured
   `ENRAHITU_SMTP_FROM`, carrying a reset link on the app's origin.
8. `npm run typecheck && npm test` green, coupling gate green.

## 5. Out of scope

- Graph, XOAUTH, and custom root CA mail configurations: named
  extension, mapped on demand.
- An in-image mail transfer agent. Mail delivery is genuinely external
  infrastructure; embedding a relay would be the one place the
  zero-external-dependency thesis stops being honest, since deliverability
  depends on DNS and reputation the cell does not own.
- Template-level mail branding and rauthy's mail templates: rauthy
  configuration surface, not this substrate's.
- Application-originated mail (transactional mail from the app itself,
  as opposed to the IdP's). That needs an outbox and a sender identity
  and is a candidate consumer for the queue work in spec 030's
  territory, not an IdP concern.
