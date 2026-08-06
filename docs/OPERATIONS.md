# Operating enrahitu

The manual for running a cell: installing it, putting it behind TLS, wiring
probes, backing it up, upgrading it, and finding the cause when something is
wrong at 02:00.

This is not the design record. The specs under `specs/` answer *why the
substrate is built this way*; this document answers *what do I type*. Where the
two disagree about intent, the spec wins; where they disagree about a command,
this document is the one that was run.

A **cell** is one container plus one volume: the application, its identity
provider, and all of its durable state. That is the whole deployment unit. Most
installations run exactly one and never need a second.

---

## 1. Install

The minimum that produces a working cell:

```bash
docker volume create enrahitu-data

docker run -d --name enrahitu \
  -v enrahitu-data:/data \
  -p 8080:8080 \
  -e ENRAHITU_PUBLIC_URL=http://localhost:8080 \
  enrahitu:latest
```

Open `http://localhost:8080`. The admin account and its password are printed
once, on the first boot, by `[first-boot]`:

```bash
docker logs enrahitu | grep '\[first-boot\] rauthy admin'
```

The password is also on the volume at `/data/rauthy/admin-password`. Read it
from there if the log has rotated away:

```bash
docker exec enrahitu cat /data/rauthy/admin-password
```

### Apply the schema once, after the first boot

A freshly provisioned cell has no control-plane schema. Until it does, the
background controllers cannot read their watermark and log
`no such table: controller_watermark` roughly once a second, forever.

```bash
node scripts/ops/migrate.mjs            # report what is pending
node scripts/ops/migrate.mjs --apply    # create it
```

The verb reaches the running app's admin plane, so it needs an operator session
in `ENRAHITU_OPERATOR_COOKIE` (section 7). Migration is a deploy step rather
than a boot step on purpose: tying schema change to process restart turns a
crash loop into a migration loop. `ENRAHITU_MIGRATE_ON_BOOT=true` folds it into
startup if you would rather accept that trade for a single-container install.

`ENRAHITU_PUBLIC_URL` is the one variable you must set correctly and the one
that causes most installation failures. It is the origin a *browser* uses, not
the address the container binds. If users reach the cell at
`https://members.example.org`, that is the value, even though the container is
listening on plain http inside your network. Section 2 covers what changes when
it is an `https` URL.

### What first boot puts on the volume

Provisioning is **write-once**. A restart or an image upgrade never rotates
material you have already configured a scraper, a fleet, or a backup against.

| Path | What it is |
|---|---|
| `/data/keys/access-{private,public}.pem` | RS256 keypair signing access tokens |
| `/data/keys/refresh-{private,public}.pem` | RS256 keypair signing refresh tokens |
| `/data/keys/rauthy-client-secret` | the app's OIDC client secret |
| `/data/keys/metrics-token` | the bearer token for `/metrics` (section 4) |
| `/data/rauthy/admin-password` | the bootstrapped admin's password |
| `/data/rauthy/secrets.env` | encryption keys and raft/API secrets for **both** hiqlite nodes |
| `/data/rauthy/bootstrap/clients.json` | the declarative OIDC client, applied by rauthy only while its store is empty |
| `/data/ledger/enrahitu.db` | CoreLedger: application data |
| `/data/hiqlite/` | the app's hiqlite raft log and snapshots |
| `/data/rauthy/db/` | rauthy's own hiqlite store |

**The whole volume is a secret.** `secrets.env` holds the keys that decrypt
both stores' snapshots, so a copy of this volume is a copy of the association's
data with the means to read it. Treat backups accordingly (section 6).

### Every `ENRAHITU_*` variable

Defaults are what the packaged image uses when you set nothing.

