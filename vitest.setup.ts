/**
 * Per-worker test isolation: point the process-wide default Ledger at a
 * throwaway temp file BEFORE any test module imports auth/store (which
 * memoizes Ledger.fromEnv() at import time).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ENRAHITU_LEDGER_URL = `file:${join(
  mkdtempSync(join(tmpdir(), "enrahitu-test-ledger-")),
  "test.db",
)}`;
