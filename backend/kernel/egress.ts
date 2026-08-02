/**
 * The governed egress facade (spec 021 §3.5): the only module in backend/
 * permitted a bare fetch (the extraction ban-list enforces this). Every
 * call adjudicates http.egress on a logical resource before leaving the
 * process; the target hostname rides as the `domain` attribute so grants
 * MAY constrain domains, while env-configured hosts (the rauthy upstream)
 * stay out of the model per spec 020's determinism rules.
 */
import { demand } from "./adjudicate";

export async function governedFetch(
  resource: string,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  demand("http.egress", resource, { attributes: { domain: url.hostname } });
  return fetch(url, init);
}

/**
 * The kernel's second transport (spec 037 §3.2).
 *
 * The facade above is HTTP-shaped, and mail is the first thing to escape it: an
 * SMTP transport opens a TCP socket, which `governedFetch` does not see and the
 * extraction ban-list did not forbid. Spec 030 §3.5 settled the general question
 * for pub/sub and its sentence is exact here: a governed deployment whose
 * messages leave unadjudicated has an ungoverned channel, and the whole kernel
 * plane would be arguable. Mail is the channel that reaches people, so a
 * deployment that can be made to send without a ledger entry has an audit record
 * incomplete in the direction that matters.
 *
 * Only the adjudication lives here, not the socket. `backend/mail/transport.ts`
 * is to SMTP what this module is to HTTP, and it calls this before connecting.
 * The relay host rides as an attribute exactly as `domain` does for HTTP, so a
 * fleet may pin which relay a cell is allowed to reach.
 */
export function demandSmtpEgress(resource: string, host: string): void {
  demand("smtp.egress", resource, { attributes: { host } });
}
