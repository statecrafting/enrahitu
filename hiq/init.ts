// The native addon (CJS napi-rs module). Default-import then destructure is
// the safest ESM<-CJS interop for napi's generated index.js.
import hiqlite from "@enrahitu/hiqlite-native";

// Start the embedded hiqlite node at service load, not lazily on the first
// request (spike caveat #5: election takes ~2.5s and cold requests reset).
// Endpoints `await ready` so anything arriving during election simply waits.
export const ready: Promise<void> = hiqlite.init();

// Prevent a process-level unhandledRejection if init fails before the first
// request awaits `ready`; the failure still surfaces on every `await ready`.
ready.catch(() => {});

export default hiqlite;