| Variable | Default | Secret | What it does |
|---|---|---|---|
| `ENRAHITU_PUBLIC_URL` | `http://localhost:8080` | no | The origin browsers use. Drives rauthy's issuer, the OIDC redirect URI, allowed origins, and whether cookies are `Secure`. |
| `ENRAHITU_DATA_DIR` | `/data` | no | Root of the volume. Change only if you mount somewhere else. |
| `ENRAHITU_ADMIN_EMAIL` | `admin@example.com` | no | The bootstrapped admin's address. First boot only. |
| `ENRAHITU_TRUSTED_PROXY_HOPS` | `0` | no | How many reverse proxies sit in front, counted from the right of `X-Forwarded-For`. Section 2. |
| `ENRAHITU_LEDGER_URL` | `file:$ENRAHITU_DATA_DIR/ledger/enrahitu.db` | no | CoreLedger target. A `libsql://` URL points at Turso; a scheme is required. |
| `ENRAHITU_METRICS_TOKEN` | contents of `/data/keys/metrics-token` | **yes** | Bearer token for `/metrics`. Set it to share one token across a fleet. |
| `ENRAHITU_MIGRATE_ON_BOOT` | `false` | no | Run CoreLedger migrations at boot. Off by default: it ties schema change to process restart, so a crash loop becomes a migration loop. Section 7. |
| `ENRAHITU_REQUIRED_ENV` | unset | no | Comma or space separated names pre-flight requires to be set and non-empty. A fleet's way to make an optional variable mandatory. |
| `ENRAHITU_KEYS_DIR` | `$ENRAHITU_DATA_DIR/keys` | no | Where the JWT keypairs live. Set by the entrypoint; not normally an operator knob. |
| `ENRAHITU_DEV` | `0` | no | `1` selects the development watch loop. Not for deployments. |
| **Restore** (section 6) | | | |
| `ENRAHITU_RESTORE_RAUTHY` | unset | no | Restore the identity store from this backup, once. Safe to leave set forever. |
| `ENRAHITU_RESTORE_APP` | unset | no | Restore the app's resource store from this backup, once. |
| **The IdP's mail relay** (section 5) | | | |
| `ENRAHITU_SMTP_URL` | unset | no | Relay host for rauthy's mail: password reset, verification, invitations. |
| `ENRAHITU_SMTP_PORT` | rauthy's default | no | Relay port. |
| `ENRAHITU_SMTP_USERNAME` | unset | no | Relay username. |
| `ENRAHITU_SMTP_PASSWORD` | unset | **yes** | Relay password. |
| `ENRAHITU_SMTP_FROM` | rauthy's default | no | Envelope sender for IdP mail. |
| `ENRAHITU_SMTP_STARTTLS_ONLY` | rauthy's default | no | Require STARTTLS. |
| `ENRAHITU_SMTP_CONNECT_RETRIES` | rauthy's default | no | Connection retry count. |
| `ENRAHITU_SMTP_DANGER_INSECURE` | rauthy's default | no | Plaintext SMTP. Private-network catchers only. |
| **The application's mail relay** (section 5) | | | |
| `ENRAHITU_MAIL_TRANSPORT` | `none` | no | `none` or `smtp`. `none` boots and does not pretend to send. |
| `ENRAHITU_MAIL_HOST` | `localhost` | no | Relay host for application mail. |
| `ENRAHITU_MAIL_PORT` | `25` | no | Relay port. |
| `ENRAHITU_MAIL_USER` | unset | no | Relay username. |
| `ENRAHITU_MAIL_PASSWORD` | unset | **yes** | Relay password. |
| `ENRAHITU_MAIL_FROM` | unset | no | Envelope sender for application mail. |
| `ENRAHITU_MAIL_DANGER_INSECURE` | `false` | no | Plaintext with no STARTTLS. A catcher on a private network only; anywhere else this sends member data in the clear. |
| **hiqlite** (provisioned, not configured) | | | |
| `ENRAHITU_HIQ_DATA_DIR` | `$ENRAHITU_DATA_DIR/hiqlite` | no | The app node's raft directory. |
| `ENRAHITU_HIQ_ADDR_RAFT` | `127.0.0.1:8300` | no | Raft address. rauthy's node owns 8100/8200 in the same namespace. |
| `ENRAHITU_HIQ_ADDR_API` | `127.0.0.1:8400` | no | hiqlite API address. |
| `ENRAHITU_HIQ_NODE_ID` | `1` at N=1 | no | This node's ordinal. |
| `ENRAHITU_HIQ_NODES` | single voter | no | The cluster roster. N=1 is the primary mode. |
| `ENRAHITU_HIQ_ENC_KEYS` | provisioned first boot | **yes** | Encrypts the app node's snapshots. Lives in `secrets.env`. |
| `ENRAHITU_HIQ_ENC_KEY_ACTIVE` | provisioned first boot | no | Which key in the set is used for new encryption. |
| `ENRAHITU_HIQ_SECRET_RAFT` | provisioned first boot | **yes** | Raft peer secret. |
| `ENRAHITU_HIQ_SECRET_API` | provisioned first boot | **yes** | hiqlite API secret. |

