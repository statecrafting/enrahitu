---
id: "036-membership-core"
title: "The membership core: members, tiers, memberships, dues"
status: approved
created: "2026-07-30"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "021-kernel-native-consumption"
  - "032-hiqlite-interface-contract"
  - "034-control-plane"
  - "035-chassis-boundary"
establishes:
  - { kind: directory, path: "backend/members/" }
summary: >
  Phase 5 of the pivot (spec 001 §5.1), first slice. The association domain
  stops being a promise the machinery is built for and becomes ordinary
  application code: five kinds registered at runtime, a renewal controller that
  raises dues and lapses memberships, and a service with its own grants and its
  own endpoints. It is deliberately one domain built completely rather than
  eleven built shallowly, because the remaining domains are the same shape and
  the shape is what has to be right. Three decisions are load bearing and none
  of them was visible before the domain existed: the tenant is an
  operator-chosen slug required at provisioning and guarded by a boot assertion
  that refuses to start against rows written under a different one, because the
  identity that seeds every primary key must not be re-mintable by losing a
  volume; referential integrity is observed as status rather than enforced at
  admission, because the store has no foreign keys and a refusal would hide the
  dangling reference instead of showing it; and the fencing token doubles as
  optimistic concurrency for human edits, which is what lets a person edit a row
  a controller has written.
---

# 036: The membership core

## 1. Purpose

Spec 034 built the control plane and spec 035 drew the boundary around it. Both
were written for a domain that did not exist yet, and a machine built for a load
it has never carried is a hypothesis. This is the load.

It is also the first change in the corpus with a buyer's question attached
rather than an architect's. Spec 001 §4.1 names the reader: a 200-member
association with no ops team. What that reader wants is to know who is a member,
what they owe, and who has lapsed. Everything below is that, and the test of the
substrate is whether it took ordinary code to say it.

**One domain, completely.** The association domain is members, tiers,
renewals, dues, events, registrations, volunteers, documents, board governance,
announcements, and discussion. Shipping eleven shallow domains would produce
eleven half-answers and no proof, because the questions that break a design are
the second-order ones: what happens when a tier is deleted while memberships
reference it, what happens when a controller and a person write the same row,
what happens when the reconciler runs twice. Those only appear when one domain
is finished. The rest land afterwards in the shape this one establishes.

## 2. Territory

`backend/members/`: the kind registrations and their validators, the tenant
seam, the renewal rule and its controller, the endpoints, and the barrel. Plus a
`members` service in `app-manifest.chassis.json` holding six grants.

It amends, without owning:

- **spec 034**: admission gains a status-write path. 034 §5 named `status` as
  "a column a controller writes through the same admission path" and the
  implementation had no such path, so status was unwritable. §3.5 below.
- **spec 001 §5.3**: the definition of `Tenant`, which §3.2 needs to be
  unambiguous before it goes into a primary key.

It deliberately does **not** carry the schema verb. §3.6 states the precondition
this domain runs on and fails legibly without it; supplying it is a separate
change against specs 023 and 027, with its own decision, because an operator
endpoint and a primary key have nothing in common except that both were needed
this week. Key shape is expensive to revisit and an endpoint is not, and bundling
them would put one Decision record over two reversibility profiles.

## 3. Behavior

### 3.1 Five kinds, and what a kind is allowed to be

| kind | scope | written by | holds |
|---|---|---|---|
| `tenant` | cluster | operator | the association's display name and contact |
| `tier` | tenant | operator | dues amount, period, voting rights, grace days |
| `member` | tenant | operator | a person: display name, email, optional rauthy `sub` |
| `membership` | tenant | operator (spec), controller (status) | a member bound to a tier for a term |
| `duesInvoice` | tenant | controller (spec), operator (status) | one term's dues, and whether they are paid |

Every one of them is a runtime registration with no migration, which is the
property spec 035 §3.4 said would make the boundary cheap, now spent for the
first time. The five kinds added zero DDL.

