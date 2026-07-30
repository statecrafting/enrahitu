// The native addon (CJS napi-rs module). Default-import then destructure is
// the safest ESM<-CJS interop for napi's generated index.js.
import hiqlite from "@statecrafting/hiqlite-native";

import { logWarn } from "../lib/logger";

import { reclaimStateMachine } from "./lock";

// Clear a state-machine lock whose owner is gone, before the node opens the
// data directory (spec 002, amendment 2026-07-30). hiqlite never releases the
// lock, because the addon exposes no shutdown, so without this the second start
// against any volume panics and the store stays shut until a human deletes a
// file inside a container. The check proves the previous owner is dead before
// removing anything; a lock a live process still holds is left where it is.
const reclaim = reclaimStateMachine();
if (reclaim.action === "cleared") {
  logWarn("hiq: cleared a stale state-machine lock", {
    reason: reclaim.reason,
    previousPid: reclaim.owner?.pid,
    heldSince: reclaim.owner?.since,
  });
} else if (reclaim.action === "kept") {
  logWarn("hiq: state-machine lock left in place; hiqlite will refuse to open it", {
    reason: reclaim.reason,
    ownerPid: reclaim.owner.pid,
    ownerHost: reclaim.owner.host,
  });
} else if (reclaim.action === "failed") {
  logWarn("hiq: could not check the state-machine lock; leaving it to hiqlite", {
    error: reclaim.error,
  });
}

// Start the embedded hiqlite node at service load, not lazily on the first
// request (spike caveat #5: election takes ~2.5s and cold requests reset).
// Endpoints `await ready` so anything arriving during election simply waits.
export const ready: Promise<void> = hiqlite.init();

// Prevent a process-level unhandledRejection if init fails before the first
// request awaits `ready`; the failure still surfaces on every `await ready`.
ready.catch(() => {});

export default hiqlite;
