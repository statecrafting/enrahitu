---
id: "037-app-mail"
title: "Application mail: the notices the association sends"
status: approved
created: "2026-08-01"
implementation: complete
depends_on:
  - "020-app-model-contract"
  - "021-kernel-native-consumption"
  - "026-idp-mail-delivery"
  - "034-control-plane"
  - "035-chassis-boundary"
  - "036-membership-core"
establishes:
  - { kind: directory, path: "backend/mail/" }
  - "app/mail/README.md"
summary: >
  Spec 026 gave the IdP a mail path and explicitly left application-originated
  mail out, naming an outbox and a sender identity as what it would need. This
  supplies both. Three decisions are load bearing and none is obvious. The
  kernel gains a second transport: `smtp.egress`, because the governed egress
  facade is HTTP-shaped and a raw SMTP socket would otherwise be the one channel
  a governed deployment cannot adjudicate, which spec 030 §3.5 already refuses
  for pub/sub in terms that apply verbatim here. A notice is a resource rather
  than a function call, so delivery is a controller reconciling toward a state
  and idempotence comes from the notice's name rather than from a delivery
  guarantee nothing can make. And the application's mail credentials are a
  SEPARATE surface from the IdP's, because spec 026's scoping exists precisely
  to keep the IdP's credentials out of this process and reusing them would
  dismantle it.
---

# 037: Application mail

## 1. Purpose

Spec 026 §5 put application-originated mail out of scope and said what it would
need: "an outbox and a sender identity." Both now exist as requirements rather
than as speculation, because spec 036 shipped a renewal controller that knows a
member owes money on a date and has no way to tell them.

The association's own mail is the point of the product. Dues notices, renewal
reminders, receipts, meeting notices, announcements. None of it is the IdP's,
none of it can go through rauthy, and all of it is what an association does
between the moments a member logs in.

## 2. Territory

This spec owns `backend/mail/`: the transport adapters, the template resolver,
the notice kind, and the controller that delivers.

It owns `app/mail/README.md`, which is the tree-side half of §3.5.

It amends, without owning:

- `backend/kernel/egress.ts` (spec 021): the second transport in §3.2.
- The extraction ban-list (spec 020 §3.4): a raw socket is added to what
  application code may not open, for the same reason a bare `fetch` already is.
- `app-manifest.chassis.json` (spec 035): the new capability and its grant.

## 3. Behavior

### 3.1 Two mail surfaces, deliberately not one

An operator configuring mail twice looks like a defect, so the reason it is not
belongs at the top.

Spec 026's entire scoping mechanism exists to keep the IdP's mail credentials
out of the application process: the mapping runs inside the rauthy subshell for
that reason and nothing else. Application mail needs credentials **in** the
application process. Pointing this feature at `ENRAHITU_SMTP_*` would therefore
dismantle the invariant spec 026 was written to establish, and would do it
silently, since the variables would simply have to stop being subshell-scoped.

So the application gets its own prefixed surface, `ENRAHITU_MAIL_*`, held by the
application process, and `ENRAHITU_SMTP_*` stays rauthy's alone. Two surfaces,
two holders, two sender identities, and the blast radius of a leaked credential
stays the size of the thing that leaked.

An operator may point both at the same relay, and most will. That is
configuration duplication, which is cheap. Sharing one variable would be
privilege duplication, which is not.

**Two holders has to be enforced in both directions, or it is one surface with
extra prefixes.** The container runs both processes, and a subshell inherits its
parent's whole environment, so prefixing alone achieves nothing: rauthy would
hold the application's relay password and the application would hold the IdP's,
neither because anything mapped them but because inheritance is the default.
`docker/entrypoint.sh` therefore drops each surface at the point the other
process no longer needs it: `ENRAHITU_MAIL_*` is unset inside the rauthy
subshell, and `ENRAHITU_SMTP_*` is unset after that subshell has captured it and
before the app starts.