**`spec` is intent and `status` is observation, and the writer differs by
column.** A person says what should be true: this member holds this tier until
this date. A controller says what is true: the term expired, the invoice is
open, the membership is pending. Putting both in one column would make every
reconcile a read-modify-write against a value an operator may have changed
underneath it.

The one asymmetry worth naming: `duesInvoice` inverts the usual writer. Its
`spec` is written by the controller, because an invoice is derived from a
membership and a tier rather than authored, and its `status` is written by a
person, because payment is something a treasurer records. That inversion is why
§3.4's fencing rule had to be worked out rather than assumed.

### 3.2 Tenancy: an operator-chosen slug, required at provisioning

**Kinds are tenant-scoped, and the tenant is an operator-chosen slug read from
`ENRAHITU_TENANT`.** It is required in production and the app refuses to start
without it; outside production it defaults to the literal `local-dev`. It is
never `''`, never `"default"`, and never generated.

**Why tenant-scoped, stated as the reason that actually holds.** One deployment
serves one association (spec 001 §4.1), so a single-value column looks like
ceremony, and the tempting argument for it is wrong: putting the tenant in the
key is *not* protecting the Decision chain. The chain hashes Decision records in
`kernel_decisions`, and `verifyChain` reads that table only, so rewriting a
resource row's tenant later could not break it. There is no fork and no
re-anchoring to avoid.

What a later backfill would actually cost is a permanent footnote in the audit
story: historical records naming `member/-/ada` while the live row is
`member/hollis-society/ada`, so "who changed this member" needs a documented
translation rule at the cutover date, forever. Real, permanent, and small.

The decision therefore rests entirely on the cost comparison, and that is enough:
the cost of carrying the tenant now is approximately zero, because `admit`
demands a tenant from a tenant-scoped kind and every call site passes one either
way. A free left-hand side does not need a large right-hand side.

**Why not a generated identifier**, which is where this spec's first draft went.
An opaque `org-<hex>` minted at first boot is a sentinel with more entropy, and
it fails three ways. It makes the value that seeds every primary key
machine-specific, so fixtures, seed data, and cross-environment comparison stop
lining up. It puts the identity that determines every key in a text file with no
admission record and no provenance, so losing the volume silently mints a new one
and orphans every row that survived. And opacity is bought for a collision that
cannot happen: fleet-hosting produces separate apps (§5.3 as amended), so there
is nothing to collide with, and the cost is a meaningless string in every URL,
log line, and Decision reason forever. A fixed dev default is the right answer to
dev ergonomics; a generated one is strictly worse in dev for the first reason.

**The boot assertion, which matters more than the choice of identifier.** At
start, if any resource row carries a tenant other than the resolved one, the app
refuses to start and names both values. This is the only thing standing between a
deployment and a silently bifurcated dataset, and it catches the three ways that
happens: an edited environment variable, a lost or swapped volume, and a config
file copied between deployments. It is a read of one row.

**The narrow claim, so it is not over-trusted later.** This avoids a permanent
translation rule in the audit story. It does **not** make the app multi-tenant
ready. `tenantId()` has only ever returned one value, so it is untested for the
case it exists to serve, and the expensive part of multi-tenancy is isolation
correctness rather than key shape.

**And the isolation hole has a name.** Two of the three read paths are
structurally gated: `get` and `list` both resolve the tenant through the same
helper the write path uses and carry `tenant = $2` in the statement, so a
tenant-scoped kind cannot be read without one. The third, `changesSince` (spec
034 §3.4), has no tenant predicate at all and is not going to get one: the
revision sequence is global and a controller is a cluster-level process, so the
change feed crosses tenants by construction. Every reconciler must therefore
thread `change.resource.tenant` into each read and write it makes, and nothing
structural stops it forgetting. That is the live surface, it is the renewal
controller, and §4 item 12 asserts it against two tenants rather than leaving it
as a caveat.