The `ENRAHITU_HIQ_*` block is provisioned into `secrets.env` on first boot and
handed to the app process by the entrypoint. You do not normally set any of it.
If you set the encryption key yourself, keep it with every backup you have ever
taken: a snapshot encrypted under a key you no longer have is not recoverable.

**Two mail surfaces, deliberately.** `ENRAHITU_SMTP_*` is the identity
provider's relay and reaches only rauthy. `ENRAHITU_MAIL_*` is the
application's and reaches only the app. Neither process can see the other's
credentials. They may point at the same relay; they are still configured twice.

---

## 2. Put it behind TLS

The cell speaks plain http and expects TLS to be terminated in front of it. Get
this wrong and login half-works: the form renders, the redirect happens, and
the session never sticks. The symptom does not point at the cause, which is why
this section is long.

Three things have to agree:

1. **`ENRAHITU_PUBLIC_URL` is the https origin users type.** Setting it to an
   `https://` URL flips rauthy into `PROXY_MODE` and makes it mint https URLs
   in discovery, the issuer, and every redirect. Leave it as `http://` behind a
   TLS proxy and rauthy advertises http URLs that the browser then refuses to
   follow from an https page.
2. **`ENRAHITU_TRUSTED_PROXY_HOPS` matches how many proxies you actually run.**
   The default `0` means the peer address is the client. With one proxy in
   front, every request appears to come from the proxy, so rate limiting
   becomes global rather than per-client. Set it to the number of proxies you
   control, counted from the right of `X-Forwarded-For`, so a client cannot
   forge the hops to its left.
3. **The proxy forwards the `Host` header and the standard `X-Forwarded-*`
   set**, and does not strip cookies.

Only one port is exposed: `8080`. The IdP is reached through the app's own
origin at `/auth/*` and must never be published separately.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name members.example.org;

  ssl_certificate     /etc/letsencrypt/live/members.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/members.example.org/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;

    proxy_read_timeout 120s;

    # REQUIRED, not tuning. The OIDC callback sets the access and refresh
    # JWTs as cookies in one response, and those headers exceed nginx's
    # default 4k/8k proxy buffer. Without this, login completes at the IdP
    # and then dies at the callback with a 502, while the application log
    # shows a successful 302: nginx failed to relay a response the app
    # produced correctly. The error appears only in nginx's own log, as
    # "upstream sent too big header while reading response header".
    proxy_buffer_size       16k;
    proxy_buffers         8 16k;
    proxy_busy_buffers_size 32k;
  }
}
```

Run the cell with:

```bash
-e ENRAHITU_PUBLIC_URL=https://members.example.org \
-e ENRAHITU_TRUSTED_PROXY_HOPS=1
```

**The cell must be able to reach `ENRAHITU_PUBLIC_URL` itself.** Server-side
OIDC discovery fetches `$ENRAHITU_PUBLIC_URL/auth/v1/.well-known/openid-configuration`,
so the container resolves and connects to its own public origin, hairpinning
through the proxy. Normally that is automatic. It breaks under split-horizon
DNS, where the public name resolves only outside, and the symptom is a bare
`500` from `/api/v1/auth/rauthy/login` naming nothing. Give the container a
route to its own hostname and the certificate that name is issued for.

### Caddy

Caddy sets the forwarded headers itself and obtains a certificate without
further configuration.

```caddy
members.example.org {
  reverse_proxy 127.0.0.1:8080
}
```

Same two variables as nginx: the https origin, and one hop. Caddy needs no
buffer tuning, because it does not cap response header size the way nginx does.
That is the whole of the difference between these two examples, and it is why
the nginx one is longer.

### Kubernetes Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: enrahitu
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    # The ingress-nginx controller is nginx, so it has nginx's header buffer
    # limit and the same 502-at-the-callback failure without this.
    nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [members.example.org]
      secretName: enrahitu-tls
  rules:
    - host: members.example.org
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: enrahitu
                port:
                  number: 8080
```

An ingress controller behind a cloud load balancer is **two** hops, so
`ENRAHITU_TRUSTED_PROXY_HOPS=2`. Count what is actually in the path rather than
assuming one.

