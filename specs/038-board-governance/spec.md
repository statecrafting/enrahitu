---
id: "038-board-governance"
title: "Board governance: meetings, motions, ballots, and the frozen roll"
status: approved
created: "2026-08-03"
implementation: pending
depends_on:
  - "001-enrahitu-architecture"
  - "021-kernel-native-consumption"
  - "034-control-plane"
  - "035-chassis-boundary"
  - "036-membership-core"
  - "037-app-mail"
establishes:
  - { kind: directory, path: "backend/governance/" }
summary: >
  Phase 5's second slice (spec 001 §5.1). Spec 036 built one domain completely
  to find the second-order questions; this is the domain that tests whether the
  shape it found generalizes, and it does, with three additions that only a
  domain producing a durable public record asks. A meeting freezes both its roll
  and its quorum rule at the moment it is called, because memberships lapse on a
  calendar and bylaws are amended, so a quorum recomputed at the tally makes a
  minute whose answer changes after the fact, and a tally that can change is not
  a record. A ballot is named `<motion>-<member>`, so one vote per member is
  structural rather than checked, from the same mechanism that gives spec 036
  one invoice per term; it also makes a ballot the first resource in the corpus
  whose spec an ordinary member writes, which is what turns the Decision chain
  into a voting record rather than an operations log. And eligibility is refused
  at the endpoint and decided again at the tally, because the endpoint is the
  only place the caller's identity exists and the tally is the only place that
  can be authoritative about everything that did not arrive through it.
---

# 038: Board governance

## 1. Purpose

Spec 036 shipped one domain completely on the deliberate bet that "the remaining
domains are the same shape and the shape is what has to be right" (§1). A bet
stated in the spec that makes it is not evidence. This is the second domain, and
its first job is to be ordinary: five kinds, one controller with a change loop
and a calendar half, a service with its own grants, and no new machinery in
`backend/control/`.

Its second job is the one 036 could not do. Dues are an internal record: if the
renewal controller gets a term wrong, a treasurer corrects the row and nothing
outside the software believed anything in the meantime. A governance record is
consumed by people who were not in the room and will read it years later, and it
is the artifact spec 034 §3.7 named when it justified appending allows to the
Decision chain: "a ledger holding only denials answers 'what was stopped' and
cannot answer 'who changed this', which is the question a board minute or a
grant audit actually asks." That claim has been carried for two specs without a
consumer. This is the consumer, and the interesting parts of this document are
where the claim turns out to be worth exactly what it says and not more (§3.3,
§3.11).

## 2. Territory

`backend/governance/`: the five kind registrations and their validators, the
roll and quorum rules, the tally rule, the lifecycle rule, the controller and
its sweep, the endpoints, and the barrel. Plus a `governance` service in
`app-manifest.chassis.json` holding the same six grants `members` holds.

It amends, without owning:

- **spec 036 §3.1**: the `tenant` kind gains a `governance` block holding the
  association's bylaws constants (notice period, the two quorum rules, the
  default threshold). §3.2 records why they are association-level data rather
  than per-meeting operator input.
- **spec 037**: one chassis template, `backend/mail/templates/meeting-notice.txt`.
  Nothing in the resolver changes; an association overrides the wording under
  `app/mail/templates/` exactly as it overrides a dues notice (037 §3.5).

It imports `backend/mail/notice.ts` and never `backend/mail/`, for the reason
that module's header records: capability attribution is per service over the
import graph (spec 020 §3.4), and reaching the barrel would give this service
the transport's `http.egress` ceiling and with it the ability to send inside a
request. It imports `backend/members/identity.ts` and `backend/members/dates.ts`
directly for the same reason and by the same rule.

It deliberately does **not** carry elections. §5 records the boundary and why it
falls there.

## 3. Behavior

### 3.1 Five kinds, and the two audiences that shape them