Spec 001 §5.3 is amended in the same change to say what a `Tenant` denotes,
because a key is a commitment to a denotation and §5.3 named three candidates
without separating them. A tenant is **the association**. Chapters are
subordinate scopes within one tenant and never appear on this axis;
fleet-hosting produces separate apps, not tenants inside one app.

### 3.3 Referential integrity is observed, not enforced

A `membership` names a `tier` and a `member` by name, and nothing stops either
from being retracted afterwards.

Admission could refuse the dangling case, and deliberately does not. To check a
reference at admission time it would have to read another resource inside the
admitting transaction, which is a second store crossing on the write path for a
guarantee that expires the moment the referent is retracted: the check would
pass at write time and the row would dangle an hour later anyway. Enforcement
that cannot hold is worse than no enforcement, because it reads like a
guarantee.

So the controller reports it. A membership whose tier is not registered gets
`status.state = "invalid"` naming the missing tier, which is visible in the
list, visible to the operator, and correct: retracting a tier that memberships
still reference is a thing an operator may legitimately do, and the right
response is to show what it broke rather than to make it impossible.

### 3.4 The fencing token is also the human's concurrency control

Spec 034 §3.3 made `fence` a high-water mark per row: a write carrying a token
below the stored mark raises `SupersededError`. It was designed for one
question, which is a controller that lost its lease mid-reconcile.

The domain produces a second question 034 did not have to answer. The renewal
controller writes membership status under its pass token, so the row's mark
becomes non-zero. A person then edits that membership, holding no lease and no
token, and a naive `admit` with the default `fence: 0` is refused forever.

**The rule: an endpoint updating an existing resource passes the fence it
read.** Read the row, send `fence: existing.fence` with the write. This is four
lines in one helper and it resolves both questions at once:

- A person can always land a write on a controller-written row, because the mark
  they read equals the mark stored.
- If a controller wrote in between, the mark moved, the person's write is
  refused, and the endpoint answers 409 rather than silently clobbering. The
  fence has become optimistic concurrency for the human plane at no cost.

A person can still overwrite a controller's concurrent write when nothing moved
between the read and the write, and that is correct: a person editing a record is
intent, not a lost lease. The fence protects controllers from each other, which
is what it was built for.

### 3.5 The status-write path (amends spec 034)

`admit` writes `spec`. Its `ON CONFLICT` clause sets `revision`, `fence`,
`spec`, `deleted_at`, and `updated_at`, and never `status`, so before this change
`status` could be read and could not be written by anything. Spec 034 §5 assumed
otherwise, which is the kind of gap that only a consumer finds.

`setStatus(kind, name, status, opts)` is the same five steps in the same order:
validate is skipped because status has no kind validator (it is the controller's
own shape, and inventing a second validator vocabulary for it would make the
kind registry describe two things), then adjudicate, commit the row and its
outbox row in one `txn`, read back, notify after the commit.

It carries §3.3's no-op rule unchanged and for the same reason: **a status write
that changes nothing produces no revision.** The renewal controller writes status
to a kind it watches, so without the rule every reconcile would produce a change
that triggers a reconcile. With it, a converged membership produces exactly one
extra pass and then goes quiet, which is what §4 item 5 asserts.

Status writes are fenced by the same mark as spec writes rather than by a second
column. A separate `status_fence` would be more precise and would need a
migration, and §3.4's rule already makes the shared mark behave correctly for
both writers. When two controllers eventually contend for one resource's status,
that is the moment for spec 034 §5's status subresource, and not before.

### 3.6 The schema precondition, and failing legibly without it

The control plane's tables exist in tests and nowhere else: nothing in the tree
applies `CONTROL_PLANE_MIGRATIONS` to a deployed container. This domain
therefore ships on a schema a deployment does not yet have, and says so rather
than discovering it at the first request.

Spec 032 §3.6 settled that migration is a deploy step and not a boot step, and
that stands; this spec does not reopen it and does not supply the verb. What it
owns is the behavior in the meantime:

