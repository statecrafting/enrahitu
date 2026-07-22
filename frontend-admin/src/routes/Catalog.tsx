import { useState } from "react";
import { useLoaderData } from "react-router";

import ApiCaller from "../components/ApiCaller";
import Badge from "../components/Badge";
import type { CatalogResponse } from "../lib/api";
import { accessTone, methodTone } from "../lib/format";

// The service catalog + API explorer (spec 023 §3.3/§3.4). Left: services;
// right: the selected service's endpoints, each expandable into a caller.
export default function Catalog() {
  const data = useLoaderData<CatalogResponse>();
  const [selected, setSelected] = useState<string | null>(data.services[0]?.name ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const service = data.services.find((s) => s.name === selected) ?? null;
  const capabilityById = new Map(data.capabilities.map((c) => [c.id, c]));

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-border">
        <nav className="flex flex-col gap-0.5 p-2">
          {data.services.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setSelected(s.name)}
              className={`flex items-center justify-between rounded px-3 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                s.name === selected ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <span>{s.name}</span>
              <span className="text-xs">{s.endpoints.length}</span>
            </button>
          ))}
          {data.services.length === 0 ? <p className="px-3 py-2 text-sm text-muted">no services</p> : null}
        </nav>
      </aside>

      <div className="flex-1 overflow-y-auto p-6">
        {service ? (
          <div className="space-y-4">
            <div>
              <h1 className="text-base font-semibold">{service.name}</h1>
              <p className="text-xs text-muted">tier: {service.tier}</p>
              {service.capabilities.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {service.capabilities.map((id) => {
                    const cap = capabilityById.get(id);
                    return (
                      <Badge key={id} tone="accent">
                        {cap ? `${cap.kind}:${cap.resource}` : id}
                      </Badge>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="divide-y divide-border rounded-lg border border-border bg-surface">
              {service.endpoints.map((endpoint) => {
                const key = `${service.name}:${endpoint.name}`;
                const isOpen = expanded.has(key);
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="flex gap-1">
                        {endpoint.methods.map((m) => (
                          <Badge key={m} tone={methodTone(m)}>
                            {m}
                          </Badge>
                        ))}
                      </span>
                      <code className="flex-1 truncate font-mono text-sm">{endpoint.path}</code>
                      <Badge tone={accessTone(endpoint.access)}>{endpoint.access}</Badge>
                      {endpoint.raw ? <Badge tone="muted">raw</Badge> : null}
                    </button>
                    {isOpen ? (
                      <div className="border-t border-border bg-bg px-4 py-3">
                        <p className="mb-3 text-xs text-muted">
                          no schema in the model (types are the contract's opaque escape hatch)
                        </p>
                        <ApiCaller endpoint={endpoint} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {service.endpoints.length === 0 ? <p className="px-4 py-3 text-sm text-muted">no endpoints</p> : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">no services in the model</p>
        )}
      </div>
    </div>
  );
}