The workload is a `StatefulSet` with one replica and one `PersistentVolumeClaim`,
not a `Deployment`: the volume is the cell, and two pods sharing one claim is
two hiqlite nodes opening one raft directory. Probes go on `/healthz` and
`/readyz` as described next.

### Verification record

| Example | Status | Date |
|---|---|---|
| nginx | **verified**: real password login round-trip through TLS termination against the packaged image, both token cookies set and `Secure`, no request left the app origin | 2026-08-06 |
| Caddy | **verified**, same method and same result | 2026-08-06 |
| Kubernetes Ingress | **not yet verified**: no cluster was available. Its buffer annotation is derived from the nginx result rather than observed | |

The nginx example is what it is *because* of that verification: the version
without the buffer directives was written first, and it failed.

---

## 3. Wire the probes

| Endpoint | Question | Touches a dependency | Probe |
|---|---|---|---|
| `/healthz` | Is this process alive and serving? | no | liveness |
| `/readyz` | Should this instance receive traffic? | yes: the ledger and hiqlite | readiness |
| `/health` | permanent alias of `/readyz` | yes | do not use for liveness |

**Do not point a liveness probe at `/readyz` or `/health`.** The reason is
specific to this substrate. The container supervises rauthy and the application
under a die-together policy: if either exits, the container exits. So a
liveness probe that fails on a dependency check turns a transient ledger blip
into a container restart, and that restart also ends the identity provider. A
database wobble becomes an identity outage for everyone, including people who
were only trying to log in.

Liveness therefore touches nothing. It fails only when the process cannot
answer, which is the one case where restarting is the right response.

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  initialDelaySeconds: 20
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
  initialDelaySeconds: 10
  periodSeconds: 5
```

Give liveness a generous `initialDelaySeconds`. First boot provisions two RSA
keypairs and waits for rauthy before the app starts.

---

## 4. Scrape the metrics

`/metrics` serves Prometheus text format and is always on. It is not behind a
flag; it is behind a token.

The token is provisioned on first boot at `/data/keys/metrics-token`, so the
packaged image is authenticated by default rather than opt-in:

```bash
docker exec enrahitu cat /data/keys/metrics-token
```

```bash
curl localhost:8080/metrics -H "Authorization: Bearer $TOKEN"
```

Without the header the endpoint returns `401` with `WWW-Authenticate: Bearer`.
Set `ENRAHITU_METRICS_TOKEN` explicitly to give a whole fleet one token; the
supplied value wins over the provisioned one.

```yaml
scrape_configs:
  - job_name: enrahitu
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <token>
    static_configs:
      - targets: ["members.example.org:8080"]
```

Tracing is in-process by default: a bounded recent-trace buffer the operator
dashboard reads. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship spans to a
collector. Unset means no exporter and no outbound connection, which is the
default deliberately.

---

## 5. Configure mail

**If you configure no relay, password reset, email verification, registration,
and invitation do not deliver, and the bootstrapped admin is the only account
anyone can ever use.** That is the first sentence rather than the last because
the failure is silent: rauthy treats mail as optional and degrades quietly, so
the first sign is a locked-out administrator who cannot reset their own
password.

First boot says so in the log when `ENRAHITU_SMTP_URL` is unset. It is a notice
and not a failure, so a local trial keeps working with no mail server. To make
it mandatory for a fleet, add the name to `ENRAHITU_REQUIRED_ENV` and pre-flight
turns the notice into a refusal to boot.

There are two independent surfaces:

```bash
# The IdP's relay: password reset, verification, invitations.
-e ENRAHITU_SMTP_URL=smtp.example.org \
-e ENRAHITU_SMTP_PORT=587 \
-e ENRAHITU_SMTP_USERNAME=postmaster@example.org \
-e ENRAHITU_SMTP_PASSWORD=... \
-e ENRAHITU_SMTP_FROM='Example Society <noreply@example.org>' \

