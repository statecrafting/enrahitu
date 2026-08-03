/**
 * The SMTP conversation against a fake relay (spec 037 §3.2).
 *
 * `buildMessage` is covered by pure tests and the delivery loop is covered with
 * a fake transport, which leaves the protocol itself: the one piece of this
 * feature that talks to something. It is also the piece a library would
 * ordinarily provide, so declining the library means owning the tests.
 *
 * The server below is deliberately literal about SMTP's shape (a greeting, a
 * multi-line EHLO, a DATA body terminated by a lone dot) because the failures
 * worth catching here are protocol failures, and a mock that just says 250 to
 * everything would catch none of them.
 */
import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeRelay {
  port: number;
  /** Everything the client sent inside DATA, as one string. */
  received(): string;
  commands(): string[];
  /** Resolves when the client has said QUIT, so assertions do not race the wire. */
  quit: Promise<void>;
  close(): Promise<void>;
}

/** A relay that completes the conversation, or refuses at a chosen stage. */
function fakeRelay(opts: { refuse?: { at: string; code: number }; esmtp?: string[] } = {}) {
  return new Promise<FakeRelay>((resolve) => {
    const commands: string[] = [];
    let body = "";
    let sawQuit!: () => void;
    const quit = new Promise<void>((r) => {
      sawQuit = r;
    });

    const server: Server = createServer((socket: Socket) => {
      let inData = false;
      let buffer = "";
      socket.setEncoding("utf8");
      socket.write("220 fake.relay ESMTP\r\n");

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const nl = buffer.indexOf("\r\n");
          if (nl === -1) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);

          if (inData) {
            // A lone dot ends DATA. Anything else is body, with dot-stuffing
            // undone exactly as a real relay would.
            if (line === ".") {
              inData = false;
              socket.write("250 2.0.0 queued\r\n");
              continue;
            }
            body += `${line.startsWith("..") ? line.slice(1) : line}\n`;
            continue;
          }

          const verb = line.split(" ")[0]!.toUpperCase();
          commands.push(line);

          if (opts.refuse && verb === opts.refuse.at) {
            socket.write(`${opts.refuse.code} 5.0.0 refused by the test\r\n`);
            continue;
          }
          if (verb === "EHLO") {
            const ext = opts.esmtp ?? ["SIZE 10240000"];
            for (const e of ext) socket.write(`250-${e}\r\n`);
            socket.write("250 HELP\r\n");
          } else if (verb === "DATA") {
            inData = true;
            socket.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
            sawQuit();
          } else if (verb === "AUTH") {
            // 235, not 250. A relay that answered 250 here would have the client
            // treat an unauthenticated session as authenticated.
            socket.write("235 2.7.0 authenticated\r\n");
          } else {
            socket.write("250 2.0.0 ok\r\n");
          }
        }
      });
      socket.on("error", () => {
        /* the client hanging up mid-conversation is a case under test */
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        received: () => body,
        commands: () => commands,
        quit,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * A sender bound to this relay, running under a chosen service.
 *
 * `env` reads process.env once at module load, so the port has to be set before
 * the import and the registry has to be reset between cases. The kernel scope
 * has to come from that SAME fresh registry: `runAsService` writes to an
 * AsyncLocalStorage held in module state, so a scope opened with the top-level
 * import is invisible to a transport that imported its own copy, and every send
 * would adjudicate as the unattributed service.
 */
async function senderFor(
  relay: FakeRelay,
  over: Record<string, string> = {},
): Promise<(service: string, message: import("./transport").Message) => Promise<void>> {
  vi.resetModules();
  process.env.ENRAHITU_MAIL_TRANSPORT = "smtp";
  process.env.ENRAHITU_MAIL_HOST = "127.0.0.1";
  process.env.ENRAHITU_MAIL_PORT = String(relay.port);
  process.env.ENRAHITU_MAIL_FROM = "hollis-society@example.org";
  process.env.ENRAHITU_MAIL_DANGER_INSECURE = "true";
  delete process.env.ENRAHITU_MAIL_USER;
  delete process.env.ENRAHITU_MAIL_PASSWORD;
  for (const [k, v] of Object.entries(over)) process.env[k] = v;

  const transportMod = (await import("./transport")) as typeof import("./transport");
  const kernelMod = (await import("../kernel/adjudicate")) as typeof import("../kernel/adjudicate");
  const transport = transportMod.smtpTransport();
  return (service, message) => kernelMod.runAsService(service, () => transport.send(message));
}

const MESSAGE = {
  to: "ada@example.org",
  subject: "Your dues are due",
  text: "Hello Ada.\n.\nThat lone dot is deliberate.",
  html: "<p>Hello Ada.</p>",
};

let relay: FakeRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("the SMTP conversation (spec 037 §3.2)", () => {
  it("completes the envelope in order and delivers the body", async () => {
    relay = await fakeRelay();
    const send = await senderFor(relay);
    await send("mail", MESSAGE);
    // send() resolves once the body is accepted; QUIT is written after that, so
    // asserting on it without waiting races the socket.
    await relay.quit;

    const verbs = relay.commands().map((c) => c.split(" ")[0]!.toUpperCase());
    expect(verbs).toEqual(["EHLO", "MAIL", "RCPT", "DATA", "QUIT"]);
    expect(relay.commands()[1]).toBe("MAIL FROM:<hollis-society@example.org>");
    expect(relay.commands()[2]).toBe("RCPT TO:<ada@example.org>");

    const body = relay.received();
    expect(body).toContain("From: hollis-society@example.org");
    expect(body).toContain("To: ada@example.org");
    expect(body).toContain("Subject: Your dues are due");
    expect(body).toContain("multipart/alternative");
    // Dot-stuffing survived the round trip: the relay un-stuffed a line that
    // would otherwise have terminated the message early, and the text after it
    // is still here. Without stuffing this assertion is the one that fails.
    expect(body).toContain("That lone dot is deliberate.");
    expect(body).toMatch(/\n\.\n/);
  });

  it("names the stage a relay refused at, rather than failing anonymously", async () => {
    // An operator reading "SMTP RCPT TO refused" knows the recipient was
    // rejected; "send failed" sends them to the logs.
    relay = await fakeRelay({ refuse: { at: "RCPT", code: 550 } });
    const send = await senderFor(relay);
    await expect(send("mail", MESSAGE)).rejects.toThrow(/RCPT TO refused: 550/);
  });

  it("refuses a relay with no STARTTLS unless told the network is private", async () => {
    // Continuing would send the association's mail, and any credentials, in the
    // clear while the operator believes the relay is configured.
    relay = await fakeRelay();
    const send = await senderFor(relay, { ENRAHITU_MAIL_DANGER_INSECURE: "false" });
    await expect(send("mail", MESSAGE)).rejects.toThrow(
      /does not offer STARTTLS.*ENRAHITU_MAIL_DANGER_INSECURE/s,
    );
  });

  it("authenticates when a user is configured, before the envelope", async () => {
    relay = await fakeRelay({ esmtp: ["AUTH PLAIN LOGIN"] });
    const send = await senderFor(relay, {
      ENRAHITU_MAIL_USER: "postmaster",
      ENRAHITU_MAIL_PASSWORD: "hunter2",
    });
    await send("mail", MESSAGE);

    const auth = relay.commands().find((c) => c.startsWith("AUTH PLAIN "));
    expect(auth).toBeDefined();
    const decoded = Buffer.from(auth!.slice("AUTH PLAIN ".length), "base64").toString("utf8");
    expect(decoded).toBe("\0postmaster\0hunter2");
    // Credentials go before the envelope, never after: a relay that rejects
    // unauthenticated senders would otherwise refuse MAIL FROM first and the
    // error would blame the sender address.
    const verbs = relay.commands().map((c) => c.split(" ")[0]!.toUpperCase());
    expect(verbs.indexOf("AUTH")).toBeLessThan(verbs.indexOf("MAIL"));
  });

  it("is denied before it opens a socket when the service lacks the capability", async () => {
    relay = await fakeRelay();
    const send = await senderFor(relay);
    await expect(send("web", MESSAGE)).rejects.toThrow(/smtp\.egress.*denied for service 'web'/);
    // Nothing was said to the relay: adjudication happens before the connect,
    // so a denial costs no connection and leaks no envelope.
    expect(relay.commands()).toEqual([]);
  });
});