- Every members endpoint maps a missing `resource` table to a 503 naming the
  precondition, rather than surfacing `no such table: resource` from four frames
  down. An operator reading that message learns what to do.
- The renewal controller starts only once the schema is present, and polls for it
  rather than failing a pass every second forever. A controller that logs an
  error per tick trains an operator to ignore the log.

**Exactly one startup failure is fatal, and the distinction is the point.** A
tenant mismatch (§3.2) exits the process, because serving past it would write a
second, invisible dataset alongside the real one: silent, compounding, and worse
the longer it runs.

**Everything else leaves the application up with the domain down.** The first
version exited on any startup error and was wrong within a minute of meeting a
real container: hiqlite refused to open a volume left locked by an unclean
shutdown, and a domain that could not start took `/healthz`, the operator
dashboard and the login flow down with it. Those are precisely the surfaces an
operator needs in order to diagnose a store that will not open. So the domain
stays down, its endpoints answer the 503 above, and the rest of the application
keeps serving. The general form: a subsystem's failure may not be allowed to
remove the instruments used to diagnose it.

Bringing the domain up therefore has a fixed order, and each step depends on the
one before: wait for the schema, refuse a foreign dataset, ensure the
association's own record exists, and only then start the loops. **Ensuring the
record means create-if-absent and nothing else.** `admit` writes the spec it is
given, so admitting unconditionally at every boot would reset an operator's
chosen display name back to the tenant slug on every restart: a change that
reverts itself overnight and looks like somebody else undid it.

The verb itself is the next change, against specs 023 and 027 (027 §3.4 owns
`migrate` and currently describes it against CoreLedger only). Its shape is
already constrained by where the store is: at N=1 the embedded node holds the
volume open, so no second process can reach it, and the deploy step has to be
performed by the running app under an authenticated operator rather than by a
script on the host. That reasoning belongs in that change's spec, with its own
decision, and is recorded here only so the seam is not mistaken for an oversight.

### 3.7 The renewal loop

The reconcile decision is **a pure function of the membership, its tier, its
current invoice, and today's date**, returning a plan; the controller performs
the plan. Splitting it that way is not for testing convenience. A renewal rule is
a policy a board approves, and a policy that can only be read as a sequence of
store calls cannot be reviewed by the people whose policy it is.

```
tier not registered         -> invalid, naming the missing tier (§3.3)
lifetime tier, no endsOn    -> active, no dues, no expiry
lifetime tier, with endsOn  -> invalid: the term contradicts the tier
billed tier, no endsOn      -> invalid: a billed tier needs a term to bill
today < endsOn              -> active, renews on endsOn
today >= endsOn, manual     -> lapsed on endsOn
today >= endsOn, auto       -> raise the invoice for the next term, then:
                                 paid        -> extend the term, active
                                 void        -> lapsed on endsOn
                                 past dueOn  -> lapsed on the day it was due
                                 otherwise   -> pending, dues outstanding
```

The branches are evaluated in that order, and three of them are the shape checks
that §3.3's decision forces into the rule. A validator cannot reject a lifetime
membership carrying an end date, or a billed one missing it, because whether
`endsOn` is required depends on the tier's period and the tier is a second
resource: reading it at admission would be enforcing referential integrity there,
which this domain deliberately does not do. So a contradiction between a
membership and its tier is reported the same way a missing tier is, as `invalid`
with a problem an operator can act on.

**Voiding is how an association declines to renew somebody** without pretending
the invoice was paid. It lapses the membership on the day the term ended rather
than on the day of the void, because the void records a decision about the term
and not a new event in it.

**A term is a calendar day, never an instant.** Terms, due dates and payment
dates are `YYYY-MM-DD` and the arithmetic is UTC-anchored string arithmetic. A
timestamp would make the answer depend on the reader's timezone: two operators in
different offsets would see different lapse dates for the same row, and the one
who is wrong would have no way to tell. The only clock read in the whole renewal
path is `today()`, and the rule takes the day as an argument rather than calling
it, so every branch is reachable in a test at the date that produces it.

