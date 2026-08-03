# Your mail templates

This is the tree-side half of spec 037 §3.5. Anything you put here is yours, and
an upgrade never touches it (spec 035).

## How overriding works

A template named `dues-reminder` is looked for in this order:

1. `app/mail/templates/dues-reminder.txt` (yours)
2. `backend/mail/templates/dues-reminder.txt` (the chassis default)

The first one found wins. To change the wording of a notice, copy the chassis
default into this directory and edit it. You do not need to register it anywhere
and you do not need to change any code.

## The trade you are making, stated before you make it

**This is deliberately the opposite of how `app/manifest.json` behaves.** An
overlay that redefines a chassis *capability* is refused, because a silently
overridden grant is a widened security ceiling that reads, in the composed file,
exactly like a chassis decision. A template carries no privilege, and an
association rewording its own dues notice is the entire point of the boundary,
so here your override wins silently and by design.

The cost: **an upgrade that improves a default template will not reach you.** It
cannot, because reaching you would mean overwriting your letterhead.
`npm run upgrade:preflight` reports chassis files you have edited, and an
overridden template is not one of them, because it lives here and was never
chassis. If you want the improved default back, delete your copy.

## Writing a template

Plain text with `{{param}}` substitution. The same source renders both the text
and the HTML part of the message, so you write it once:

```
Hello {{memberName}},

Your {{tierLabel}} membership is up for renewal. Dues of {{amount}} are due
by {{dueOn}}.

{{orgName}}
```

Blank lines become paragraphs. Single newlines become line breaks. Values are
escaped when they are put into the HTML part, so a member whose display name
contains markup cannot inject it into the mail.

**A missing parameter is refused rather than left in the text.** If a template
asks for `{{amount}}` and the notice did not supply one, the notice records the
error and becomes visible on the notice list instead of mailing somebody a
literal `{{amount}}`. Mail cannot be taken back, so the failure has to happen
before the send.

## What the chassis ships

| template | raised by | parameters |
|---|---|---|
| `dues-reminder` | the renewal controller, when dues are outstanding | `memberName`, `tierLabel`, `orgName`, `amount`, `periodStart`, `dueOn` |
| `dues-receipt` | when a payment is recorded | `memberName`, `tierLabel`, `orgName`, `amount`, `paidOn`, `renewsOn` |

If you add a parameter to a template, the notice has to supply it, which means
changing the code that raises the notice. Removing one is always safe.
