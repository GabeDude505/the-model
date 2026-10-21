// engine.js: picks the engine and gives server.js / edge-route.js one small interface.
//
//   ENGINE=aggregator (default)  two stages (read images/PDFs, then map to fields), streamed as NDJSON progress events
//   ENGINE=single                one request, answered as a single JSON object
//
// startJob() validates the request and throws an HttpError BEFORE anything is streamed, so bad requests still get a
// normal HTTP status code. job.run(emit) does the work and calls emit() as stages start and finish.
import { runExtraction, HttpError } from "./extract-core.js";
import { prepareAggregation } from "./aggregator-core.js";

export function startJob(payload, env = process.env) {
  const engine = (env.ENGINE || "aggregator").toLowerCase();
  if (engine === "single") return { streaming: false, run: () => runExtraction(payload, env.ANTHROPIC_API_KEY) };
  const job = prepareAggregation(payload, env);
  return { streaming: true, run: (emit) => job.run(emit) };
}

export function describeError(e) {
  if (e instanceof HttpError) return { status: e.status, error: e.message };
  console.error(e);
  return { status: 500, error: "Unexpected server error." };
}
