import type { ReactNode } from "react";

import type { Tone } from "../lib/format";

const toneClasses: Record<Tone, string> = {
  ok: "bg-ok/15 text-ok",
  error: "bg-error/15 text-error",
  warn: "bg-warn/15 text-warn",
  accent: "bg-accent-soft text-accent",
  muted: "bg-surface-2 text-muted",
};

export default function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}