This extends spec 026 §3.1 rather than restating it. That scrub removed the
*mapped* names (`SMTP_*`) and deliberately left the prefixed originals
inherited, which was sufficient for what 026 claimed. It is not sufficient for
what §4 item 1 below claims, because `ENRAHITU_SMTP_PASSWORD` is the IdP's relay
credential and an application that never sends through that relay has no
business holding it. A credential sitting in a process that has no use for it is
still that process's blast radius.

### 3.2 The kernel gains a second transport

`backend/kernel/egress.ts` is the only module in `backend/` permitted a bare
`fetch`, and every call adjudicates `http.egress` before anything leaves the
process. That model is HTTP-shaped, and mail is the first thing to escape it: an
SMTP transport opens a TCP socket, which the facade does not see and the
extraction ban-list does not forbid.

Spec 030 §3.5 already settled the general question for pub/sub, and its sentence
is exact here: "A governed deployment whose messages leave unadjudicated has an
ungoverned channel, and the whole kernel plane would be arguable." A deployment
that can be made to send mail without a ledger entry is a deployment whose audit
record is incomplete in the direction that matters, since mail is the channel
that reaches people.

The kernel therefore gains **`smtp.egress`**, in the same shape as
`http.egress`:

```
demand("smtp.egress", "<logical relay>", { attributes: { host } })
```

Three consequences, each of which is the point rather than a side effect:

- **One module may open a socket.** `backend/mail/transport.ts` becomes to SMTP
  what `egress.ts` is to HTTP, and the ban-list is extended so any other module
  importing `node:net`, `node:tls`, or a mailer library fails extraction. A rule
  enforced only by review is a rule that lasts until the first hurry.
- **A grant names the relay, and may constrain the host.** The `host` attribute
  rides exactly as `domain` does for HTTP, so a fleet may pin which relay a cell
  is allowed to reach.
- **A denial is ledgered like any other.** Mail that could not be sent because
  the capability was absent is a Decision, not a log line.

Provider APIs (Resend, Postmark, SES) need none of this: they are HTTPS and
already adjudicate through `governedFetch` with `cap.egress.<provider>`. The new
kind exists for the self-hosted case, which is the primary one for this
substrate: an association with an internal relay and no SaaS account.

`cap.smtp.<name>` enters `app-manifest.json` alongside the existing
`cap.egress.rauthy`, and spec 020's capability inventory grows by one kind.

**A new capability kind is a three-layer change, and only one layer is here.**
This was written as though the kind were a string this repo could choose, and it
is not. Adding `smtp.egress` required, in order:

1. `contracts/app-model.schema.json`'s `capKind` enum (spec 020 §3.3), in this
   repo.
2. The toolchain's usage extractor, which passed unchanged: it attributes
   touches to grants and treats an unrecognized kind as one it makes no claim
   about.
3. **The kernel's kind table, compiled into the `@statecrafting/kernel-native`
   binary**, which refuses to boot a model declaring a kind it cannot classify.
   That is enrahitu spec 021's ceiling working exactly as designed, and it means
   a new effect family cannot be introduced by the consumer at all: it takes an
   upstream change and a published release
   (`@statecrafting/kernel-native` 0.2.0).

The third is the one worth recording, because the instinct on meeting it is to
route mail through `http.egress` and move on. That would have bought a green
build by describing an SMTP socket as an HTTP request in the audit record, which
is worse than having no capability at all: an ungoverned channel is visible,
whereas a mislabelled one is not. **The cost of the closed vocabulary is a
release on the critical path of every new effect family; the benefit is that a
model cannot name its own ceiling into existence.** That trade is the whole
kernel plane in one line, and it is only legible from the consumer side when
something is refused.

### 3.3 A notice is a resource, not a function call

The obvious design calls `mailer.send(...)` where the decision is made. It is
wrong here for a reason that has nothing to do with taste.

Sending is not idempotent. Everything else in this substrate is: `admit`
normalizes to what is stored and returns without a revision (spec 034 §3.3),
which is what lets a controller reconcile the same membership a hundred times
and raise one invoice (spec 036 §3.7). A mail call reconciled a hundred times
sends a hundred emails, and the recipient is a person who now distrusts the
software.