# The application's relay: dues notices, renewals, announcements.
-e ENRAHITU_MAIL_TRANSPORT=smtp \
-e ENRAHITU_MAIL_HOST=smtp.example.org \
-e ENRAHITU_MAIL_PORT=587 \
-e ENRAHITU_MAIL_USER=members@example.org \
-e ENRAHITU_MAIL_PASSWORD=... \
-e ENRAHITU_MAIL_FROM='Example Society <members@example.org>'
```

They may point at the same relay. They are still two surfaces, because a
credential leaked from one must not be the other's. The entrypoint enforces
this: each process holds only its own, and an ambient `SMTP_*` inherited from
an orchestrator is scrubbed rather than honoured, so a shared variable meant
for a different workload cannot silently configure this IdP's mail path.

`ENRAHITU_MAIL_DANGER_INSECURE=true` disables STARTTLS. It exists for a mail
catcher on a private network. Anywhere else it sends credentials and member
data in the clear.

---

## 6. Back up and restore

The verbs live in `scripts/ops/` and run with plain `node`.

### The archive

`backup` produces **one** artifact holding every class of durable state:
CoreLedger, the app's hiqlite snapshot, rauthy's store, and the key material
that decrypts the other three.

That last member is why it is one artifact rather than parts an operator
assembles. rauthy encrypts data at rest with `ENC_KEYS`, and the app's hiqlite
encrypts its snapshots with `ENRAHITU_HIQ_ENC_KEYS`. Both live in
`secrets.env`. Either store restored without its matching keys is
undecryptable, so keys and encrypted stores are never separable.

**The archive is therefore a secret in its entirety.** The verb writes it
`0600` and refuses a world-readable destination. Store it where you would store
the volume itself.

### Taking one

```bash
# Cold: the container is stopped. The honest default.
docker stop enrahitu
node scripts/ops/backup.mjs --out /secure/backups
docker start enrahitu

# Hot: the cell keeps serving.
node scripts/ops/backup.mjs --online --out /secure/backups
```

Cold and hot are two tools rather than two settings. Cold copies each class
directly, which is safe precisely because everything is at rest. Hot asks each
store for a consistent snapshot while it serves.

**Recovery point.** A hot backup captures the SQLite raft group. The cache
group is excluded and genuinely derived: a restored cell rebuilds its cache on
demand and starts every rate-limit window fresh. Nothing durable is ever put
there, and that exclusion is the reason.

A backup requested twice within sixty seconds returns the first one. A retry is
not a second snapshot.

**Schedule cold backups.** A stopped cell is a few seconds of downtime for a
single-container deployment and it is the mode with the fewest moving parts.

### Restoring

```bash
node scripts/ops/restore.mjs --from /secure/backups/enrahitu-backup-....tar.gz
```

Every checksum in the manifest is verified against the extracted members
**before** anything on the volume is modified. A tampered or truncated archive
is refused with the volume exactly as it was, because a restore that
half-succeeded leaves behind a state nothing has a name for.

Each store has its own variable, and each reaches only its own hiqlite node:

- `ENRAHITU_RESTORE_RAUTHY` restores the identity store
- `ENRAHITU_RESTORE_APP` restores the app's resource store

Set one, start the container, and leave the variable set. The decision is
recorded on the volume the first time it is honoured, so a restart does not
re-apply it. This is deliberate: hiqlite's own mechanism re-applies on every
boot and its documentation tells you to unset the variable afterwards, which
means a crash loop silently discards everything written since. Here the restore
happens once, and pointing the variable at a *different* archive is a new
restore that is honoured.

Do not set `HQL_BACKUP_RESTORE` yourself. It is hiqlite's own name, this
container runs two hiqlite nodes, and one value naming one file would be read
by both. The entrypoint scrubs it and says so in the log.

---

## 7. Upgrade

```bash
# 1. Take a backup. Always.
docker stop enrahitu
node scripts/ops/backup.mjs --out /secure/backups

# 2. Pull the new image.
docker pull enrahitu:NEW

# 3. What would change?
node scripts/ops/migrate.mjs            # report pending migrations
node scripts/ops/preflight.mjs          # the boot preconditions

# 4. Apply.
node scripts/ops/migrate.mjs --apply