| kind | scope | written by | holds |
|---|---|---|---|
| `officer` | tenant | operator | a seat, the member holding it, and the term |
| `meeting` | tenant | operator (spec, and the roll at the call), endpoints and controller (status) | audience, the instant, the frozen roll and rule, the lifecycle state |
| `motion` | tenant | operator (spec), controller (status) | the text, the threshold, mover and seconder, the poll window; status carries the tally |
| `ballot` | tenant | **the voter** (spec) | motion, member, and one of yes, no, abstain |
| `minutes` | tenant | operator (spec), controller (status) | a meeting, the text, and the approval |

Five more runtime registrations and still zero DDL, which is spec 035 §3.4's
property spent a second time and is the first evidence that it was a property
rather than a coincidence of the first domain.

**A meeting has one of two audiences, and that fork is what shapes the rest.** A
`general` meeting's electorate is every member whose membership is active and
whose tier carries `votingRights` (spec 036 §3.1 already put that flag on the
tier, for this). A `board` meeting's electorate is the officers whose term
covers the day and whose seat votes. Two sources, one answer, and the temptation
is to express the electorate as a query evaluated wherever it is needed. §3.2 is
why it is not.

**`ballot` is written by an ordinary member**, which no kind in the corpus has
been. Until now the member plane was one read-only endpoint (spec 036 §3.8) and
every admitted write in the tree came from an operator or a controller. §3.10
records what that changes.

### 3.2 The meeting freezes its roll and its rule

**When a meeting is called, the call endpoint materializes the electorate into
the meeting's spec: the list of eligible member names and the count.** It is
written once and never recomputed. The quorum rule and the default threshold are
copied in beside it, from the association record, at the same moment.

The endpoint takes the roll rather than the controller, which is the one place
in this domain where synchronous beats reconciled: the two refusals below are
answers to an operator's request, and an operator who calls a meeting and learns
an hour later from a status field that the roll was empty has been told too late
to act on it.

The obvious design evaluates the electorate when it is needed, and it is wrong
here in a way that is invisible for months.

**The roll would not hold still.** Memberships lapse on a calendar (spec 036
§3.7), so the set of members with voting rights is different on the day of the
meeting than on the day it was called, and different again on the day somebody
reads the minute. A quorum computed at the tally is therefore a quorum against
whichever roll the clock happened to produce, and re-deriving it later gives a
third answer. The failure mode is not an error: it is a minute that says a
motion carried and a recomputation, two years later, that says the meeting was
inquorate. Nothing in the software would flag the disagreement, because both
computations are correct about their own moment.

**The rule would not hold still either.** Bylaws are amended, quorum fractions
change, and an amendment between the call and the tally would silently re-decide
a meeting already in progress. Freezing the rule is the same decision as
freezing the roll and is easy to forget precisely because the rule feels like
configuration rather than data.

That is what a record date is for in every association's bylaws, and this is
what it is here: **the roll is taken at the call, and the day it was taken is
recorded on the meeting.** A member who joins the day after the call cannot vote
at that meeting, which is the intended behavior and not a limitation.

**The second reason is smaller and independently sufficient.** Materializing
collapses two electorate queries into one stored list, so the tally has exactly
one input shape for both audiences. Two live queries would be two code paths
that must agree about eligibility forever, and they would drift at the first
change to either, in the direction that is hardest to notice: a board meeting
and a general meeting disagreeing about what "active" means.

**The roll rides in `spec` and not in `status`.** A status is "a function of the
situation, not of when somebody looked at it" (036's `kinds.ts`), and a frozen
roll is the exact opposite of that: its whole value is that it is a function of
one past moment. But it is not observation either. It is the meeting's declared
electorate, which is intent, and being derived rather than authored does not
make it a status: `duesInvoice` already puts controller-derived content in `spec`
(036 §3.1), so the precedent that derivation and observation are different
questions is already set.

Putting it in `status` would create the one status field in the corpus that must
never be recomputed, sitting in the column every reconciler in the tree is
written to recompute. That is a trap laid for whoever reads the pattern and
follows it.

