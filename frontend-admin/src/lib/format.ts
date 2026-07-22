/** Small formatting helpers shared across the dashboard pages. */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** Abbreviates a long hash/id for display; the full value stays in title. */
export function abbreviate(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export type Tone = "ok" | "warn" | "error" | "accent" | "muted";

export function statusTone(status: number): Tone {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "ok";
}

export function methodTone(method: string): Tone {
  switch (method.toUpperCase()) {
    case "GET":
      return "accent";
    case "POST":
      return "ok";
    case "PUT":
    case "PATCH":
      return "warn";
    case "DELETE":
      return "error";
    default:
      return "muted";
  }
}

export function accessTone(access: string): Tone {
  switch (access) {
    case "public":
      return "warn";
    case "auth":
      return "accent";
    case "private":
      return "muted";
    default:
      return "muted";
  }
}
