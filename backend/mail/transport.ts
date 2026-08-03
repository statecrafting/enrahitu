/**
 * The mail transports (spec 037 §3.2, §3.4, §3.6).
 *
 * **This module is to SMTP what `backend/kernel/egress.ts` is to HTTP**: the one
 * place in `backend/` permitted to open a socket, and every send adjudicates
 * `smtp.egress` before anything leaves the process. A rule enforced only by
 * review is a rule that lasts until the first hurry, so the extraction ban-list
 * is what actually holds this line; see spec 037 §3.2 and the note in §5 of this
 * file's spec about where that check currently lives.
 *
 * One interface, chosen by environment, with no provider name anywhere in domain
 * code. A notice does not know how it travels.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { demandSmtpEgress, governedFetch } from "../kernel/egress";
import { env } from "../lib/env";
import { mailPasswordValue } from "../lib/secrets";

export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export interface MailTransport {
  /** The name an operator sees, and what the notice's error will blame. */
  readonly name: string;
  send(message: Message): Promise<void>;
}

export class MailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// The message on the wire
// ---------------------------------------------------------------------------

/**
 * Encode a header value that may contain non-ASCII.
 *
 * An association's name has accents in it more often than not, and a raw
 * high-byte header is what makes a subject line arrive as mojibake in half of
 * the clients that receive it.
 */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * SMTP's dot-stuffing rule: a line consisting of a single "." ends DATA, so any
 * body line that starts with one has to be doubled. Skipping this is how a
 * message whose text happens to contain a lone dot gets truncated at that line
 * and delivered looking fine to whoever tested with "hello world".
 */
