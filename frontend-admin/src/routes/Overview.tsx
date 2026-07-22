import { useState, type ReactNode } from "react";
import { useLoaderData } from "react-router";

import Badge from "../components/Badge";
import type { OverviewResponse } from "../lib/api";
import { abbreviate } from "../lib/format";

// The governed-cell page (spec 023 §3.3): a read-only render of the app
// model, nothing more. Every value here comes straight off OverviewResponse.
export default function Overview() {
  const data = useLoaderData<OverviewResponse>();

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-base font-semibold">Overview</h1>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Identity">
          <Dl>
            <Row label="App">{data.app.name}</Row>
            <Row label="Org">{data.app.org ?? "-"}</Row>
            <Row label="Contract">
              {data.contract.name} v{data.contract.version}
            </Row>
          </Dl>
        </Card>

        <Card title="Model">
          <Dl>
            <Row label="Hash">
              <Copyable value={data.model.hash} />
            </Row>
            <Row label="Gate config hash">
              <Copyable value={data.model.gateConfigHash} />
            </Row>
            <Row label="Revision">{data.model.revision ?? "-"}</Row>
            {data.model.uncommittedChanges ? (
              <Row label="Working tree">
                <Badge tone="warn">uncommitted changes</Badge>
              </Row>
            ) : null}
            <Row label="Producers">
              <ul className="space-y-0.5">
                {data.model.producers.map((p) => (
                  <li key={`${p.tool}@${p.version}`} className="font-mono text-xs">
                    {p.tool}@{p.version} <span className="text-muted">({p.tier})</span>
                  </li>
                ))}
              </ul>
            </Row>
          </Dl>
        </Card>

        <Card title="Counts">
          <Dl>
            <Row label="Services">{data.counts.services}</Row>
            <Row label="Endpoints">{data.counts.endpoints}</Row>
            <Row label="Capabilities">{data.counts.capabilities}</Row>
            <Row label="Agents">{data.counts.agents}</Row>
          </Dl>
        </Card>

        <Card title="Observability">
          <Dl>
            <Row label="Metrics path">
              <code className="font-mono text-xs">{data.observability.metricsPath ?? "-"}</code>
            </Row>
            <Row label="OTel">
              <Badge tone={data.observability.otel ? "ok" : "muted"}>
                {data.observability.otel ? "on" : "off"}
              </Badge>
            </Row>
          </Dl>
        </Card>

        <Card title="Auth">
          <Dl>
            <Row label="IdP">{data.auth.idp ?? "-"}</Row>
            <Row label="Operator role">
              <code className="font-mono text-xs">{data.auth.operatorRole ?? "-"}</code>
            </Row>
          </Dl>
        </Card>

        <Card title="Trust levels">
          {data.trust.levels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {data.trust.levels.map((level) => (
                <Badge key={level} tone="accent">
                  {level}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">none declared</p>
          )}
        </Card>

        <Card title="Gate checks">
          {data.gate.checks.length > 0 ? (
            <ul className="space-y-1">
              {data.gate.checks.map((check) => (
                <li key={check} className="font-mono text-xs">
                  {check}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">none declared</p>
          )}
        </Card>

        <Card title="Decision ledger">
          <Dl>
            <Row label="Records">{data.ledger.records}</Row>
            <Row label="Head">{data.ledger.headId ? <Copyable value={data.ledger.headId} /> : "-"}</Row>
            <Row label="Chain">
              <Badge tone={data.ledger.chainVerified ? "ok" : "error"}>
                {data.ledger.chainVerified ? "verified" : "broken"}
              </Badge>
            </Row>
            {data.ledger.chainError ? (
              <Row label="Chain error">
                <span className="text-error">{data.ledger.chainError}</span>
              </Row>
            ) : null}
          </Dl>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Dl({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 text-sm">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** An abbreviated hash with the full value in title and a copy-on-click. */
function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title={value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // clipboard unavailable here; the title attribute still exposes the full value
        }
      }}
      className="rounded px-1 font-mono text-xs hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {copied ? "copied" : abbreviate(value)}
    </button>
  );
}
