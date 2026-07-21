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
