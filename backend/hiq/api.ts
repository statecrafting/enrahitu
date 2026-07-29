/**
 * The hiq service's HTTP surface: one liveness probe, and nothing else.
 *
 * This service used to publish the addon's KV and counter operations over HTTP
 * as a live demonstration that in-process hiqlite worked. Spec 025 found that
 * surface unauthenticated on a container binding 0.0.0.0:8080 and gated it;
 * this change retires it, because the demonstration was never the point and the
 * endpoints taught the wrong lesson.
 *
 * hiqlite is a library, not an API. Application code reaches it in-process
 * through the governed facade (`backend/kernel/hiq.ts`), which adjudicates
 * every operation against the app model before crossing into Rust. Publishing
 * that facade over HTTP added a second, weaker path to the same store and put
 * six endpoints in the model and the catalog that no feature used. Spec 001
 * §4.3 retires it here, in the change that removes its only consumer: the SPA's
 * cache-demo widget.
 *
 * What did NOT retire: `backend/hiq/init.ts` (the module-load `init()` that
 * starts the node before any service handles a request) and the kernel facade.
 * Those are the capability. This file was the demo.
 */
import { api } from "encore.dev/api";

// The governed facade is the only path to the addon (spec 021 §3.5,
// spec 002 §6); it awaits the raft election internally.
import { health as hiqHealth } from "../kernel/hiq";

/**
 * GET /hiq/health : the addon is loaded and hiqlite is up in-process.
 *
 * Public and unauthenticated on purpose: it returns a status string, leaks
 * nothing, and is the probe the image smoke test curls (spec 007). It is
 * deliberately NOT the container's liveness probe, which is `/healthz`
 * (spec 025 §3.3): this one reports a dependency, so wiring a restart policy
 * to it would let a transient hiqlite blip take the container down and, under
 * the die-together supervisor, rauthy with it.
 */
export const health = api(
  { expose: true, method: "GET", path: "/hiq/health" },
  async (): Promise<{ status: string }> => {
    return { status: await hiqHealth() };
  },
);