# 5. Start on the new image, same volume.
docker rm enrahitu
docker run -d --name enrahitu -v enrahitu-data:/data ... enrahitu:NEW
```

`migrate` and `backup --online` reach the running app's admin plane, because at
N=1 the app's hiqlite node holds the volume open and the operation has to be
performed by the process that owns it. They authenticate as an operator rather
than as a machine account, so the act lands on the Decision chain naming a
person. Supply the session in `ENRAHITU_OPERATOR_COOKIE`:

```bash
export ENRAHITU_OPERATOR_COOKIE='access_token=...'
```

That is the cookie from a signed-in session holding the `enrahitu_operator`
role. The verb fetches its own CSRF token, exactly as the dashboard does; you
do not assemble that header yourself.

**What is safe to skip:** the explicit `preflight` run, because the entrypoint
runs it on every boot and fails closed. Running it by hand only moves the
verdict earlier, which is worth it before a migration.

**What is not safe to skip:** the backup, and the `migrate` report. Read what
is pending before applying it.

`ENRAHITU_MIGRATE_ON_BOOT=true` folds step 4 into the container start. It is
off by default and should stay off for anything you care about: boot-time
migration ties schema change to process restart, so a crash loop becomes a
migration loop, and the moment a topology runs more than one app container
against one ledger it races. The runner survives that race by construction, but
surviving a race is not a reason to run one.

Your own code lives in `app/` and is the one directory an upgrade never
touches. Everything else is chassis and is replaced wholesale. Run
`npm run upgrade:preflight` to see what an upgrade would discard before it
discards it.

---

## 8. Size it

Measured on 2026-08-06 against the packaged arm64 image at N=1, not estimated.

| | Measured |
|---|---|
| Image | 795 MB |
| Memory, idle after boot | ~210 MiB RSS for the whole container (app + rauthy) |
| Memory, after login traffic | ~290 MiB RSS |
| Volume, freshly provisioned | ~2 MB |
| Volume, after an hour idle | ~9 MB |

**Floors to plan against: 512 MiB of memory and 1 GB of disk.** That leaves
real headroom on both. A 256 MiB limit is too tight: the idle figure above is
two runtimes, a JS heap, and two raft state machines, and it has nowhere to go
during a migration or a backup.

What grows, and what it grows with:

- **`/data/hiqlite` and `/data/rauthy/db`** grow with *write volume*, not with
  data size, because a raft log accumulates entries and compacts into
  snapshots. The idle cell above added ~7 MB in an hour with nobody using it.
  This is the class that surprises people: it is not proportional to how many
  members you have.
- **`/data/ledger`** grows with application data: members, tiers, invoices,
  events, documents.
- **rauthy's store** grows with users and active sessions.
- **The Decision ledger** grows with admitted mutations *and denials*. A
  misconfigured client retrying a rejected write writes a chain entry every
  time.

Backups are roughly the size of the volume; they are compressed but the raft
segments do not compress well.

These are floors for one cell serving one association. Nothing here has been
measured under sustained load, and this section should be re-measured before
anyone plans a large deployment against it.

---

## 9. Troubleshoot

Every entry here is a failure this substrate has actually produced. None are
hypothetical.

### Login completes at the IdP, then the callback returns 502

**Cause:** your reverse proxy could not relay the response. The callback sets
the access and refresh JWTs as cookies in one response, and those headers
exceed nginx's default proxy buffer. The application log shows `rauthyCallback`
completing with a successful `302`, which is what makes this confusing: the app
did its job and the proxy dropped the answer.

**Fix:** raise the buffers. nginx needs `proxy_buffer_size 16k` and
`proxy_buffers 8 16k`; ingress-nginx needs the
`nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"` annotation. Section 2.
The confirming evidence is in the *proxy's* error log, not the app's:
`upstream sent too big header while reading response header`.

### `/api/v1/auth/rauthy/login` returns a bare 500

**Cause:** server-side OIDC discovery failed. The app fetches
`$ENRAHITU_PUBLIC_URL/auth/v1/.well-known/openid-configuration` from inside the
container, so it must be able to resolve and reach its own public origin, and
must trust the certificate that origin presents. Under split-horizon DNS the
name resolves only outside; with a private CA the container does not trust it.

**Fix:** give the container a route to its own public hostname, and trust the
CA (`NODE_EXTRA_CA_CERTS`) if the certificate is not publicly rooted. Confirm
with:

```bash
docker exec enrahitu node -e "fetch('$ENRAHITU_PUBLIC_URL/auth/v1/.well-known/openid-configuration').then(r=>console.log(r.status)).catch(e=>console.log('UNREACHABLE',e.cause?.code))"
```

### `no such table: controller_watermark` or `no such table: resource`, once a second

**Cause:** the control-plane schema was never applied. A freshly provisioned
cell does not create it at boot, so the background controllers fail every pass.