**Which forces the call to be a transition rather than an edit.** If the roll
sits in the meeting's spec, an operator's ordinary `PUT` of a meeting would
replace the whole spec and drop it. So a meeting is drafted first and called
second: in `draft` an operator edits agenda, audience and time freely and there
is no roll, and `POST /api/meetings/:name/call` takes the roll, copies the rule,
raises the notices, and closes the spec to further edits. That is also what an
association actually does, and it is the reason the merge hazard is not worth
solving: **you cannot change the agenda of a called meeting.** Changing it means
cancelling that meeting and calling another, which is a fresh notice to a freshly
taken roll and is what an association does anyway. There is deliberately no edge
back to `draft`: a meeting whose notice has gone out and whose agenda then
changed is a different meeting, and giving it the same name would leave the
notices already delivered describing something that no longer exists.

Two things are refused at the call rather than discovered at the tally, and both
are ordinary operator errors:

- **An empty roll.** No tier carries voting rights, or no officer is seated. It
  is refused naming the audience, because a meeting with no electorate makes
  every motion inquorate and there is no correct downstream behavior.
- **A quorum that the frozen roll cannot reach**, such as a minimum of twenty
  against a board of twelve. Refused naming both numbers. Discovered at the tally
  this is a meeting that was never going to be able to decide anything, learned
  after everybody had gone home.

**Quorum arithmetic, because rounding is an outcome.** The rule is a fraction, a
minimum, or both, and the requirement is
`max(ceil(fraction × eligible), minimum)`. Rounding is up: one tenth of
twenty-five members is 2.5, and a quorum of two is a smaller quorum than the
bylaws state. Rounding down would make the software slightly more permissive
than the document it implements, in every association whose membership is not a
multiple of its denominator.

**A quorum is over the poll, and this domain says so rather than implying
otherwise.** The count is ballots cast, not members present. For an
asynchronous poll those are the same thing. For an in-person meeting they are
not: a member who attends and votes on nothing is present under most bylaws and
is absent from this count. Recording attendance is a different surface with a
check-in flow, named in §5; a secretary records the attendance figure in the
minutes text today. The general form is worth keeping: **be exact about what you
are exact about**, and say plainly where the software's answer is narrower than
the word it borrows.

### 3.3 A ballot is named for its voter

The ballot's name is `<motion>-<member>`.

One vote per member is therefore structural. It is not checked, not enforced by
a unique index, and not a race a second voter can win, because the second cast
is the same resource as the first: `admit` normalizes to what is stored and
produces no revision when nothing changed (spec 034 §3.3). This is spec 036's
`invoiceNameFor` in a second domain, and its recurrence is the point. Twice now
the correctness of a domain has come from choosing a name rather than from
writing a guard.

**A voter may recast while the poll is open**, which makes the second cast an
update to that row: a new revision, a new Decision, and the ballot showing the
final choice. Refusing the recast was the alternative and it is worse, because
a mis-click would be permanent and the ordinary remedy in a real meeting is to
change your vote before the question is put.

**What the chain preserves, stated narrowly enough that nobody over-trusts it
later.** Admission appends an allow carrying the actor and a `contextHash` (spec
034 §3.7). A hash commits to the context; it does not store it. So the chain
proves that Ada changed her ballot on this motion at this time, and it does
**not** preserve what the ballot said before. The resource holds the final
choice and the ledger holds the fact of the change.

That is enough for the question a governance record is asked, which is whether
the record was altered and by whom. It is not enough for an association whose
bylaws require the full sequence of votes. That association needs an append-only
cast record, which is a different kind with a different name derivation, and it
is in §5 rather than here because building it now would be building for a
requirement nobody in this substrate has stated.

**A ballot names its voter, so this is an open ballot by construction.** The
operator plane can read who voted how. That is correct for a board, whose votes
are ordinarily recorded by name in the minutes, and it is wrong for the secret
ballot many associations require for contested questions. A secret ballot is not
a flag on this design: it is a detached token model in which nothing links the
choice to the caster, and it cannot be reached by adding a boolean. §5.