**Advancing a period clamps to the end of the target month.** Adding one month to
January 31st is March 3rd under naive arithmetic, so a monthly membership taken
out on the 31st would skip February and drift forward a month every year; the
same arithmetic sends a leap-day annual term to March 1st in a common year rather
than to February 28th. Both are wrong in the direction that silently moves
somebody's renewal date, so the period advance clamps and the two cases are
asserted rather than reasoned about.

**The invoice name is the idempotence key.** It is
`<membership>-<periodStart>`, deterministic from the term being billed, so a
controller that reconciles the same membership a hundred times raises one
invoice: the hundredth `admit` normalizes to the spec already stored and returns
without a revision (spec 034 §3.3). The controller does no bookkeeping to achieve
that, holds no memory of what it has raised, and is correct after a crash, a
replay, or a watermark reset. This is the single clearest demonstration in the
tree of why the no-op rule is load bearing rather than an optimization.

The controller watches `membership` and `duesInvoice`, and reconciles by
membership in both cases: a payment recorded against an invoice is how a
membership learns it can renew. That is the full loop, and it is the one that
makes the control plane worth its weight: an operator records a payment on one
resource, and a different resource converges to a new state without anything
calling anything.

**But a change feed cannot observe the passage of time, so there are two loops.**
Spec 034's watch answers "what has been written since revision N", and a
membership whose term expires tomorrow is not written tomorrow: nothing happens,
which is precisely the event the rule cares about. A purely change-driven
controller would lapse nobody until somebody happened to edit their row, and the
defect would be invisible in every test that writes something.

So the change loop reacts to writes and a **calendar sweep** reacts to the
clock, listing every membership in every tenant and reconciling each one. It runs
hourly: the rule's inputs change at most once a day, so a shorter interval buys
nothing an operator would notice and a longer one delays a lapse past the day it
happens. It keeps no watermark and re-lists from the top, which is what makes it
safe to bound with a time budget and stop early.

**One membership that cannot be reconciled does not stop the pass.** The
enumeration is ordered, so a reconcile that threw would silently drop every
membership after it: a single malformed row would leave the rest of the
association unbilled, every hour, indefinitely, and the only symptom would be
dues that never appear. A failure is logged with the membership that caused it
and the sweep continues, which is safe precisely because it keeps no watermark:
the next pass tries the row again. This is the difference between a loop that
converges what it can and one whose worst row sets the pace for everybody.

**Both loops share one lease key** (`ctl:renewal`), and that is load bearing
rather than tidy. They write the same rows, and the fencing token is monotonic
per key (spec 032 §3.4), so one key buys two properties at once: the loops never
run concurrently, and whichever acquires later necessarily holds the higher
token, so neither can be refused as superseded by the other. Two keys would
produce interleaved tokens and a steady trickle of `SupersededError`s that mean
nothing and would train an operator to ignore them. A sweep that loses the lease
to the change loop has simply not happened, and the next one will.

Convergence after a payment takes three passes and then stops. Pass one extends
the term (a spec write) and sets status pending to active; pass two observes the
change it made and computes the same status; pass three has nothing to observe.
A test asserts the third pass writes nothing, because "converged means quiescent"
is invisible in code that is working.

### 3.8 The two planes

`members` publishes both an operator plane and a member plane, gated
differently, which is spec 001 §4.4's separation reaching the domain for the
first time.

The operator plane requires the `<app>_operator` role and is the association's
staff: the association record itself (`GET`/`PUT /api/org`), tiers (list, `PUT`,
`DELETE`), members (list, get, `PUT`, `DELETE`), memberships (list, `PUT`), and
dues (list, `POST /api/dues/:name/paid`, `POST /api/dues/:name/void`). Retracting
a tier or a member is deliberately available and deliberately not a cascade: §3.3
says a dangling reference is reported rather than prevented, and a delete that
quietly removed memberships would be the enforcement §3.3 refused, arriving
through the back door.

