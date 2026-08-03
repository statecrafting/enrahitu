/**
 * Rendering a template to text and HTML from one source (spec 037 §3.5).
 *
 * The one constraint the spec sets is that this must not put React in the
 * backend, which today has none: React lives in `frontend/` and
 * `frontend-admin/` under standalone manifests, and this is a single-package
 * repo with no workspaces (spec 001 key decision 1). So a template is plain text
 * with `{{param}}` substitution, and the HTML part is derived from the same
 * string rather than authored separately. Two authored sources drift, and the
 * half that drifts is the one nobody reads while testing, which is the text part
 * that every screen reader and every plaintext client falls back to.
 */

/** The `{{key}}` form. Deliberately not an expression language. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export class MissingParamError extends Error {
  constructor(
    readonly template: string,
    readonly param: string,
  ) {
    super(`template '${template}' needs a param '${param}' that the notice did not supply`);
    this.name = "MissingParamError";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function substitute(
  source: string,
  params: Record<string, string>,
  templateName: string,
  transform: (value: string) => string,
): string {
  return source.replace(PLACEHOLDER, (_match, key: string) => {
    const value = params[key];
    // Refused rather than left as a literal `{{amount}}`, which is what a member
    // would otherwise receive. A notice that cannot be rendered records the
    // error and becomes visible (spec 037 §3.3) instead of being sent wrong:
    // mail cannot be taken back, so the failure has to happen before the send.
    if (value === undefined) throw new MissingParamError(templateName, key);
    return transform(value);
  });
}

export interface Rendered {
  text: string;
  html: string;
}

/**
 * Render one source into both parts.
 *
 * Escaping order is the part worth getting right: for the HTML half the template
 * body is escaped FIRST and the parameter values are escaped as they are
 * substituted, so a member whose display name contains markup cannot inject it
 * into the mail, and the paragraph tags this function generates are not escaped
 * along with everything else.
 */
export function render(
  templateName: string,
  source: string,
  params: Record<string, string>,
): Rendered {
  const text = substitute(source, params, templateName, (v) => v);
  const escapedBody = substitute(escapeHtml(source), params, templateName, escapeHtml);

  const html = escapedBody
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  return { text: text.trim(), html };
}
