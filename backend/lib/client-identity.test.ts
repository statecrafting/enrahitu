import { afterEach, describe, expect, it } from "vitest";

import { clientAddress, resolveClient, vouchedForwardedFor } from "./client-identity";

const PEER = "10.0.0.9";

function hops(value: string | undefined): void {
  if (value === undefined) delete process.env.ENRAHITU_TRUSTED_PROXY_HOPS;
  else process.env.ENRAHITU_TRUSTED_PROXY_HOPS = value;
}

afterEach(() => hops(undefined));

describe("client identity: no declared proxy (the packaged default)", () => {
  it("ignores X-Forwarded-For entirely and uses the transport peer", () => {
    const forged = { "x-forwarded-for": "1.2.3.4" };
    expect(resolveClient(forged, PEER)).toEqual({ trusted: true, client: PEER });
  });

  it("reports untrusted when there is no peer either (the typed tier)", () => {
    expect(resolveClient({ "x-forwarded-for": "1.2.3.4" })).toEqual({ trusted: false });
  });
});

describe("client identity: declared proxy hops", () => {
  it("takes the only entry with one declared hop", () => {
    hops("1");
    expect(resolveClient({ "x-forwarded-for": "1.2.3.4" }, PEER)).toEqual({
      trusted: true,
      client: "1.2.3.4",
    });
  });

  it("ignores a forged leading entry, taking the hop the proxy appended", () => {
    hops("1");
    // The client sent "FORGED"; the proxy appended the address it saw.
    expect(resolveClient({ "x-forwarded-for": "FORGED, 1.2.3.4" }, PEER)).toEqual({
      trusted: true,
      client: "1.2.3.4",
    });
  });

  it("counts from the right through two declared hops", () => {
    hops("2");
    expect(resolveClient({ "x-forwarded-for": "1.2.3.4, 172.16.0.1" }, PEER)).toEqual({
      trusted: true,
      client: "1.2.3.4",
    });
  });

  it("ignores forgery ahead of a two-hop chain", () => {
    hops("2");
    expect(
      resolveClient({ "x-forwarded-for": "FORGED, 1.2.3.4, 172.16.0.1" }, PEER),
    ).toEqual({ trusted: true, client: "1.2.3.4" });
  });

  it("refuses to guess when the chain is shorter than the declared depth", () => {
    hops("2");
    expect(resolveClient({ "x-forwarded-for": "1.2.3.4" }, PEER)).toEqual({ trusted: false });
  });

  it("refuses to guess when the header is absent despite a declared proxy", () => {
    hops("1");
    expect(resolveClient({}, PEER)).toEqual({ trusted: false });
  });

  it("joins repeated headers left to right before counting", () => {
    hops("1");
    expect(
      resolveClient({ "x-forwarded-for": ["FORGED", "1.2.3.4"] }, PEER),
    ).toEqual({ trusted: true, client: "1.2.3.4" });
  });

  it("discards blank and whitespace-only entries", () => {
    hops("1");
    expect(
      resolveClient({ "x-forwarded-for": "FORGED, ,   , 1.2.3.4 " }, PEER),
    ).toEqual({ trusted: true, client: "1.2.3.4" });
  });
});

describe("client identity: malformed configuration fails closed", () => {
  it.each(["-1", "abc", "1.5", ""])("treats %o as no declared topology", (value) => {
    hops(value);
    expect(resolveClient({ "x-forwarded-for": "1.2.3.4" }, PEER)).toEqual({
      trusted: true,
      client: PEER,
    });
  });
});

describe("clientAddress: the raw-handler form always yields an address", () => {
  it("falls back to the peer when the chain does not vouch", () => {
    hops("2");
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4" }, PEER)).toBe(PEER);
  });

  it("never returns a client-supplied value with no declared proxy", () => {
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4" }, PEER)).toBe(PEER);
  });

  it("returns the vouched entry when the topology covers it", () => {
    hops("1");
    expect(clientAddress({ "x-forwarded-for": "FORGED, 1.2.3.4" }, PEER)).toBe("1.2.3.4");
  });
});

describe("vouchedForwardedFor: only values this app stands behind", () => {
  it("drops a forged chain and forwards the peer alone", () => {
    expect(vouchedForwardedFor({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, PEER)).toBe(PEER);
  });

  it("forwards the vouched client followed by this hop", () => {
    hops("1");
    expect(vouchedForwardedFor({ "x-forwarded-for": "FORGED, 1.2.3.4" }, PEER)).toBe(
      `1.2.3.4, ${PEER}`,
    );
  });

  it("does not repeat the peer when it is itself the resolved client", () => {
    expect(vouchedForwardedFor({}, PEER)).toBe(PEER);
  });
});
