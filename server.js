// server.js: dependency-free Node 18+ proxy that keeps ANTHROPIC_API_KEY off the client.
//
//   ANTHROPIC_API_KEY=... ALLOWED_ORIGINS=https://you.github.io node server.js
//
// Then set PROXY_URL at the top of index.svg to  https://your-host/api/extract
// Serve it over HTTPS in production (Caddy, nginx, Fly, Render, ...).
//
// The default engine answers with application/x-ndjson, one JSON event per line:
//   {"type":"plan",...}  {"type":"stage","id":"visual","state":"start","label":"..."}  {"type":"stage",...,"state":"done"}
//   ... then {"type":"result","data":{...},"artifacts":{...},"meta":{...}}  or  {"type":"error","status":502,"error":"..."}
// Validation failures and ENGINE=single answer with plain JSON and a normal status code.
import http from "node:http";
import { corsHeaders, HttpError } from "./extract-core.js";
import { startJob, describeError } from "./engine.js";

const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 32) * 1024 * 1024; // the API itself caps requests at about 32 MB
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 10;

// Minimal per-IP rate limit (in memory). Swap for Redis or your platform's limiter if you scale out.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}
setInterval(() => { const cutoff = Date.now() - 60_000; for (const [ip, ts] of hits) if (!ts.some((t) => t > cutoff)) hits.delete(ip); }, 60_000).unref();

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Request is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "Body is not valid JSON.")); }
    });
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  const cors = corsHeaders(req.headers.origin);
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, engine: process.env.ENGINE || "aggregator" });
    if (req.method !== "POST" || req.url !== "/api/extract") return send(404, { error: "Not found." });

    // Behind a reverse proxy, trust x-forwarded-for only if you control that proxy.
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (limited(ip)) return send(429, { error: "Too many requests. Wait a minute and try again." });

    const payload = await readJson(req);
    const job = startJob(payload); // validates; throws an HttpError before any bytes are streamed

    if (!job.streaming) return send(200, await job.run());

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // stop nginx from buffering the stream
      ...cors,
    });
    const emit = (evt) => { if (!res.writableEnded) res.write(JSON.stringify(evt) + "\n"); };
    try { emit({ type: "result", ...(await job.run(emit)) }); }
    catch (e) { emit({ type: "error", ...describeError(e) }); }
    res.end();
  } catch (e) {
    const d = describeError(e);
    send(d.status, { error: d.error });
  }
}).listen(PORT, () => console.log(`Extraction proxy (${process.env.ENGINE || "aggregator"} engine) listening on :${PORT}`));