**Fix:** `node scripts/ops/migrate.mjs --apply`. Section 1.

### Login half-works: the form renders, the session never sticks

**Cause:** `ENRAHITU_PUBLIC_URL` disagrees with the origin the browser used.
Behind TLS termination with an `http://` value, rauthy advertises http URLs
that the browser will not follow from an https page.

**Fix:** set `ENRAHITU_PUBLIC_URL` to the exact https origin users type, and
`ENRAHITU_TRUSTED_PROXY_HOPS` to the number of proxies in front. Section 2.

### Login fails in Safari over plain http, instantly, with a 401

**Cause:** rauthy's default `__Host-` session cookie carries `Secure`, and
Safari refuses to store it over http even on localhost. The 401 arrives in
under a millisecond because the session or CSRF cookie is missing, not because
the password was wrong.

**Fix:** it is already handled for a plain-http `ENRAHITU_PUBLIC_URL`: the
entrypoint selects `COOKIE_MODE=danger-insecure` for local trials. If you are
seeing it, the public URL is `https://` while the browser is actually speaking
http. Make the two agree.

### A sub-millisecond 401 on login

**Cause:** session or CSRF cookie missing. Effectively never a bad password: a
real password check takes measurable time.

**Fix:** look at cookies and origins, not credentials. Usually the previous two
entries.

### Container restarts in a loop, logs mention a lock file

**Cause:** hiqlite never released its state-machine lock, because the addon
exposes no shutdown. The message is `LockFile ... exists already - this is not
a clean start!` and it can escalate to a startup panic
(`locked and in use by another process`).

**Fix:** the app clears a lock whose owner is provably gone before opening the
data directory, so this should self-heal. If it does not, the lock belongs to a
live process or to a *different node*, and the log says which. `foreign-node`
means the wrong volume is attached: the volume belongs to a different node than
the one booting. Attach the right one rather than deleting the lock.

Container stop must reach the supervised processes for the clean path to work.
The entrypoint traps `SIGTERM` and `SIGINT` and forwards them. Do not
`docker kill` a healthy cell.

### Permission errors inside first-boot on an old volume

**Cause:** the image runs as the `node` user. A volume created before that
change is owned by root, so provisioning cannot write to it.

**Fix:** `chown -R` the volume to the container's uid. Pre-flight reports a
root-owned volume by name rather than letting it surface as a crash inside
provisioning.

### `RAUTHY_ISSUER` mismatch after a manual configuration

**Cause:** the issuer needs its trailing slash. Without it, discovery and token
validation disagree about who issued the token.

**Fix:** `$PUBLIC_URL/auth/v1/`, with the slash. The entrypoint gets this right;
it bites when someone sets it by hand.

### Refresh fails and users are logged out early

**Cause:** a rauthy refresh token is not usable until 60 seconds before its
access token expires. If the app's session lifetime does not follow rauthy's
`expires_in`, every renewal is refused.

**Fix:** do not override the session TTL independently of the client's token
lifetime.

### `/metrics` returns 401

**Cause:** working as designed. First boot provisions a token, so the packaged
image authenticates by default.

**Fix:** section 4. The token is at `/data/keys/metrics-token`.

### `/hiq/kv` and `/hiq/counter` return 401 to a plain curl

**Cause:** working as designed. Those endpoints need a session carrying the
`enrahitu_operator` role. They are a demo surface and retire once application
code reaches hiqlite directly.

### The boot log warns about a public development encryption key

**Cause:** the volume's `secrets.env` predates app hiqlite encryption keys, so
the node is running on the addon's publicly-known development key and its
backup snapshots are decryptable by anyone.

**Fix:** provisioning is write-once and a key added now could not decrypt what
is already written. Take a backup, start from a fresh volume, and restore into
it.

### A restore appears to be re-applied on every restart

**Cause:** this is the failure the single-shot guard exists to prevent, so it
should not happen here. If you see it, the restore marker on the volume is
being deleted between boots.

**Fix:** leave `/data/restore-applied.json` alone. It is what records which
archive was honoured.

---

## Where to go next

- `docs/ARCHITECTURE.md`: how the substrate is put together, by plane.
- `specs/`: why each decision was made. `specs/001-enrahitu-architecture/spec.md`
  is the thesis; its §5.2 records the disposition of every other spec.
