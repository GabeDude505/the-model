// server.js: dependency-free Node 18+ proxy that keeps ANTHROPIC_API_KEY off the client.
//
//   ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGINS=https://you.github.io node server.js
//
// Then set CONFIG.PROXY_URL in index.svg to  https://your-host/api/extract
// Serve it over HTTPS in production (put it behind Caddy, nginx, Fly, Render, etc.).
import http from "node:http";
import { runExtraction, corsHeaders, HttpError } from "./extract-core.js";

const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 30 * 1024 * 1024;       // matches the API's ~32 MB request ceiling, minus overhead
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
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/api/extract") return send(404, { error: "Not found." });

    // Behind a reverse proxy, trust x-forwarded-for only if you control that proxy.
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (limited(ip)) return send(429, { error: "Too many requests. Wait a minute and try again." });

    const payload = await readJson(req);
    send(200, await runExtraction(payload, process.env.ANTHROPIC_API_KEY));
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    console.error(e);
    send(500, { error: "Unexpected server error." });
  }
}).listen(PORT, () => console.log(`Extraction proxy listening on :${PORT}`));