The member plane is one endpoint, `GET /api/me/membership`, which requires only
an authenticated session and answers strictly about the caller, returning that
member's own record, membership and outstanding dues. **It takes no name
parameter**, which is the structural half of its authorization: an endpoint that
reads "the member named X" and then checks whether X is you is one refactor away
from forgetting.

**The join from a session to a member record is `sub` first, verified email
second**, and the fallback is a compromise with a stated expiry rather than a
design. Spec 001 §5.3 makes rauthy's subject the durable binding, but an
association enrolls members long before any of them logs in, so requiring `sub`
would leave every pre-enrolled member unable to see their own dues: the feature
would be correct and useless. Matching the email closes that gap because member
emails are normalized by the kind's validator, so both sides compare like with
like.

**The weakness in that fallback is named here rather than discovered later.**
Matching on an email is only sound if the session's email is one the identity
provider verified, and nothing in the application checks that today: no
`email_verified` claim is threaded through to the session, and the SSO profile
substitutes `preferred_username` when the `email` claim is absent, which is not
an email and is not verified under any provider. Against rauthy this is latent
rather than live, because rauthy's own registration flow proves control of the
address before a session exists at all. It is latent on a property of the IdP's
configuration rather than on anything this code enforces, which is the wrong
place for an authorization rule to rest. Closing it belongs to spec 004's rewrite,
which is where the session's claims are minted and where enrollment can write
`sub` at first login; the fallback retires when it does.

### 3.9 Backdating a payment, and a divergence that was not one

A treasurer records a cheque that arrived last week. `POST /api/dues/:name/paid`
therefore takes an optional `paidOn`, and where that field rides is forced by
the toolchain rather than chosen:

- **In the body it would not work.** One optional body field makes the body
  mandatory, so a bare `POST .../paid` (the common case, "paid today") answers
  400 `unable to decode request body: EOF while parsing a value at line 1
  column 0`. That is a terrible answer to a correct request.
- **In the query string it works.** The bare POST answers 200 and the value
  arrives when one is sent.

The first revision of this domain recorded that the query-string form "parsed on
the host and failed in the container against the same toolchain version", and
shipped the endpoint with no backdating at all on that basis. **The divergence
does not exist.** At the same toolchain version (0.4.0, unchanged since spec 032
landed and therefore unchanged across the whole life of this domain), the
container parses the query parameter, builds it into the same 24623-byte
metadata the host produces, and decodes it correctly at runtime on the
linux-arm64 runtime binary, both present and absent.

Recording why the wrong conclusion was reached is the point of this section,
because the same trap is still available. The container was observed to reject
the endpoint during the window when the dev loop had the two defects spec 033
later fixed: a failed parse left the watcher believing a build was still running,
so it stopped rebuilding and went on serving the previous bundle, and every
restart left a stale state-machine lock that made the restarted app answer 500
on `/readyz`. Both present as "the host is fine and the container is broken," and
neither has anything to do with the code being edited. **A host/container
divergence claimed while the dev loop is unsound is a claim about the dev loop.**
The general form: an observation whose mechanism cannot be named is a symptom,
and writing it into a spec as a constraint gives it an authority the evidence
never had.

The rule itself is small and lives as a pure function so its branches are
reachable without a node. Absent, the day is today. Present, it must be a day
that exists and must not be in the future, refused naming the field: a receipt
dated forward records nothing that happened, and the ordinary way to produce one
is a typo in the year. The clock is read once and passed in, so the default and
the comparison cannot straddle midnight.

Backdating cannot move a term. §3.7's rule reads the invoice's state and its
`periodEnd` and never `paidOn`, so the day money arrived is bookkeeping and never
an input to what it bought.

## 4. Acceptance

1. The tenant resolves from `ENRAHITU_TENANT`, refuses to resolve in production
   when it is unset, and defaults to `local-dev` outside production.
2. Every validator normalizes rather than approving: a member admitted with
   untrimmed input is stored trimmed, and an invalid tier period is refused
   naming the field.
