const DEFAULT_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const EXPECTED_NETWORK = "eip155:84532";
const EXPECTED_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase();
const EXPECTED_PAY_TO = "0x5A2324aA18613FAD4e44bDf0d6c73Ec1f6D87ff8".toLowerCase();
const EXPECTED_AMOUNT = "10000";

function parseHeader(value) {
  if (!value) return null;
  const candidates = [value];
  try { candidates.push(Buffer.from(value, "base64").toString("utf8")); } catch {}
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function accepts(paymentRequired) {
  return Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
}

async function fetchOrigin(req) {
  const protocol = req.headers?.["x-forwarded-proto"] || "https";
  const host = req.headers?.host;
  if (!host) throw new Error("missing_host");
  return fetch(`${protocol}://${host}/`, { cache: "no-store" });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    const started = Date.now();
    const page = await fetchOrigin(req);
    const html = await page.text();
    const diagnosticsUrl = `${String(req.headers?.["x-forwarded-proto"] || "https")}://${req.headers.host}/api/diagnostics`;
    const challenge = await fetch(diagnosticsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-veridex-site-scan": "1" },
      body: JSON.stringify({ chain: "1", contractAddress: DEFAULT_CONTRACT }),
      cache: "no-store",
    });
    const diagnosticBody = await challenge.json().catch(() => ({}));
    const paymentRequired = diagnosticBody.paymentRequired || parseHeader(diagnosticBody.headers?.["payment-required"]);
    const option = accepts(paymentRequired).find((item) => String(item.network || "") === EXPECTED_NETWORK);
    const guards = {
      network: !!option,
      asset: String(option?.asset || "").toLowerCase() === EXPECTED_ASSET,
      amount: String(option?.amount || "") === EXPECTED_AMOUNT,
      payTo: String(option?.payTo || "").toLowerCase() === EXPECTED_PAY_TO,
    };
    const requiredHeaders = {
      "content-security-policy": !!page.headers.get("content-security-policy"),
      "strict-transport-security": !!page.headers.get("strict-transport-security"),
      "x-content-type-options": !!page.headers.get("x-content-type-options"),
      "referrer-policy": !!page.headers.get("referrer-policy"),
      "permissions-policy": !!page.headers.get("permissions-policy"),
    };
    const checks = [
      { id: "product_http", ok: page.ok, label: "Product page reachable", detail: `HTTP ${page.status}` },
      { id: "title", ok: /<title>[^<]+<\/title>/i.test(html), label: "Document title present", detail: "HTML title detected" },
      { id: "wallet", ok: html.includes("id=\"connect\""), label: "Wallet control present", detail: "Connect Wallet control detected" },
      { id: "analyze", ok: html.includes("id=\"analyze\""), label: "Paid analyze control present", detail: "Analyze control detected" },
      { id: "ops_link", ok: html.includes("/ops"), label: "Ops console linked", detail: "Product links to /ops" },
      { id: "diagnostic_http", ok: challenge.status === 402, label: "x402 gate returns 402", detail: `Diagnostics HTTP ${challenge.status}` },
      { id: "challenge", ok: accepts(paymentRequired).length > 0, label: "PAYMENT-REQUIRED parseable", detail: `${accepts(paymentRequired).length} payment option(s)` },
      { id: "network", ok: guards.network, label: "Network guard", detail: EXPECTED_NETWORK },
      { id: "asset", ok: guards.asset, label: "USDC asset guard", detail: EXPECTED_ASSET },
      { id: "amount", ok: guards.amount, label: "Amount guard", detail: "10000 micro-USDC" },
      { id: "payTo", ok: guards.payTo, label: "payTo guard", detail: EXPECTED_PAY_TO },
    ];
    const security = Object.entries(requiredHeaders).map(([id, ok]) => ({ id, ok, label: id, detail: ok ? "present" : "missing" }));
    return res.status(200).json({
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      product: { status: page.status, url: `${String(req.headers?.["x-forwarded-proto"] || "https")}://${req.headers.host}/`, title: (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || null },
      checks,
      securityHeaders: security,
      payment: { status: challenge.status, paymentRequired, guards, paymentSent: false },
      suggestions: [
        ...checks.filter((x) => !x.ok).map((x) => ({ severity: x.id === "diagnostic_http" || x.id === "network" || x.id === "asset" || x.id === "amount" || x.id === "payTo" ? "critical" : "high", title: x.label, action: `Investigate ${x.id} before any live payment.` })),
        ...security.filter((x) => !x.ok).map((x) => ({ severity: "medium", title: `Missing ${x.id}`, action: `Add ${x.id} as a production response header.` })),
      ],
    });
  } catch (error) {
    console.error("Veridex site scan error", error);
    return res.status(502).json({ error: "site_scan_failed", detail: error instanceof Error ? error.message : String(error) });
  }
}
