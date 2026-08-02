/**
 * The delivery loop against a booted node (spec 037 §3.7).
 *
 * Each property is stated as the failure it prevents. "The controller sends a
 * notice" is not worth asserting; "the controller sends it once however many
 * times it reconciles" is the entire reason a notice is a resource instead of a
 * function call.
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runAsService } from "../kernel/adjudicate";
import { demandSmtpEgress } from "../kernel/egress";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const TENANT = "hollis-society";

let control: typeof import("../control");
let state: typeof import("../state");
let mail: typeof import("./index");

const asMail = <T>(fn: () => Promise<T>): Promise<T> => runAsService("mail", fn);

/** A transport whose behavior each test chooses. */
function recordingTransport(): {
  transport: import("./transport").MailTransport;
  sent: import("./transport").Message[];
  fail: (reason: string | undefined) => void;
} {
  const sent: import("./transport").Message[] = [];
  let failure: string | undefined;
  return {
    sent,
    fail: (reason) => {
      failure = reason;
    },
    transport: {
      name: "recording",
      async send(message) {
        if (failure) throw new Error(failure);
        sent.push(message);
      },
    },
  };
}

const NOTICE = {
  to: "ada@example.org",
  template: "dues-reminder",
  subject: "Your dues are due",
  params: {
    memberName: "Ada",
    tierLabel: "Individual",
    orgName: "Hollis Society",
    amount: "$45.00",
    periodStart: "2026-01-01",
    dueOn: "2026-01-31",
  },
};

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "mail-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;
  process.env.ENRAHITU_TENANT = TENANT;

  control = await import("../control");
  state = await import("../state");
  mail = await import("./index");
  await state.ready;

  await runAsService("state", () => state.migrate(control.CONTROL_PLANE_MIGRATIONS));
  mail.registerMailKinds();
}, 60_000);

describe("a notice is a resource, not a function call (spec 037 §3.3)", () => {
  it("raises one resource and one revision however many times it is raised", async () => {
    await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "ada-2026-01-01", NOTICE));
    const first = await asMail(() =>
      control.get(mail.MAIL_NOTICE, "dues-reminder-ada-2026-01-01", { tenant: TENANT }),
    );

    // The domain does no bookkeeping and holds no memory of what it has raised.
    // This is the property that makes a controller correct after a crash, a
    // replay, or a watermark reset.
    for (let i = 0; i < 5; i++) {
      await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "ada-2026-01-01", NOTICE));
    }

    const after = await asMail(() =>
      control.get(mail.MAIL_NOTICE, "dues-reminder-ada-2026-01-01", { tenant: TENANT }),
    );
    expect(after?.revision).toBe(first?.revision);

    const all = await asMail(() => control.list(mail.MAIL_NOTICE, { tenant: TENANT }));
    expect(all.filter((n) => n.name === "dues-reminder-ada-2026-01-01")).toHaveLength(1);
  });
});

describe("delivery is reconciliation (spec 037 §3.3)", () => {
  it("sends once, and a second pass sends nothing further", async () => {
    const rig = recordingTransport();
    await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "sendonce", NOTICE));

    const name = "dues-reminder-sendonce";
    expect(await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 1))).toBe("sent");
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]!.to).toBe("ada@example.org");
    // Rendered through the chassis template, so the member's own name is in it.
    expect(rig.sent[0]!.text).toContain("Ada");
    expect(rig.sent[0]!.html).toContain("<p>");

    // The reconcile that matters: running again must not produce a second email.
    expect(await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 2))).toBe("skipped");
    expect(rig.sent).toHaveLength(1);

    const stored = await asMail(() => control.get(mail.MAIL_NOTICE, name, { tenant: TENANT }));
    expect((stored?.status as { state: string; attempts: number }).state).toBe("sent");
    expect((stored?.status as { attempts: number }).attempts).toBe(1);
  });

  it("advances attempts and defers rather than retrying instantly", async () => {
    const rig = recordingTransport();
    rig.fail("relay refused: connection reset");
    await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "flaky", NOTICE));
    const name = "dues-reminder-flaky";

    await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 1));
    const failed = await asMail(() => control.get(mail.MAIL_NOTICE, name, { tenant: TENANT }));
    const status = failed?.status as import("./kinds").MailNoticeStatus;
    expect(status.state).toBe("pending");
    expect(status.attempts).toBe(1);
    expect(status.lastError).toMatch(/connection reset/);
    expect(Date.parse(status.nextAttemptAt!)).toBeGreaterThan(Date.now());

    // A pass that runs before the deferral elapses must not try again: this is
    // what stops one relay outage becoming a tight loop against a host that is
    // already struggling.
    rig.fail(undefined);
    expect(await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 2))).toBe("skipped");
    expect(rig.sent).toHaveLength(0);

    // Once it is due, it sends. The backlog is delivered, not lost.
    const later = Date.parse(status.nextAttemptAt!) + 1000;
    expect(await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 3, later))).toBe(
      "sent",
    );
    expect(rig.sent).toHaveLength(1);
  });

  it("gives up after a bounded number of attempts and stays readable", async () => {
    const rig = recordingTransport();
    rig.fail("relay is gone");
    await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "doomed", NOTICE));
    const name = "dues-reminder-doomed";

    let now = Date.now();
    for (let i = 0; i < mail.MAX_ATTEMPTS; i++) {
      await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 10 + i, now));
      const s = (await asMail(() => control.get(mail.MAIL_NOTICE, name, { tenant: TENANT })))
        ?.status as import("./kinds").MailNoticeStatus;
      // Jump past the deferral so the next attempt is due.
      now = s.nextAttemptAt ? Date.parse(s.nextAttemptAt) + 1000 : now;
    }

    const stored = await asMail(() => control.get(mail.MAIL_NOTICE, name, { tenant: TENANT }));
    const status = stored?.status as import("./kinds").MailNoticeStatus;
    expect(status.state).toBe("failed");
    expect(status.attempts).toBe(mail.MAX_ATTEMPTS);
    // Still there, with the reason. A notice that gave up silently is worse than
    // one that was never raised: the treasurer believes the member was told.
    expect(status.lastError).toMatch(/relay is gone/);
    expect(stored).not.toBeNull();
  });

  it("refuses to send a notice whose template needs a param it did not supply", async () => {
    const rig = recordingTransport();
    await asMail(() =>
      mail.raiseNotice(TENANT, "dues-reminder", "incomplete", { ...NOTICE, params: {} }),
    );
    await asMail(() => mail.deliverNotice(rig.transport, TENANT, "dues-reminder-incomplete", 1));

    // Nothing left the building: the failure happened before the send, which is
    // the only place it can happen for a channel that cannot take anything back.
    expect(rig.sent).toHaveLength(0);
    const status = (
      await asMail(() =>
        control.get(mail.MAIL_NOTICE, "dues-reminder-incomplete", { tenant: TENANT }),
      )
    )?.status as import("./kinds").MailNoticeStatus;
    expect(status.lastError).toMatch(/needs a param/);
  });
});

