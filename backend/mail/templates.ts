/**
 * Template resolution: chassis defaults, `app/` overrides (spec 037 §3.5).
 *
 * **This is deliberately the opposite of the manifest overlay's rule**, and the
 * asymmetry is the interesting part. `scripts/gen-manifest.mjs` refuses an
 * overlay that redefines a chassis capability, because a silently overridden
 * grant is a widened security ceiling that reads, in the composed file, exactly
 * like a chassis decision. A template carries no privilege. An association
 * overriding the wording of its own dues notice is the entire point of the
 * boundary (spec 035), so here the override wins silently and by design.
 *
 * The cost is named rather than hidden, in `app/mail/README.md`: an upgrade that
 * improves a default template does not reach a deployment that overrode it, and
 * cannot, because reaching it would mean overwriting somebody's letterhead.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { render, type Rendered } from "./render";

/** Where an association's own wording lives. Never touched by an upgrade. */
export const APP_TEMPLATE_DIR = "app/mail/templates";

/** The chassis defaults, so a freshly stamped deployment sends sensible mail. */
export const CHASSIS_TEMPLATE_DIR = "backend/mail/templates";

export class UnknownTemplateError extends Error {
  constructor(readonly template: string) {
    super(
      `no mail template named '${template}': looked in ${APP_TEMPLATE_DIR}/ and then ` +
        `${CHASSIS_TEMPLATE_DIR}/`,
    );
    this.name = "UnknownTemplateError";
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The source for a template name, with the `app/` copy winning.
 *
 * The name has already been bounded by the kind's validator to lowercase
 * letters, digits and hyphens (spec 037's `mailNotice`), so it cannot traverse
 * out of either directory. That check is repeated here rather than assumed,
 * because this function joins a string onto a path and the day somebody calls it
 * from somewhere else is the day the validator stops being in the way.
 */
export function templateSource(template: string, root = process.cwd()): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(template)) {
    throw new UnknownTemplateError(template);
  }
  const file = `${template}.txt`;
  const fromApp = readIfPresent(resolve(join(root, APP_TEMPLATE_DIR, file)));
  if (fromApp !== undefined) return fromApp;

  const fromChassis = readIfPresent(resolve(join(root, CHASSIS_TEMPLATE_DIR, file)));
  if (fromChassis !== undefined) return fromChassis;

  throw new UnknownTemplateError(template);
}

/** Resolve and render in one step, which is all the controller needs. */
export function renderTemplate(
  template: string,
  params: Record<string, string>,
  root = process.cwd(),
): Rendered {
  return render(template, templateSource(template, root), params);
}