3. A membership whose tier is retracted reports `invalid` naming the missing
   tier, and reports `active` again when the tier is restored.
4. An expired auto-renewing membership raises exactly one invoice across
   repeated reconciles, and the second reconcile produces no revision.
5. Recording payment renews the term, and the controller reaches quiescence: a
   third pass writes nothing.
6. An expired manual membership lapses; an unpaid invoice past its due date
   lapses; a lifetime membership never lapses.
7. A person editing a membership the controller has written succeeds when they
   pass the fence they read, and is refused with 409 when the controller wrote
   in between.
8. `setStatus` on an unchanged status produces no revision and no outbox row.
9. The member plane returns only the caller's own record: it prefers the durable
   `sub` binding, falls back to the session's email, and returns 404 rather than
   another member's row when neither matches (§3.8).
10. With the schema unapplied, a members endpoint answers 503 naming the
    precondition rather than a SQL error from four frames down.
11. A service without the state grants is denied admission of a domain kind.
12. The boot assertion refuses to start when stored rows carry a tenant other
    than the resolved one, and names both values.
13. Two tenants reconcile independently through one controller pass: each
    membership's dues are raised against its own tenant, and neither tenant's
    pass reads or writes the other's rows. This is asserted rather than assumed
    because the change feed carries no tenant predicate (§3.2).

14. A payment records today when no day is sent, records the day sent when one
    is, and refuses both a day that does not exist and a day in the future,
    naming the field (§3.9).
15. Every branch of §3.7's table is reachable and asserted, including the three
    that report `invalid`: a missing tier, a lifetime tier carrying `endsOn`, and
    a billed tier missing it. A voided invoice lapses the membership on the day
    the term ended.
16. Advancing a period clamps to the end of the target month: a monthly term
    dated the 31st does not skip February, and a leap-day annual term lands on
    February 28th in a common year.
17. The calendar sweep reconciles every membership without being prompted by a
    write, repeats the full pass rather than consuming a feed, and shares the
    change loop's lease so the two never run concurrently and neither supersedes
    the other. One membership that cannot be reconciled is logged and skipped,
    and the memberships after it in the enumeration still converge (§3.7).
18. A startup failure that is not a tenant mismatch leaves the application
    serving and the domain answering 503, rather than taking the process down
    (§3.6). The association record is created when absent and is not overwritten
    on a subsequent boot.

All of these are asserted in `backend/members/members.test.ts` against a booted
node, except the pure renewal rule, the calendar arithmetic, the payment-date
rule and the identity join, which are asserted directly in
`backend/members/renewal.test.ts` at every branch of §3.7's table and §3.9's.

## 5. Out of scope

- **The remaining domains**: events, registrations, volunteers, documents, board
  governance, announcements, discussion. They are the same shape (kinds, a
  controller where something converges, a service with its own grants) and land
  in follow-up specs. This one establishes the shape; it does not gate them.
- **Payment processing.** Recording that dues were paid is a treasurer's entry.
  Taking money is a payment provider integration, an egress seam, and a
  reconciliation problem of its own.
- **Dues notices by mail.** Spec 037 owns the application's outbound channel
  (spec 026 owns the IdP's, which is a different surface for a different
  sender), and a renewal controller that also sent email would own a delivery
  guarantee it cannot make. The `pending` status and its due date are what a
  notice is built from, and *when* to raise one stays this spec's decision:
  037 delivers what the domain raises and does not schedule it.
- **Per-kind capability grants.** The `members` service holds `db.txn` on
  `state`, which is every kind, and spec 034 §3.3 already records why the axis
  buys nothing while all kinds share one table. Still carried on spec 020 §3.4's
  extension list.
- **Proration, partial payments, refunds, and credit balances.** An invoice here
  is open, paid, or void. The next state a real association asks for is partial
  payment, and it needs an amounts model rather than a status enum.
- **A status subresource with its own concurrency** (spec 034 §5), which §3.5
  records is not needed until two controllers contend for one status.