describe("an unconfigured deployment holds the backlog (spec 037 §3.4)", () => {
  it("raises notices, sends nothing, and delivers them once a transport appears", async () => {
    await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "backlog", NOTICE));
    const name = "dues-reminder-backlog";

    // `none` is the DEFAULT, not a testing convenience. A deployment that has
    // configured no mail must boot and must not pretend to send.
    await asMail(() => mail.deliverNotice(mail.noneTransport, TENANT, name, 1));
    const held = (await asMail(() => control.get(mail.MAIL_NOTICE, name, { tenant: TENANT })))
      ?.status as import("./kinds").MailNoticeStatus;
    expect(held.state).toBe("pending");
    expect(held.lastError).toMatch(/no mail transport is configured/);

    // The backlog is the point: turning mail on later delivers it, rather than
    // the operator discovering that six months of reminders evaporated.
    const rig = recordingTransport();
    const due = Date.parse(held.nextAttemptAt!) + 1000;
    expect(await asMail(() => mail.deliverNotice(rig.transport, TENANT, name, 2, due))).toBe("sent");
    expect(rig.sent).toHaveLength(1);
  });
});

describe("the sweep drives retry (spec 037 §3.3)", () => {
  it("enumerates notices without the change feed, and skips what is not due", async () => {
    const rig = recordingTransport();
    await asMail(() => mail.raiseNotice(TENANT, "dues-reminder", "swept", NOTICE));

    // A deferred retry is not a write, so the change feed can never deliver
    // "this notice's backoff has now elapsed". That is what this loop is for.
    const delivered = await asMail(() => mail.mailSweepOnce(rig.transport));
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(rig.sent.some((m) => m.subject === "Your dues are due")).toBe(true);

    // Everything deliverable is now sent, so a second pass sends nothing.
    const second = await asMail(() => mail.mailSweepOnce(rig.transport));
    expect(second).toBe(0);
  });
});

describe("the ceiling (spec 037 §3.2)", () => {
  it("allows smtp.egress only to the service that holds the grant", async () => {
    // The mail service holds cap.smtp.mail-relay, so this is the one place a
    // socket may be opened.
    expect(() => runAsService("mail", () => demandSmtpEgress("mail-relay", "relay.example.org"))).
      not.toThrow();
  });

  it("denies a service without the capability, and the denial is a Decision", () => {
    // Mail that could not be sent because the capability was absent is a
    // Decision, not a log line (spec 037 §3.2). The decision id on the thrown
    // error is the handle to that record, which is what makes "why did this
    // member never hear from us" answerable from the ledger rather than from
    // whatever the log retention happens to be.
    let thrown: unknown;
    try {
      runAsService("web", () => demandSmtpEgress("mail-relay", "relay.example.org"));
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toMatch(/denied for service 'web'/);
    const details = (thrown as { details?: { code?: string; kind?: string; decisionId?: string } })
      .details;
    expect(details?.code).toBe("KERNEL_DENIED");
    expect(details?.kind).toBe("smtp.egress");
    expect(details?.decisionId).toMatch(/^decision-/);
  });
});
