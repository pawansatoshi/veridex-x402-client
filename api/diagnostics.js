const UPSTREAM = "http://13.237.89.59:7044/miner-dispatcher/v1/1001/analyze";
const STRIPPED_HEADERS = new Set([
  "host", "content-length", "connection", "cookie", "authorization",
  "payment-signature", "payment-response", "x-payment",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"
]);

function parseJsonHeader(value) {
  if (!value) return null;
  for (const candidate of [value, (() => { try { return Buffer.from(value, "base64").toString("utf8"); } catch { return ""; } })()]) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const headers = { "content-type": "application/json" };
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (STRIPPED_HEADERS.has(lower)) continue;
      if (lower.startsWith("payment-") || lower.includes("signature")) continue;
      headers[key] = Array.isArray(value) ? value.join(",") : value;
    }
    const started = Date.now();
    const upstreamResponse = await fetch(UPSTREAM, { method: "POST", headers, body: JSON.stringify(body) });
    const elapsedMs = Date.now() - started;
    const rawBody = await upstreamResponse.text();
    const paymentRequiredHeader = upstreamResponse.headers.get("payment-required");
    const paymentRequired = parseJsonHeader(paymentRequiredHeader);
    const forwardedHeaders = {
      "payment-required": paymentRequiredHeader,
      "content-type": upstreamResponse.headers.get("content-type"),
      "x-request-id": upstreamResponse.headers.get("x-request-id")
    };
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-diagnostic-payment-safe", "true");
    return res.status(upstreamResponse.status).json({ diagnostic: true, paymentSent: false, status: upstreamResponse.status, elapsedMs, headers: forwardedHeaders, paymentRequired, upstreamBodyPreview: rawBody.slice(0, 4000) });
  } catch (error) {
    console.error("Veridex diagnostic upstream error", error);
    return res.status(502).json({ diagnostic: true, paymentSent: false, error: "upstream_unavailable", detail: error instanceof Error ? error.message : String(error) });
  }
}