So delivery is reconciliation over a resource, and idempotence comes from the
same place it comes from everywhere else: **the name**.

A `mailNotice` kind, tenant-scoped like the rest of the domain:

```
spec    : to, template, params, and the subject the notice is about
status  : state (pending | sent | failed), attempts, lastError,
          sentAt, nextAttemptAt
```

The name is derived from what the notice is **about**, never from a clock or a
counter: `dues-reminder-<invoice-name>` and not `notice-<uuid>`. Raising the same
notice twice therefore raises one, the second `admit` normalizes to the stored
spec and produces no revision, and a controller that crashes mid-pass and
re-reconciles from a reset watermark sends nothing twice. This is spec 036's
`invoiceNameFor` applied to a channel that cannot take back a mistake.

The delivering controller is leased (`dlock`, spec 030 §3.5), so at N=3 one node
sends. It is at-least-once and says so: a crash between the SMTP handshake
completing and the status write sends one duplicate, which is the honest
guarantee and is why the name carries the dedupe rather than the delivery.

**Retry is a status, not a queue.** A failed attempt records `attempts`,
`lastError` and a `nextAttemptAt` with exponential backoff; the controller skips
notices not yet due. After a bounded number of attempts (six, spanning about
half a day) the notice is `failed` and stays visible, because a notice that gave
up silently is worse than one that was never raised: the treasurer believes the
member was told.

"Stays visible" is a claim that needs a surface, so this spec publishes one
endpoint: `GET /api/notices`, operator-gated and read-only. **Retrying by hand is
deliberately not offered.** A notice is retried by the schedule, and a button
that re-sends is a button that sends a member their third copy of the same
reminder, which is precisely the failure the whole design is arranged to
prevent.

A second loop is needed for the same reason spec 036 §3.7 needs a calendar
sweep: **a deferred retry is not a write**, so the change feed can never deliver
"this notice's backoff has now elapsed". The change loop delivers newly raised
notices within a tick; a sweep every minute picks up the ones that have come
due. It enumerates tenants from the notices themselves rather than from the
tenant registry, so `backend/mail/` carries no dependency on the membership
domain: mail is a channel, and dues merely happen to be the first thing to use
it.

This is the research position that mail must not block a request, delivered
without a second piece of infrastructure. Nothing awaits a relay inside a
request: the endpoint admits a notice and returns, and spec 001's one container
and one volume is untouched. Redis and a job runner would buy retry semantics the
control plane already has and cost the thesis the whole architecture is organized
around.

### 3.4 The adapter seam

One interface, chosen by environment, with no provider name anywhere in domain
code:

```
interface MailTransport {
  send(message: Message): Promise<void>;
}
```

**A domain must not be able to reach this interface, and that is a structural
claim rather than a stylistic one.** Capability attribution is per service over
the import graph (spec 020 §3.4), so when `backend/members/` imported the mail
barrel, model verification refused the build:

```
service 'members' uses http.egress (via backend/mail/transport.ts)
beyond its declared ceiling
```

The barrel re-exported the transport, so importing it handed the membership
domain the transport's egress ceiling. The fix was a second module,
`backend/mail/notice.ts`, holding `raiseNotice` and the kind and reaching
nothing but the store; domains import that and never the barrel.

What makes this worth recording is the fix that was NOT taken. Granting
`members` the egress capability would have turned the build green in one line
and made §3.3's whole design ornamental: a domain that can reach the transport
can send inside a request, and the retry story, the idempotence and the
non-blocking guarantee all stop applying the first time somebody does. **The
extractor caught a coupling that a comment in the barrel was actively denying.**
An architectural boundary that is enforced only by where people choose to put
their imports is a boundary that lasts until the first hurry; this one is now
checked on every build.

