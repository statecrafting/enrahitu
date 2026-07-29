/**
 * Who is calling (spec 025 §3.2).
 *
 * `X-Forwarded-For` is evidence, not identity. Anyone can send it, so it
 * becomes identity only when an operator states how many hops in front of
 * this app are their own infrastructure. Before this module the rate
 * limiter and the auth handlers each took the leftmost XFF value, which is
 * precisely the entry a client controls: the limiter counted an
 * attacker-chosen string and handed out a fresh bucket per request.
 *
 * Hops are counted from the RIGHT. Each proxy appends the address it
 * received the request from, so the rightmost entries are the ones
 * infrastructure wrote and the leftmost are the ones a client can invent.
 * With N trusted hops the client sits at index (len - N):
 *
 *   client C -> proxy P1 -> app,           hops=1
 *     C forges "FORGED"; P1 appends what it saw -> "FORGED, C"
 *     index 2-1 = 1 -> "C". The forgery is ignored.
 *
 * A chain shorter than the declared depth means the request did not arrive
 * through the declared topology, so no identity is reported rather than a
 * guessed one.
 */

/** Untrusted is a distinct state, never a string a caller can misuse. */
export type ClientIdentity = { trusted: true; client: string } | { trusted: false };

const UNTRUSTED: ClientIdentity = { trusted: false };

/**
 * Trusted reverse-proxy hops in front of this app. 0 (the default, and the
 * correct value for the packaged image published directly on 8080) means the
 * header is never believed.
 */
export function trustedProxyHops(): number {
  const raw = process.env.ENRAHITU_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  // A malformed value must not silently become "trust everything": an
  // unparseable or negative setting is treated as no declared topology.
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** Every XFF entry across repeated headers, left to right, in order. */
function forwardedChain(headers: HeaderBag): string[] {
  const raw = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((value) => value.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the caller from headers alone. `peer` is the transport address
 * where one is available (raw handlers); typed endpoints have no socket, so
 * they pass nothing and may receive an untrusted result.
 */
export function resolveClient(headers: HeaderBag, peer?: string): ClientIdentity {
  const hops = trustedProxyHops();

  if (hops === 0) {
    // Directly exposed: the transport peer is the only thing that cannot be
    // forged, and the header is disregarded entirely.
    return peer ? { trusted: true, client: peer } : UNTRUSTED;
  }

  const chain = forwardedChain(headers);
  const index = chain.length - hops;
  if (index < 0) return UNTRUSTED;
  // index === chain.length is unreachable (hops >= 1), so this is always a
  // real entry when index >= 0.
  return { trusted: true, client: chain[index]! };
}

/**
 * The raw-handler form: always yields an address, because a socket is
 * available. Falls back to the transport peer whenever the declared topology
 * does not vouch for a forwarded entry, so the value is never
 * client-controlled.
 */
export function clientAddress(headers: HeaderBag, peer?: string): string | undefined {
  const identity = resolveClient(headers, peer);
  return identity.trusted ? identity.client : peer;
}

/**
 * The chain this app is willing to vouch for, for onward forwarding
 * (spec 025 §3.2, the idp proxy). Client-supplied entries the declared
 * topology does not cover are dropped rather than passed along.
 */
export function vouchedForwardedFor(headers: HeaderBag, peer?: string): string {
  const client = clientAddress(headers, peer);
  const hop = peer ?? "";
  if (client && hop && client !== hop) return `${client}, ${hop}`;
  return client ?? hop;
}
