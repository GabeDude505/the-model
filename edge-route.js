// edge-route.js: Next.js (App Router) version of the same proxy.
// Save as  app/api/extract/route.js  and copy extract-core.js, aggregator-core.js and engine.js next to it.
// Env vars: ANTHROPIC_API_KEY, ALLOWED_ORIGINS, optional ENGINE / MODEL_TEXT / MODEL_VISUAL.
//
// Hosting limit to know about: Vercel caps request bodies at about 4.5 MB on functions, which is too small for large
// scans. For those, run server.js on a normal Node host instead.
import { corsHeaders } from "./extract-core.js";
import { startJob, describeError } from "./engine.js";

export const runtime = "nodejs";
export const maxDuration = 300; // seconds; two model passes on big scans can take a while

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req) {
  const cors = corsHeaders(req.headers.get("origin"));
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
  try {
    const payload = await req.json().catch(() => null);
    if (!payload) return json(400, { error: "Body is not valid JSON." });
    const job = startJob(payload); // validation errors surface here, before streaming starts
    if (!job.streaming) return json(200, await job.run());

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (evt) => controller.enqueue(enc.encode(JSON.stringify(evt) + "\n"));
        try { emit({ type: "result", ...(await job.run(emit)) }); }
        catch (e) { emit({ type: "error", ...describeError(e) }); }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...cors } });
  } catch (e) {
    const d = describeError(e);
    return json(d.status, { error: d.error });
  }
}
// Add your own rate limiting here (Upstash Ratelimit, Vercel WAF, etc.); serverless has no shared memory.