### 3.4 Eligibility: refused at the edge, decided at the tally

Two checks, deliberately, and each one covers what the other cannot.

**The endpoint refuses an ineligible caster**, answering 403 naming why: not on
the roll, the poll is not open, the motion is closed. This is the check that
gives a person a true answer at the moment they act. Without it a member casts a
ballot, watches it succeed, and learns at close that it never counted, which is
a worse experience than a refusal and looks exactly like the software losing it.

**The tally counts only ballots whose member is on the frozen roll**, and that
is the authoritative check. It covers every route the endpoint does not: a
replay, a bug, a fixture, an operator writing through the store grant.

**Admission checks neither, and the reason is not spec 036 §3.3's.** There, an
admission-time reference check was refused because the guarantee expired the
moment the referent was retracted. Here the roll is frozen, so an admission-time
check would in fact hold, and the honest reason is different and simpler:
admission cannot ask the question. A kind's validator is pure over the spec it
is handed (spec 034 §3.2), and giving the control plane a facility for reading
one resource while admitting another is an amendment to 034 that this domain
does not need. More decisively, `admit` takes an `actor` string and not a
session; the question is "is *this caller* on the roll", and the caller's
identity exists at the endpoint and nowhere below it.

The general rule, which is worth stating once for the domains after this one:
**an authorization that depends on who is asking belongs where the session is,
and the durable check behind it belongs where the decision is made.** Putting
either in the middle gets a check that is either identity-blind or too late.

### 3.5 What "carried" means

