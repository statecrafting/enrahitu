/**
 * The rule, the templates, and the boundary (spec 037 §3.7).
 *
 * Everything here is a pure function or a filesystem read: no node, no relay.
 * The loop against a booted node is `loop.test.ts`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMessage } from "./transport";
import { MissingParamError, render } from "./render";
import { UnknownTemplateError, renderTemplate, templateSource } from "./templates";
import {
  MAX_ATTEMPTS,
  afterFailure,
  afterSuccess,
  nextAttemptAfter,
  noticeNameFor,
  planFor,
} from "./schedule";
import { mailNoticeKind } from "./kinds";

const T0 = Date.parse("2026-08-02T12:00:00.000Z");

describe("the notice's name is its identity (spec 037 §3.3)", () => {
  it("derives from what the notice is about, so the same subject names the same notice", () => {
    // The whole idempotence story rests on this being a function of the subject
    // and nothing else. A clock or a counter here would send a member one
    // reminder per reconcile.
    expect(noticeNameFor("dues-reminder", "ada-individual-2026-01-01")).toBe(
      "dues-reminder-ada-individual-2026-01-01",
    );
    expect(noticeNameFor("dues-reminder", "ada-individual-2026-01-01")).toBe(
      noticeNameFor("dues-reminder", "ada-individual-2026-01-01"),
    );
  });
});

describe("retry is a status, not a queue (spec 037 §3.3)", () => {
  it("attempts a notice that has never been tried", () => {
    expect(planFor(null, T0)).toEqual({ attempt: true });
  });

  it("never attempts one that was sent, which is what stops a second delivery", () => {
    expect(planFor({ state: "sent", attempts: 1, sentAt: "x" }, T0)).toEqual({
      attempt: false,
      reason: "already-sent",
    });
  });

  it("never attempts one that gave up, and never deletes it either", () => {
    expect(planFor({ state: "failed", attempts: MAX_ATTEMPTS }, T0)).toEqual({
      attempt: false,
      reason: "given-up",
    });
  });

  it("waits for the backoff rather than retrying instantly", () => {
    const status = {
      state: "pending" as const,
      attempts: 1,
      nextAttemptAt: new Date(T0 + 30_000).toISOString(),
    };
    expect(planFor(status, T0)).toEqual({ attempt: false, reason: "not-yet-due" });
    // ...and attempts it once the deferral has elapsed.
    expect(planFor(status, T0 + 31_000)).toEqual({ attempt: true });
  });

  it("backs off exponentially, because the usual cause is a relay that is down", () => {
    const at = (n: number): number => Date.parse(nextAttemptAfter(n, T0)) - T0;
    expect(at(1)).toBe(60_000);
    expect(at(2)).toBe(120_000);
    expect(at(3)).toBe(240_000);
    expect(at(1)).toBeLessThan(at(2));
  });

  it("advances attempts and defers, then gives up visibly with the last error kept", () => {
    let status = afterFailure(null, "relay refused: 421 too many connections", T0);
    expect(status.state).toBe("pending");
    expect(status.attempts).toBe(1);
    expect(status.nextAttemptAt).toBeDefined();
    expect(status.lastError).toMatch(/421/);

    for (let i = 2; i < MAX_ATTEMPTS; i++) {
      status = afterFailure(status, "still down", T0);
      expect(status.state).toBe("pending");
    }

    const givenUp = afterFailure(status, "still down", T0);
    expect(givenUp.state).toBe("failed");
    expect(givenUp.attempts).toBe(MAX_ATTEMPTS);
    // No further deferral: there is nothing left to wait for.
    expect(givenUp.nextAttemptAt).toBeUndefined();
    // The error survives, because the notice list is what answers "was this
    // member told" and "no, and here is why" is the useful answer.
    expect(givenUp.lastError).toBe("still down");
  });

  it("counts the successful attempt, so a notice sent on the third try reads as three", () => {
    const status = afterSuccess({ state: "pending", attempts: 2 }, T0);
    expect(status).toEqual({ state: "sent", attempts: 3, sentAt: new Date(T0).toISOString() });
  });

  it("truncates a relay's essay, because this string is read in a list", () => {
    const status = afterFailure(null, "x".repeat(2000), T0);
    expect(status.lastError!.length).toBe(500);
  });
});

describe("rendering one source into both parts (spec 037 §3.5)", () => {
  it("substitutes into the text and the HTML from the same template", () => {
    const out = render("t", "Hello {{name}},\n\nDues of {{amount}} are due.", {
      name: "Ada",
      amount: "$45.00",
    });
    expect(out.text).toBe("Hello Ada,\n\nDues of $45.00 are due.");
    expect(out.html).toBe("<p>Hello Ada,</p>\n<p>Dues of $45.00 are due.</p>");
  });

  it("escapes a value so a display name cannot inject markup into the mail", () => {
    const out = render("t", "Hello {{name}}.", { name: "<script>alert(1)</script>" });
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>");
    // The text part is not HTML and must NOT be escaped, or the member reads
    // "&lt;script&gt;" in their plaintext client.
    expect(out.text).toBe("Hello <script>alert(1)</script>.");
  });

  it("keeps a single newline as a line break and a blank line as a paragraph", () => {
    const out = render("t", "one\ntwo\n\nthree", {});
    expect(out.html).toBe("<p>one<br>two</p>\n<p>three</p>");
  });

  it("refuses a missing parameter rather than mailing a literal placeholder", () => {
    // Mail cannot be taken back, so this failure has to happen before the send.
    expect(() => render("dues-reminder", "Dues of {{amount}}.", {})).toThrow(MissingParamError);
  });
});

describe("templates: chassis defaults, app/ overrides (spec 037 §3.5)", () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "mail-templates-"));
    mkdirSync(join(root, "backend/mail/templates"), { recursive: true });
    mkdirSync(join(root, "app/mail/templates"), { recursive: true });
    writeFileSync(join(root, "backend/mail/templates/greeting.txt"), "chassis says {{who}}");
    return root;
  }

  it("renders the chassis default when the association has not overridden it", () => {
    const root = fixture();
    expect(templateSource("greeting", root)).toBe("chassis says {{who}}");
    expect(renderTemplate("greeting", { who: "hello" }, root).text).toBe("chassis says hello");
  });

  it("prefers the association's own copy, silently and by design", () => {
    const root = fixture();
    writeFileSync(join(root, "app/mail/templates/greeting.txt"), "ours says {{who}}");
    // Deliberately the OPPOSITE of the manifest overlay's rule: a template
    // carries no privilege, and rewording your own dues notice is the point of
    // the boundary.
    expect(templateSource("greeting", root)).toBe("ours says {{who}}");
  });

  it("names both directories when there is no such template", () => {
    const root = fixture();
    expect(() => templateSource("nope", root)).toThrow(UnknownTemplateError);
    expect(() => templateSource("nope", root)).toThrow(/app\/mail\/templates/);
  });

  it("refuses a name that would escape the template directory", () => {
    const root = fixture();
    // The kind's validator bounds this too, but this function joins a string
    // onto a path and the day somebody calls it from elsewhere is the day the
    // validator stops being in the way.
    for (const evil of ["../../../etc/passwd", "a/b", "..", "UPPER"]) {
      expect(() => templateSource(evil, root)).toThrow(UnknownTemplateError);
    }
  });

  it("ships a chassis default for every template the notices reference", () => {
    const shipped = readdirSync(join(process.cwd(), "backend/mail/templates"));
    expect(shipped).toContain("dues-reminder.txt");
    expect(shipped).toContain("dues-receipt.txt");
  });
});

describe("the mailNotice kind (spec 037 §3.3)", () => {
  const valid = {
    to: "  Ada@Example.ORG ",
    template: "dues-reminder",
    subject: " Your dues are due ",
    params: { amount: "$45.00" },
  };

  it("normalizes rather than approving", () => {
    const spec = mailNoticeKind.validate(valid);
    expect(spec.to).toBe("ada@example.org");
    expect(spec.subject).toBe("Your dues are due");
  });

  it("refuses a template name that could traverse out of the template directory", () => {
    expect(() => mailNoticeKind.validate({ ...valid, template: "../../../etc/passwd" })).toThrow(
      /template/,
    );
  });

  it("refuses a non-string param, because a raw number reaches the member unformatted", () => {
    expect(() => mailNoticeKind.validate({ ...valid, params: { amount: 4500 } })).toThrow(
      /params\.amount/,
    );
  });

  it("refuses an address that is not one, and an empty subject", () => {
    expect(() => mailNoticeKind.validate({ ...valid, to: "not-an-address" })).toThrow(/to/);
    expect(() => mailNoticeKind.validate({ ...valid, subject: "   " })).toThrow(/subject/);
  });
});

describe("the message on the wire (spec 037 §3.2)", () => {
  const message = {
    to: "ada@example.org",
    subject: "Your dues",
    text: "Hello Ada.",
    html: "<p>Hello Ada.</p>",
  };

  it("sends text before HTML, so a plaintext client shows the part written for it", () => {
    const wire = buildMessage("assoc@example.org", message);
    expect(wire.indexOf("text/plain")).toBeLessThan(wire.indexOf("text/html"));
    expect(wire).toMatch(/^From: assoc@example\.org\r\n/);
    expect(wire).toContain("multipart/alternative");
  });

  it("encodes a non-ASCII subject, or half the clients show mojibake", () => {
    const wire = buildMessage("assoc@example.org", { ...message, subject: "Cotisation échue" });
    expect(wire).toContain("=?UTF-8?B?");
    expect(wire).not.toContain("Subject: Cotisation échue");
  });

  it("dot-stuffs, or a body line of '.' truncates the message at that line", () => {
    // The failure this prevents is invisible to anyone who tested with
    // "hello world": the message sends, and arrives cut in half.
    const wire = buildMessage("assoc@example.org", { ...message, text: "one\n.\ntwo" });
    expect(wire).toContain("\r\n..\r\n");
  });
});

describe("the boundary (spec 037 §3.2)", () => {
  it("keeps the socket in exactly one module", () => {
    // The spec puts this in the toolchain's extraction ban-list, which lives in
    // the published @statecrafting/toolchain package rather than in this repo.
    // Until that release lands, the rule is enforced here so it is mechanical
    // from the first commit rather than from the first hurry.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const source = readFileSync(path, "utf8");
        if (/from\s+"node:(net|tls|dgram)"|require\("node:(net|tls|dgram)"\)/.test(source)) {
          offenders.push(path.slice(process.cwd().length + 1));
        }
      }
    };
    walk(join(process.cwd(), "backend"));
    expect(offenders).toEqual(["backend/mail/transport.ts"]);
  });

  it("declares smtp.egress on exactly the service that opens the socket", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "app-manifest.json"), "utf8")) as {
      capabilities: { id: string; kind: string; resource: string }[];
      services: Record<string, { capabilities?: string[] }>;
    };
    const smtp = manifest.capabilities.filter((c) => c.kind === "smtp.egress");
    expect(smtp).toHaveLength(1);
    const holders = Object.entries(manifest.services)
      .filter(([, decl]) => decl.capabilities?.includes(smtp[0]!.id))
      .map(([name]) => name);
    expect(holders).toEqual(["mail"]);
  });
});
