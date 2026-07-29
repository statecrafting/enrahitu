# `app/`: your code

This directory is yours. Everything else in this repository is chassis, and an
upgrade replaces it wholesale (spec 035).

That is the whole boundary. You can tell from a path alone whether an upgrade
will overwrite it: if it starts with `app/`, no; otherwise, yes.

## Before you take an upgrade

```bash
npm run upgrade:preflight
```

It compares the tree against `chassis.lock` and names every chassis file you
have edited or deleted, because those are exactly what an upgrade would
discard. An unmodified tree reports as safe and exits zero. Nothing under
`app/` is examined.

If it names a file, you have three honest options, and the preflight prints
them: move the change here, propose it upstream so every deployment gets it, or
accept losing it and re-apply afterwards.

## What an extension is

The control plane (spec 034) is what makes this cheap. You do not need a
migration or a schema change to add a resource type.

- **A kind** is registered at runtime: a name, whether it is tenant-scoped, and
  a validator that normalizes rather than approves. See
  `backend/control/kinds.ts` for the helpers.
- **A controller** reconciles those kinds, leased and fenced like any other. Its
  reconciler must be idempotent, and its pass must fit inside the ten-second
  lease or consult `remainingMs()`.
- **A service** with your endpoints and your grants, declared in
  `app/manifest.json`.

## `app/manifest.json`

Your half of the capability ceiling. It may add capabilities, services and
resources, and it may add capabilities to a chassis service so your kind can be
reconciled by a chassis controller.

It may **not** redefine anything the chassis declared. The composer refuses the
collision instead of resolving it, because a silently overridden grant is a
widened ceiling that reads, in the composed file, exactly like a chassis
decision. If you need different chassis grants, that is a chassis change worth
discussing out loud.

After editing:

```bash
npm run gen:manifest    # composes app-manifest.json; commit the result
```

## The one thing this boundary does not yet solve

Frontend routes. Adding a screen still means editing a chassis file under
`frontend/`, because the router has no registration seam equivalent to the kind
registry. Spec 035 §5 names it rather than leaving it to be discovered.