The tally is `yes`, `no`, `abstain`, `eligible` (the frozen roll's size), `cast`
(the three summed), `quorate`, and `outcome`, and every one of them is stored so
that a reader gets the same numbers the controller used.

**An abstention counts toward quorum and not toward the threshold.** Both
positions appear in real bylaws and they disagree about outcomes, so the choice
has to be made explicitly and made visible:

```
100 eligible, quorum 20, threshold simple.
  10 yes, 9 no, 5 abstain.

  cast = 24 >= 20                     -> quorate
  threshold over yes+no = 19          -> 10 > 9   -> CARRIED
  threshold over cast   = 24          -> 10 < 13  -> FAILED
```

The reasoning behind the choice, rather than the choice alone: quorum asks
whether enough of the body engaged, and an abstention is engagement, since the
member appeared and declined to decide. A threshold asks whether enough of those
who took a position agreed, and somebody who took no position is not among them.
An association whose bylaws say otherwise needs the denominator as a motion
field, which is named in §5 and is deliberately not a field today, because an
untested second branch in the rule that decides outcomes is worse than a
documented single behavior.

Three thresholds: `simple` (more yes than no), `twoThirds` (yes at least twice
no), and `unanimous` (at least one yes and no no). All three exclude abstentions
from the denominator, consistently with the paragraph above; `unanimous`
tolerating abstentions is the standard reading and is stated because the other
reading is defensible.

**The tally is computed once, at close, and then frozen.** Once `outcome` is
set the controller will not recompute it, even if a ballot arrives afterwards by
some path. Recomputing on read is the design that lets a published result change
under a reader, which is the same failure §3.2 froze the roll to prevent,
arriving through the other door.

**An inquorate motion carries a distinct outcome and is not a failure.** A
motion that failed was decided; a motion that was inquorate was not, and an
association's remedy for the second is to put it again at a quorate meeting. A
tally that collapsed them would make the minutes say the body rejected something
it never considered.

### 3.6 The lifecycle on the clock

A meeting moves `draft` -> `called` -> `open` -> `closed`, with `cancelled`
reachable from `draft` and `called`. A motion moves `moved` -> `polling` ->
`closed`, with `withdrawn` reachable before polling.

`called` and `open` are separate states and both earn it. `called` means the
roll is frozen, the agenda is fixed and the notices are raised; `open` means the
meeting is in session and a poll may run. Collapsing them would mean either
polling could start the moment a meeting was scheduled or the roll could not be
frozen until the meeting began, and the first breaks the notice period while the
second breaks §3.2.

The controller drives what the clock drives and nothing else:

```
meeting called, calledFor has arrived     -> open
motion moved, opensAt has arrived,
  and its meeting is open                 -> polling
motion polling, closesAt has passed       -> tally, freeze, close
meeting open, adjournment recorded        -> closed (operator act)
meeting open, 24h past calledFor          -> closed (backstop)
minutes draft, an approving motion carried-> approved (§3.8)
officer term ended                        -> expired (§3.9)
```

**Adjournment is an operator act, because a meeting does not end at a
predictable time.** The 24-hour backstop exists because a secretary who forgets
to adjourn otherwise leaves every poll open forever, and a poll that never closes
is a motion that is never decided. Twenty-four hours is long enough that it
cannot truncate a real session and short enough that the forgotten meeting is
found the next day.

**A poll window defaults to the session**: `opensAt` defaults to the meeting
opening and `closesAt` to its adjournment, which is the in-the-room case and
needs no operator input. Supplying them explicitly is how an association runs a
poll that spans a longer window inside a meeting that is open for it.

**Two loops and one lease, exactly as spec 036 §3.7.** The change loop reacts to
writes, so a ballot cast now is visible now; the sweep reacts to the clock,
because a poll closing at 19:45 is not a write and the change feed can never
deliver it. Both take `ctl:governance`, so they never run concurrently and
neither can supersede the other's fencing token.

**The sweep runs every minute, and the divergence from spec 036's hour is the
whole reason §3.7 exists.** 036's inputs change at most once a day, so an hour
costs nothing a person notices. These inputs are instants: a poll that closed at
19:45 and is tallied at 20:00 shows a stale result on the screen of everybody
who was in the room. A minute is the same interval spec 037's retry sweep runs
at, for the same class of reason.

Like 036's sweep it keeps no watermark, re-lists from the top, and **logs and
skips a meeting or motion it cannot reconcile rather than abandoning the pass.**
That rule was written into 036 after an ordered enumeration was found to drop
every membership behind a bad row; inheriting it here is cheap, and the failure
it prevents is worse, since the rows behind the bad one are polls that never
close.

### 3.7 Instants and days, and why there is no timezone

Two time models in one domain, on purpose:

- **A meeting happens at an instant**, stored as an ISO-8601 string carrying its
  offset: `2026-09-14T19:00:00-06:00`. Poll windows are instants too.
- **A term of office is a calendar day**, `YYYY-MM-DD`, with the UTC-anchored
  string arithmetic spec 036 §3.7 already established and this domain reuses
  through `backend/members/dates.ts`.

Each is right about its subject. A meeting at 19:00 is a moment two people in
different offsets must agree on, and rendering it as a day would lose the only
part that matters. A term of office beginning "on the first of January" is a day
in the association's own reckoning, and giving it an instant would make it start
at a different moment for the treasurer than for the secretary, which is spec
036's argument unchanged.

**There is no association timezone, and that is a decision rather than an
omission.** An instant carrying its own offset is self-describing. A stored
timezone would be a second source of truth for the same fact, and the two can
disagree: the notice would name an hour computed from the timezone while the
record names the instant, and the member who showed up at the wrong time would
have no way to tell which was authoritative. The offset is supplied by the
operator's client at the moment the meeting is called, which is exactly where
the human intention about "seven in the evening" lives.

**The cost, named because it is real.** A recurring series crossing a daylight
saving boundary needs its offset recomputed per occurrence rather than derived
from a rule. There is no recurring series in this domain (§5), so the cost is
currently zero and the note exists so that whoever adds one knows they are
buying it.

### 3.8 Minutes, and the only effect a motion is allowed to have

`minutes` names a meeting, holds the text, and carries an approval. Drafting
minutes for a meeting that has not closed is refused: minutes of a meeting still
in session are notes.

**Minutes are approved by a motion at a later meeting**, which is how the loop
closes and is why `motion` carries an optional `approves` naming a `minutes`
resource. When such a motion carries, the controller marks the minutes approved
and records the motion that did it. A meeting cannot approve its own minutes,
refused at the point the motion is moved, because a body cannot ratify the record
of a session it is still holding.

**That is the only machine-readable effect a motion has, and the bound is
deliberate.** Everything else a motion decides is text. The moment a motion can
change one piece of state, the next request is a motion that can change any
piece of state, and the governance domain becomes a workflow engine in which the
question "what did this motion do" is answered by reading code. Minutes approval
earns the exception because it is a fact *about the governance record itself*,
with no reach outside it: approving minutes changes nothing an association does,
only what its record says was agreed.

An association that wants a carried motion to raise dues, seat a director, or
open a bank account should read the motion and do the thing. The record of the
decision and the execution of it are different objects, and conflating them is
how a governance system becomes the place every feature request lands.

### 3.9 Officer terms, and the shape generalizing

An `officer` binds a seat to a member for a term: a normalized free-text `seat`
label, because an association names its own offices and an enum here would be
this codebase deciding that a "Membership Secretary" does not exist; a
`votingSeat` flag, because ex officio seats commonly attend and do not vote; and
`startsOn` with an optional `endsOn`.

The status is the shape spec 036 established, reached by different arithmetic:
`pending` before the term begins, `active` during it, `expired` after, and
`invalid` when the member it names is not registered or when a second officer
holds the same seat over an overlapping term. The overlap is reported rather
than refused, which is spec 036 §3.3's rule applied without amendment: two
officers claiming the treasurership is something an operator can produce by a
typo and something an association can produce legitimately during a handover,
and the useful response is to show it rather than to make it unrepresentable.

This section is short because it should be. It is the third calendar-driven
convergence in the corpus and it needed no new machinery, no new rule, and no
new argument. That is what spec 036 §1 was betting on and it is the only part of
this document that is evidence rather than design.

### 3.10 The two planes, and the first member-plane write

The operator plane requires the `<app>_operator` role: officers (list, `PUT`,
`DELETE`), meetings (list, get, `PUT` while draft, `POST .../call`,
`POST .../adjourn`, `POST .../cancel`), motions (list, `PUT` while the meeting is
draft or called, `POST .../withdraw`), and minutes (`PUT`, and reading the
approval). It reads every tally.

The member plane is three endpoints and none of them takes a member name, which
is spec 036 §3.8's structural rule carried forward: an endpoint that reads "the
member named X" and then checks whether X is you is one refactor away from
forgetting.

- `GET /api/me/ballots`: the motions open to the caller and how the caller has
  voted.
- `POST /api/motions/:name/ballot`: cast or recast.
- `GET /api/meetings`: called meetings, their agendas, and the outcomes of
  closed motions. Members may read the record of their own association.

The session-to-member join is spec 036's `findLinkedMember`, imported rather
than reimplemented: `sub` first, verified email second, nothing for a session
carrying no subject. A second answer to "which member is this" is one that the
two domains can disagree about, and a disagreement between "whose dues these
are" and "whose vote this is" is the worst possible place to find one.

**`POST .../ballot` is the first member-plane write in the substrate**, and it
changes what the Decision chain is. Every admitted write until now carried an
operator or a controller as its actor. A ballot carries an ordinary member's
subject, which is what makes the chain a voting record: the answer to "who cast
this" is in the same ledger, under the same hash chain, as the answer to "who
seated this officer". Spec 034 §3.7 asserted that the ledger would answer a
question a board minute asks. This is the write that makes that literally true,
and §3.11 is the part it does not cover.

### 3.11 What the record does not claim

The endpoints refuse a ballot on a closed motion, an edit to a called meeting,
and a second tally. Those refusals are real and they are the whole of what the
application enforces.

**Nothing structural stops a process holding the store grant from writing
anyway.** Admission's capability check is `db.txn` on `state`, which is every
kind in one table (spec 034 §3.1, §3.3), so the `governance` service's own
grants are sufficient to write any resource in the domain, including a ballot
after its poll closed. The endpoint refusals are application logic, not a
ceiling.

What the substrate gives instead is visibility. Any such write is an admission,
so it appends a Decision carrying its actor and its context hash to a chain whose
integrity spec 024 verifies. The record cannot be quietly changed; it can be
changed, and the change is in the ledger. **That is the honest guarantee, and it
is worth more than a claim of immutability this substrate cannot make**, because
an association that believed the stronger claim would stop checking.

This is also the first place where per-kind admission grants would buy something
a person outside the software cares about. Spec 034 §3.3 recorded that the axis
"buys nothing as the schema stands", which was true of a domain where every kind
was equally rewritable; spec 036 §5 carried it forward unchanged. A domain
holding a voting record is the counter-case: a grant that let the `governance`
service write meetings and officers but not ballots after a close would turn one
of these refusals into a ceiling. It stays on spec 020 §3.4's extension list and
is not built here, and this paragraph exists so that the list has a stated
consumer the next time it is weighed.

### 3.12 When people are told

**One notice kind: `meeting-notice`, raised at the call, to every member on the
frozen roll.** Its subject is `<meeting>-<member>`, so 037's name derivation
gives one notice per member per meeting however many times the call is
reconciled, and the controller keeps no memory of what it has sent.

**Motion results are published and not mailed.** An association that emails
every member the outcome of every motion trains them to filter its mail, and the
message that must arrive is the one with a date on it. Results are on the member
plane (§3.10) and in the minutes.

Two rules inherited from spec 036 §3.10 without change, because they were right
for the same reasons: a notice that cannot be raised is logged and does not fail
the reconcile, since a misconfigured relay must not stop a meeting from opening;
and a member with no email address is a skip rather than an error, since a
postal-only member is a real thing an association has.

**The notice period is observed, not enforced.** The association record carries
a `noticeDays` and a meeting called with less warning than that is reported
`invalid` naming the shortfall, rather than refused. Refusing would block the
emergency meeting most bylaws explicitly permit; allowing it silently would let
the meeting be challenged later with nothing in the record to challenge. Spec
036 §3.3's principle reaches its most useful application here: the software's
job is to make the irregularity visible to the people who get to decide whether
it mattered.

## 4. Acceptance

1. Calling a meeting freezes the electorate into its spec: a `general` meeting's
   roll holds exactly the members whose membership is active and whose tier
   carries `votingRights`; a `board` meeting's holds exactly the officers whose
   term covers the day and whose seat votes.
2. A membership that lapses after the call does not change the meeting's roll,
   its quorum requirement, or its tally.
3. An amendment to the association's quorum rule after the call does not change
   the meeting's requirement.
4. A call is refused when the roll would be empty, naming the audience, and when
   the quorum rule cannot be reached by the frozen roll, naming both numbers.
5. Quorum rounds up: a fraction of one tenth against twenty-five eligible
   requires three.
6. A meeting's spec is editable in `draft` and refused in `called`. The
   documented route to a changed agenda is to cancel and draft another, there is
   no transition back to `draft`, and a cancelled meeting's motions never poll.
7. Casting twice produces one ballot resource: the second cast with the same
   choice produces no revision, and with a different choice updates the row and
   produces one.
8. A ballot is refused on a motion that is not polling, and refused from a caller
   who is not on the meeting's roll, each answering 403 naming which.
9. A ballot whose member is absent from the roll is excluded from the tally even
   when it was written directly to the store, so the endpoint refusal and the
   tally's exclusion are independently asserted.
10. Abstentions count toward quorum and not toward the threshold: the worked
    example of §3.5 carries, and the same ballots with abstentions in the
    denominator would not.
11. Each of `simple`, `twoThirds` and `unanimous` is asserted at its boundary,
    including a `unanimous` motion carrying with abstentions present and failing
    with a single no.
12. A quorate motion that fails and an inquorate motion are distinct outcomes,
    and neither is reported as the other.
13. The tally is written once: a ballot admitted after the close does not change
    a published outcome.
14. The sweep opens a meeting whose instant has arrived, opens and closes polls
    on their windows, closes a meeting twenty-four hours past its instant, and
    expires an officer's term, none of them prompted by a write. One
    unreconcilable meeting is logged and skipped and the ones after it in the
    enumeration still converge.
15. Both loops share `ctl:governance`: they never run concurrently, and neither
    is refused as superseded by the other.
16. Minutes cannot be drafted for an open meeting, cannot be approved by a motion
    at their own meeting, and become `approved` naming the motion when an
    approving motion carries at a later one.
17. Two officers holding one seat over overlapping terms are both reported
    `invalid` naming the conflict, and neither is refused at admission.
18. Calling a meeting raises exactly one `meeting-notice` per member on the roll
    however many times the call reconciles, skips a member with no address, and a
    relay failure leaves the meeting called.
19. A meeting called with less notice than the association's `noticeDays` is
    reported `invalid` naming the shortfall and is not refused.
20. A service without the state grants is denied admission of a governance kind.

Items 1 through 4, 6 through 9, and 13 through 20 are asserted in
`backend/governance/governance.test.ts` against a booted node. Items 5, 10, 11
and 12 are asserted directly against the pure tally and quorum rules in
`backend/governance/tally.test.ts`, at every branch, with the day and the instant
passed in rather than read from a clock.

## 5. Out of scope

- **Elections**: nominations, candidacies, contested seats, count methods, ties
  and runoffs. This domain seats an officer because an operator recorded a
  result; it does not run the vote that produced one. The boundary falls here
  because an election generalizes the ballot from a decision on a question to a
  choice among candidates, and that one change brings ranked ballots, tie
  resolution, withdrawal mid-poll and per-seat counting with it: a domain's worth
  of second-order questions, which spec 036 §1 argues is exactly what should not
  be answered shallowly alongside another domain. It couples to this one at one
  edge, which is that seating a winner writes an `officer`.
- **Written resolutions without a meeting**, the between-meetings mail ballot
  most bylaws permit. It needs its own quorum rule, since there is no session to
  attend, and its own notice rule.
- **Proxies and delegated votes.** A proxy is a second identity casting for a
  first, which the ballot's name derivation deliberately cannot express, and the
  authorization to hold one is a document an association verifies offline.
- **Secret ballots** (§3.3). Not a flag on this design: a detached token model in
  which nothing links a choice to its caster, with its own answer to whether a
  voter can verify their own vote was counted.
- **An append-only record of every cast** (§3.3). The chain preserves that a
  ballot changed and not what it said; an association whose bylaws require the
  sequence needs a distinct event kind. Named because §3.3's guarantee is narrow
  and should not be discovered to be narrow later.
- **Attendance as a separate fact from voting** (§3.2). Quorum here is over the
  poll. Machine-checked attendance is a check-in surface and an `attendance`
  kind, and it is what an association running quorum by presence would need.
- **The abstention denominator as a per-motion field** (§3.5), and weighted or
  per-tier vote values. Both are real bylaws variations and both are a second
  branch through the rule that decides outcomes, which should arrive with an
  association asking for it rather than in advance of one.
- **Recurring meeting series** (§3.7), which is where the absence of a stored
  timezone starts to cost something.
- **Motions with effects beyond minutes approval** (§3.8). Deliberate and
  argued, not deferred.
- **Retention and archival of ballots and closed meetings.** The tally lists a
  tenant's ballots and filters by motion, which is correct at the scale spec 001
  §4.1 names and grows with the association's whole voting history rather than
  with one meeting. The first association to feel it needs an archive boundary,
  which is spec 032 §3.9's mechanics applied to resources rather than to the
  Decision chain.
- **Per-kind admission grants** (§3.11), still on spec 020 §3.4's extension list,
  now with a stated consumer.
