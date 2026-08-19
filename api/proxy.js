export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const upstream = "http://13.237.89.59:7044/miner-dispatcher/v1/1001/analyze";

  try {
    const headers = {};

    for (const [key, value] of Object.entries(req.headers || {})) {
      if (!value) continue;

      const lower = key.toLowerCase();
      if (["host", "content-length", "connection"].includes(lower)) continue;

      headers[key] = Array.isArray(value) ? value.join(",") : value;
    }

    headers["content-type"] = "application/json";

    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body ?? {}),
    });

    const forwardHeaders = [
      "payment-required",
      "payment-response",
      "content-type",
      "x-request-id",
    ];

    for (const header of forwardHeaders) {
      const value = upstreamResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    res.status(upstreamResponse.status).send(body);
  } catch (error) {
    console.error("Veridex upstream error", error);
    return res.status(502).json({
      error: "upstream_unavailable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