function dotStuff(body: string): string {
  return body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

export function buildMessage(from: string, message: Message): string {
  const boundary = `enrahitu-${Buffer.from(message.to + message.subject).toString("hex").slice(0, 24)}`;
  const headers = [
    `From: ${encodeHeader(from)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (message.replyTo) headers.push(`Reply-To: ${message.replyTo}`);

  // multipart/alternative, text first: the order is the specification's, and it
  // means a client that cannot render HTML shows the part written for it rather
  // than a wall of tags.
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    message.html,
    "",
    `--${boundary}--`,
    "",
  ].join("\n");

  return `${headers.join("\r\n")}\r\n\r\n${dotStuff(body)}`;
}

// ---------------------------------------------------------------------------
// A minimal SMTP conversation
//
// Written rather than taken from a library, for two reasons that both point the
// same way. A mailer dependency is a large amount of code with network reach
// inside a process whose whole thesis is a bounded, auditable ceiling, and the
// ban-list would have to allow it by name anyway. And what is needed here is
// the 1982 core of the protocol: greet, envelope, DATA, quit.
// ---------------------------------------------------------------------------

interface Conversation {
  expect(codes: number[], label: string): Promise<string>;
  send(line: string): void;
  upgrade(host: string): Promise<void>;
  end(): void;
}

function converse(socket: Socket, timeoutMs: number): Conversation {
  let current = socket;
  let buffer = "";
  let waiter: ((chunk: string) => void) | undefined;
  let failure: Error | undefined;

  const attach = (s: Socket): void => {
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buffer += chunk;
      // A reply is complete when a line's fourth character is a space rather
      // than a hyphen: "250-EXTENSION" continues, "250 OK" ends.
      const lines = buffer.split(/\r?\n/).filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last) && waiter) {
        const done = buffer;
        buffer = "";
        const w = waiter;
        waiter = undefined;
        w(done);
      }
    });
    s.on("error", (err: Error) => {
      failure = err;
      waiter?.("");
    });
  };
  attach(current);

  return {
    async expect(codes, label) {
      // Checked BEFORE waiting, not only after. A socket error that lands
      // between two commands has no waiter to resolve, so without this the next
      // expect() waits out the full timeout and reports "timeout waiting for
      // MAIL FROM" for what was actually a connection reset fifteen seconds
      // earlier. The error an operator sees should name what happened.
      if (failure) throw failure;
      const reply = await new Promise<string>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          rejectPromise(new Error(`SMTP timeout waiting for ${label}`));
        }, timeoutMs);
        waiter = (chunk) => {
          clearTimeout(timer);
          resolvePromise(chunk);
        };
        if (buffer && /^\d{3} /m.test(buffer)) {
          const done = buffer;
          buffer = "";
          waiter = undefined;
          clearTimeout(timer);
          resolvePromise(done);
        }
      });
      if (failure) throw failure;
      const code = Number(reply.slice(0, 3));
      if (!codes.includes(code)) {
        throw new Error(`SMTP ${label} refused: ${reply.trim()}`);
      }
      return reply;
    },
    send(line) {
      current.write(`${line}\r\n`);
    },
    async upgrade(host) {
      const plain = current;
      current = await new Promise<Socket>((resolvePromise, rejectPromise) => {
        const secured = tlsConnect({ socket: plain, servername: host }, () => {
          resolvePromise(secured as unknown as Socket);
        });
        secured.on("error", rejectPromise);
      });
      buffer = "";
      attach(current);
    },
    end() {
      current.end();
    },
  };
}

interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password: string;
  insecure: boolean;
  from: string;
  /** The logical relay name the capability is granted on. */
  resource: string;
  timeoutMs: number;
}

async function sendOverSmtp(config: SmtpConfig, message: Message): Promise<void> {
  // Before the socket, never after: a denial must cost nothing and must be a
  // Decision rather than a log line (spec 037 §3.2).
  demandSmtpEgress(config.resource, config.host);

  const implicitTls = config.port === 465;
  const socket: Socket = await new Promise((resolvePromise, rejectPromise) => {
    const s = implicitTls
      ? (tlsConnect({ host: config.host, port: config.port, servername: config.host }, () =>
          resolvePromise(s as unknown as Socket),
        ) as unknown as Socket)
      : netConnect({ host: config.host, port: config.port }, () => resolvePromise(s));
    s.on("error", rejectPromise);
    s.setTimeout(config.timeoutMs, () => {
      s.destroy(new Error(`SMTP connect timeout to ${config.host}:${config.port}`));
    });
  });

  const smtp = converse(socket, config.timeoutMs);
  try {
    await smtp.expect([220], "greeting");
    smtp.send("EHLO enrahitu");
    let capabilities = await smtp.expect([250], "EHLO");

    if (!implicitTls && /STARTTLS/i.test(capabilities)) {
      smtp.send("STARTTLS");
      await smtp.expect([220], "STARTTLS");
      await smtp.upgrade(config.host);
      smtp.send("EHLO enrahitu");
      capabilities = await smtp.expect([250], "EHLO after STARTTLS");
    } else if (!implicitTls && !config.insecure) {
      // Refusing is the only honest option. Continuing would send the
      // association's mail, and any credentials, in the clear while the operator
      // believes the relay is configured. ENRAHITU_MAIL_DANGER_INSECURE is the
      // explicit opt-in, and it is what the dev topology's catcher uses.
      throw new MailNotConfiguredError(
        `relay ${config.host}:${config.port} does not offer STARTTLS. Set ` +
          "ENRAHITU_MAIL_DANGER_INSECURE=true only if the relay is on a private network " +
          "that never forwards mail.",
      );
    }

    if (config.user) {
      // AUTH PLAIN: authzid NUL authcid NUL password, base64. Sent only after
      // the channel is encrypted, or on an explicitly insecure relay.
      const token = Buffer.from(`\0${config.user}\0${config.password}`, "utf8").toString("base64");
      smtp.send(`AUTH PLAIN ${token}`);
      await smtp.expect([235], "AUTH");
    }

    smtp.send(`MAIL FROM:<${config.from}>`);
    await smtp.expect([250], "MAIL FROM");
    smtp.send(`RCPT TO:<${message.to}>`);
    await smtp.expect([250, 251], "RCPT TO");
    smtp.send("DATA");
    await smtp.expect([354], "DATA");
    smtp.send(`${buildMessage(config.from, message)}\r\n.`);
    await smtp.expect([250], "message body");
    smtp.send("QUIT");
  } finally {
    smtp.end();
  }
}

// ---------------------------------------------------------------------------
// The transports
// ---------------------------------------------------------------------------

/**
 * The default, and not a testing convenience (spec 037 §3.4).
 *
 * A deployment that has configured no mail must not fail to boot and must not
 * pretend to send. Notices are still raised and remain `pending`, visibly, so
 * turning mail on later delivers the backlog rather than discovering that six
 * months of reminders evaporated.
 */
export const noneTransport: MailTransport = {
  name: "none",
  async send() {
    throw new MailNotConfiguredError(
      "no mail transport is configured (ENRAHITU_MAIL_TRANSPORT=none), so this notice is " +
        "held rather than sent. Configure a transport and it will be delivered on the next pass.",
    );
  },
};

export function smtpTransport(): MailTransport {
  const from = requireFrom();
  return {
    name: "smtp",
    send: (message) =>
      sendOverSmtp(
        {
          host: env.mailRelayHost,
          port: env.mailRelayPort,
          user: env.mailUser,
          password: env.mailUser ? mailPasswordValue() : "",
          insecure: env.mailInsecure,
          from,
          resource: "mail-relay",
          timeoutMs: 15_000,
        },
        message,
      ),
  };
}

/**
 * An HTTPS provider, which needs none of §3.2's machinery: it is a normal
 * request and already adjudicates through `governedFetch`. The kind exists for
 * the self-hosted case, which is the primary one for this substrate.
 */
export function providerTransport(): MailTransport {
  const from = requireFrom();
  const endpoint = process.env.ENRAHITU_MAIL_ENDPOINT;
  if (!endpoint) {
    throw new MailNotConfiguredError(
      "ENRAHITU_MAIL_TRANSPORT=provider needs ENRAHITU_MAIL_ENDPOINT, the provider's send URL.",
    );
  }
  return {
    name: "provider",
    async send(message) {
      const res = await governedFetch("mail-provider", endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.ENRAHITU_MAIL_TOKEN
            ? { authorization: `Bearer ${process.env.ENRAHITU_MAIL_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`mail provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}

/**
 * The sender identity (spec 037 §3.6).
 *
 * Required whenever the transport is not `none`, with no default deliberately: a
 * fallback would put a plausible-looking address on real mail sent to real
 * members, and the failure would be discovered by a bounce rather than by a
 * boot.
 */
function requireFrom(): string {
  const from = env.mailFrom;
  if (!from) {
    throw new MailNotConfiguredError(
      "ENRAHITU_MAIL_FROM is required when a mail transport is configured: it is the address " +
        "the association's mail is sent from. There is no default, because a guessed sender " +
        "is discovered by a bounce rather than by a failed boot.",
    );
  }
  return from;
}

/** The configured transport. Called once at boot; `none` when unset. */
export function resolveTransport(): MailTransport {
  switch (env.mailTransport) {
    case "none":
      return noneTransport;
    case "smtp":
      return smtpTransport();
    case "provider":
      return providerTransport();
    default:
      throw new MailNotConfiguredError(
        `ENRAHITU_MAIL_TRANSPORT '${env.mailTransport}' is not a transport: expected ` +
          "'none', 'smtp' or 'provider'.",
      );
  }
}