`ENRAHITU_MAIL_TRANSPORT` selects it: `smtp` (through §3.2's capability), an
HTTPS provider (through `governedFetch`), or `none`.

`none` is not a testing convenience, it is the default. A deployment that has
configured no mail must not fail to boot and must not pretend to send: notices
are still raised and remain `pending`, visibly, so turning mail on later delivers
the backlog rather than discovering that six months of reminders evaporated. This
mirrors spec 026 §3.2's rule that an unconfigured relay is a stated limitation
rather than silent breakage.

### 3.5 Templates: chassis defaults, `app/` overrides

Templates ship in the chassis so a freshly stamped deployment sends sensible mail
on day one, and `app/mail/templates/<name>` wins when present.

**This is deliberately the opposite of the manifest overlay's rule**, and the
asymmetry is the interesting part. `scripts/gen-manifest.mjs` refuses an overlay
that redefines a chassis capability, because a silently overridden grant is a
widened security ceiling that reads, in the composed file, exactly like a chassis
decision. A template carries no privilege. An association overriding the wording
of its own dues notice is the entire point of the boundary, so here the override
wins silently and by design.

The cost is named rather than hidden: an upgrade that improves a default template
does not reach a deployment that overrode it, and cannot, because reaching it
would mean overwriting somebody's letterhead. `npm run upgrade:preflight` already
reports chassis files a deployment has edited; an overridden template is not one,
because it lives under `app/` and was never chassis. `app/mail/README.md` states
this so the trade is visible at the moment somebody makes it.

Templates render to text and HTML from one source. What that source is does not
belong in this spec beyond one constraint: it must not put React in the backend,
which today has none (React lives in `frontend/` and `frontend-admin/` under
standalone manifests, and this is a single-package repo with no workspaces).

### 3.6 Sender identity

`ENRAHITU_MAIL_FROM` is the association's address and is required whenever the
transport is not `none`. There is no default, deliberately: a fallback would put
a plausible-looking address on real mail sent to real members, and the failure
would be discovered by a bounce rather than by a boot.

The tenant (spec 036 §3.2) is the association, so at N=1 the sender is one value.
Per-tenant sender identity is not built here and is named in §5.

### 3.7 Verification

Mailpit (spec 026 §3.3) is already in the dev topology and this spec is its
second consumer, which is the argument for having chosen a catcher with a REST
API rather than only a UI.

- **The rule**, as pure functions: name derivation, backoff scheduling, and the
  decision of which notices a pass should attempt. No node, no relay.
- **The loop**, against a booted node: a notice raised twice produces one
  resource and one revision; a failing transport advances `attempts` and defers
  `nextAttemptAt` rather than retrying instantly; a notice that exhausts its
  attempts reaches `failed` and stays readable.
- **Delivery**, against Mailpit in the dev topology: a raised notice arrives,
  addressed from `ENRAHITU_MAIL_FROM`, and a second reconcile pass delivers
  nothing further.
- **The boundary**, mechanically: a module outside `backend/mail/transport.ts`
  importing a socket fails the check, and a service without `cap.smtp.*` is
  denied and ledgered.

  §3.2 says this check belongs in the toolchain's extraction ban-list, which is
  where the sibling rules live (`bare fetch`, the raw addon import). It is
  asserted in this repo instead, as a test that scans `backend/` for
  `node:net`/`node:tls`/`node:dgram` and expects exactly one file. The rule is
  mechanical either way and the enforcement point is not load bearing, but the
  in-repo version is strictly weaker in one respect worth naming: it protects
  this repo and not an app stamped from it. Moving it upstream is a follow-up
  against spec 020's ban-list, and until then a stamped app has the socket
  boundary as a convention rather than as a gate.

## 4. Acceptance

1. `ENRAHITU_SMTP_*` remains absent from the application process, and
   `ENRAHITU_MAIL_*` is absent from the rauthy process (§3.1, extending spec
   026 §4 item 1).
2. Sending through the SMTP transport adjudicates `smtp.egress` with the relay
   host as an attribute; a service without the capability is denied and the
   denial is ledgered.
3. Extraction fails for any module outside the transport that imports a raw
   socket or a mailer library.
4. Raising the same notice twice produces one resource and one revision.
5. A transport failure advances `attempts`, records `lastError`, and defers
   `nextAttemptAt`; the controller does not retry before it is due.
6. A notice exhausting its attempts reaches `failed` and remains readable, with
   the last error preserved.
7. With `ENRAHITU_MAIL_TRANSPORT=none` the app boots, notices are raised and stay
   `pending`, and nothing is sent. Configuring a transport later delivers the
   backlog.
8. A template present under `app/mail/templates/` is used in preference to the
   chassis default of the same name; absent one, the chassis default renders.
9. The transport refuses to start when `ENRAHITU_MAIL_FROM` is unset and the
   transport is not `none`, naming the variable.
10. In the dev topology a raised notice is delivered to the catcher from the
    configured sender, and a second reconcile pass delivers nothing further.
    Verified end to end on 2026-08-03: an expired membership raised its invoice
    and a `dues-reminder` arrived from `ENRAHITU_MAIL_FROM` with both parts
    rendered; two further sweeps delivered nothing; recording a backdated
    payment extended the term and produced exactly one `dues-receipt`.
11. `npm run typecheck && npm test` green, coupling gate green.
12. A domain package importing the mail barrel fails model verification, because
    the barrel reaches the transport and a domain must not (§3.4). Domains
    import `backend/mail/notice.ts`.

## 5. Out of scope

- **Inbound mail.** Nothing here receives, parses, or threads replies. A reply-to
  that reaches a human mailbox is the answer for as long as it is honest.
- **Per-tenant sender identity and per-tenant relays.** One association per
  deployment is the primary shape (spec 036 §3.2); multi-tenant senders need a
  credential store per tenant, which is a different problem.
- **Bulk and marketing mail.** These are transactional notices with a
  recipient-specific reason to exist. List management, unsubscribe semantics, and
  deliverability reputation are a different product and would drag suppression
  lists and bounce processing in behind them.
- **Bounce and complaint handling.** It needs inbound mail or a provider webhook,
  and a webhook is an ingress seam with its own authentication story.
- **Scheduling policy.** *When* a dues reminder is raised is the domain's
  decision and belongs with the domain (spec 036 §3.7's rule already knows the
  dates). This spec delivers what the domain raises.
- **Rendering engine choice**, beyond §3.5's one constraint. What shipped is
  plain text with `{{param}}` substitution, rendering to text and to HTML from
  the one source, which satisfies the constraint and adds no dependency.
- **Chasing a member more than once per term.** One reminder is raised when dues
  become outstanding and one receipt when they are paid. A schedule of reminders
  (30 days, 7 days, overdue) is a policy with a shape of its own: it needs a
  notice name per occasion, so that each is idempotent separately, and it needs
  somebody to decide how often an association may write to a member who has not
  paid. That is spec 036's decision to make, not this one's.

## Amendment (2026-08-06): the sweep waits for the schema too

Spec 034's amendment of the same date moves the control-plane schema wait into
`startController`, which fixes the delivery controller here without this module
changing. The sweep (§3.3) is not a controller: it scans `resource` on its own
minute timer, so it kept its own copy of the defect at a minute's cadence
instead of a second's. Quieter, equally permanent, and equally a fault reported
for a state that is merely a deploy step not yet run.

It now takes the same gate: `awaitControlSchema`, waiting rather than failing,
cancellable so `stop()` returns promptly, and reporting a probe failure through
its own log line rather than confusing it with an absent table.

**Nothing in `startMailRuntime` changes.** Mail still starts unconditionally and
still reports itself started, because both of its loops now hold their own
precondition. The alternative was to copy `backend/members/boot.ts`'s wait into
mail's boot, which is what this amendment's sibling in spec 034 identifies as the
thing that went wrong the first time: a precondition each caller must remember.
Notices raised before the schema exists are held as pending, which is the same
state a misconfigured relay produces (§3.4) and needs no separate handling.
