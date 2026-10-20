// edge-route.js: Next.js (App Router) version of the same proxy.
// Save as  app/api/extract/route.js  and copy extract-core.js next to it (or import it from lib/).
// Env vars: ANTHROPIC_API_KEY, ALLOWED_ORIGINS, optional MODEL_TEXT / MODEL_VISUAL.
//
// Hosting limits to know about: Vercel caps request bodies at about 4.5 MB on functions,
// which is too small for large scans. For big files, use server.js on a normal Node host,
// or have the page downscale images before sending.
import { runExtraction, corsHeaders, HttpError } from "./extract-core.js";

export const runtime = "edge";

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req) {
  const headers = { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) };
  try {
    const payload = await req.json().catch(() => { throw new HttpError(400, "Body is not valid JSON."); });
    const result = await runExtraction(payload, process.env.ANTHROPIC_API_KEY);
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return new Response(JSON.stringify({ error: status === 500 ? "Unexpected server error." : e.message }), { status, headers });
  }
}
// Add your own rate limiting here (Upstash Ratelimit, Vercel WAF, etc.); the edge runtime has no shared memory.
