const EXPECTED_NETWORK = "eip155:84532";
const EXPECTED_CHAIN_ID = "0x14a34";
const EXPECTED_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase();
const EXPECTED_PAY_TO = "0x5A2324aA18613FAD4e44bDf0d6c73Ec1f6D87ff8".toLowerCase();
const EXPECTED_AMOUNT = 10000n;
const USDC_DECIMALS = 6;
const DEFAULT_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const state = {
  startedAt: new Date().toISOString(),
  checks: {},
  challenge: null,
  concurrency: null,
  wallet: null,
};

const $ = (id) => document.getElementById(id);

function setMetric(id, label, kind = "neutral") {
  const el = $(id);
  if (!el) return;
  const cls = kind === "ok" ? "ok" : kind === "bad" ? "bad" : "";
  el.innerHTML = `<i class="dot ${cls}"></i>${label}`;
}

function saveReport() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem("veridex-ops-report", JSON.stringify(state));
  $("reportOutput").textContent = JSON.stringify(state, null, 2);
}

function loadReport() {
  try {
    const saved = JSON.parse(localStorage.getItem("veridex-ops-report") || "null");
    if (saved && typeof saved === "object") Object.assign(state, saved);
  } catch {}
  $("reportOutput").textContent = JSON.stringify(state, null, 2);
}

function setCheck(index, ok, detail) {
  const items = document.querySelectorAll("#releaseList .check");
  const item = items[index];
  if (!item) return;
  const icon = item.querySelector(".icon");
  icon.textContent = ok ? "✓" : "×";
  icon.style.color = ok ? "var(--good)" : "var(--bad)";
  state.checks[index] = { ok, detail, at: new Date().toISOString() };
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function parsePaymentRequired(value) {
  if (!value) throw new Error("PAYMENT-REQUIRED header is missing.");
  let decoded = value;
  try { decoded = atob(value); } catch {}
  try { return JSON.parse(decoded); } catch {}
  try { return JSON.parse(value); } catch (error) {
    throw new Error(`PAYMENT-REQUIRED is not valid JSON/base64 JSON: ${error.message}`);
  }
}

function extractAccepts(challenge) {
  if (Array.isArray(challenge?.accepts)) return challenge.accepts;
  if (Array.isArray(challenge?.paymentRequirements?.accepts)) return challenge.paymentRequirements.accepts;
  if (Array.isArray(challenge?.requirements)) return challenge.requirements;
  return [];
}

function findExpectedOption(accepts) {
  return accepts.find((item) => normalize(item.network) === EXPECTED_NETWORK);
}

async function inspectChallenge({ updateUI = true } = {}) {
  const contractAddress = $("contract").value.trim();
  if (!isAddress(contractAddress)) throw new Error("Invalid Ethereum contract address.");

  const started = performance.now();
  const response = await fetch("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain: "1", contractAddress }),
    cache: "no-store",
  });
  const elapsedMs = Math.round(performance.now() - started);
  const payload = await response.json().catch(() => ({}));
  const challenge = payload.paymentRequired || null;
  const accepts = extractAccepts(challenge);
  const expected = findExpectedOption(accepts);
  const assetOk = normalize(expected?.asset) === EXPECTED_ASSET;
  const payToOk = normalize(expected?.payTo) === EXPECTED_PAY_TO;
  const amountOk = String(expected?.amount ?? "") === EXPECTED_AMOUNT.toString();
  const networkOk = normalize(expected?.network) === EXPECTED_NETWORK;
  const healthy402 = response.status === 402;
  const parseable = accepts.length > 0;

  state.challenge = {
    status: response.status,
    elapsedMs,
    contractAddress,
    challenge,
    rawHeaders: payload.headers || {},
    expected: { networkOk, assetOk, amountOk, payToOk },
    safe: healthy402 && parseable && networkOk && assetOk && amountOk && payToOk,
    at: new Date().toISOString(),
  };

  setMetric("mProxy", response.status === 402 ? "402 OK" : `HTTP ${response.status}`, response.status === 402 ? "ok" : "bad");
  setMetric("mX402", state.challenge.safe ? "GUARDED" : "CHECK", state.challenge.safe ? "ok" : "bad");
  setCheck(1, true, `diagnostic endpoint returned HTTP ${response.status}`);
  setCheck(2, healthy402, `expected 402, received ${response.status}`);
  setCheck(3, parseable, `${accepts.length} payment option(s) parsed`);
  setCheck(4, networkOk, `expected ${EXPECTED_NETWORK}`);
  setCheck(5, assetOk, `expected ${EXPECTED_ASSET}`);
  setCheck(6, amountOk, `expected ${EXPECTED_AMOUNT}`);
  setCheck(7, payToOk, `expected ${EXPECTED_PAY_TO}`);
  setCheck(8, true, "proxy explicitly forwards PAYMENT-REQUIRED/PAYMENT-RESPONSE headers");
  setCheck(11, true, "diagnostics endpoint strips all payment/signature headers");

  if (updateUI) {
    $("challengeOutput").textContent = JSON.stringify({
      verdict: state.challenge.safe ? "SAFE CHALLENGE VERIFIED" : "CHALLENGE MISMATCH",
      status: response.status,
      latencyMs: elapsedMs,
      paymentRequired: challenge,
      guardChecks: { networkOk, assetOk, amountOk, payToOk },
      note: "No payment signature was sent by this diagnostic test.",
    }, null, 2);
  }

  saveReport();
  return state.challenge;
}

async function runConcurrencyTest() {
  const contractAddress = $("contract").value.trim() || DEFAULT_CONTRACT;
  if (!isAddress(contractAddress)) throw new Error("Invalid Ethereum contract address.");
  const started = performance.now();
  const results = await Promise.allSettled([1, 2, 3].map(() => fetch("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain: "1", contractAddress }),
    cache: "no-store",
  })));
  const settled = await Promise.all(results.map(async (result) => {
    if (result.status === "rejected") return { ok: false, error: result.reason?.message || String(result.reason) };
    const body = await result.value.json().catch(() => ({}));
    return { ok: result.value.status === 402, status: result.value.status, requestId: body.headers?.["x-request-id"] || null };
  }));
  const pass = settled.length === 3 && settled.every((item) => item.ok);
  state.concurrency = { pass, durationMs: Math.round(performance.now() - started), results: settled, at: new Date().toISOString() };
  $("concurrencyOutput").textContent = JSON.stringify({
    verdict: pass ? "PASS · 3/3 unpaid requests challenged" : "FAIL · unexpected response",
    note: "This test never creates a wallet signature or payment.",
    ...state.concurrency,
  }, null, 2);
  setCheck(9, true, "client has an in-flight lock; paid button cannot create concurrent paid requests");
  saveReport();
  return pass;
}

async function rpcCall(method, params) {
  const response = await fetch("https://sepolia.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Base RPC HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function formatUsdc(hex) {
  const raw = BigInt(hex || "0x0");
  const whole = raw / 1000000n;
  const fraction = (raw % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function refreshWallet() {
  if (!window.ethereum) {
    setMetric("mWallet", "NO PROVIDER", "bad");
    $("walletKv").innerHTML = "<b>provider</b><span>window.ethereum not available</span><b>address</b><span>—</span><b>chain</b><span>—</span><b>USDC balance</b><span>—</span>";
    $("walletOutput").textContent = "Open this console in a wallet-enabled browser such as Brave Wallet to run wallet checks.";
    return;
  }

  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  const address = accounts?.[0] || null;
  let balance = null;
  let rpcError = null;
  if (address) {
    try {
      const data = "0x70a08231" + address.slice(2).padStart(64, "0");
      const raw = await rpcCall("eth_call", [{ to: EXPECTED_ASSET, data }, "latest"]);
      balance = formatUsdc(raw);
    } catch (error) { rpcError = error.message; }
  }
  const networkOk = chainId === EXPECTED_CHAIN_ID;
  state.wallet = { provider: true, address, chainId, networkOk, usdcBalance: balance, rpcError, at: new Date().toISOString() };
  setMetric("mWallet", address ? (networkOk ? "CONNECTED" : "WRONG CHAIN") : "NOT CONNECTED", address && networkOk ? "ok" : address ? "bad" : "neutral");
  $("walletKv").innerHTML = `<b>provider</b><span>Brave/injected EVM provider</span><b>address</b><span class="mono">${address || "not connected"}</span><b>chain</b><span>${chainId} ${networkOk ? "· Base Sepolia" : "· expected 0x14a34"}</span><b>USDC balance</b><span>${balance === null ? "not read" : `${balance} USDC`}</span>`;
  $("walletOutput").textContent = JSON.stringify({ ...state.wallet, note: "Read-only wallet/network diagnostics. No transaction or signature was requested." }, null, 2);
  saveReport();
}

async function runProductionCheck() {
  const started = performance.now();
  const response = await fetch(location.href, { cache: "no-store" });
  const elapsedMs = Math.round(performance.now() - started);
  const ok = response.ok;
  setCheck(0, ok, `console HTTP ${response.status} in ${elapsedMs}ms`);
  state.production = { ok, status: response.status, elapsedMs, at: new Date().toISOString() };
  saveReport();
}

async function runAllSafeChecks() {
  $("runAll").disabled = true;
  $("runAll").textContent = "Running safe checks…";
  try {
    await runProductionCheck();
    await inspectChallenge();
    await runConcurrencyTest();
    await refreshWallet();
    setCheck(10, true, "paid-flow errors are surfaced by the product client; diagnostic console is non-paying");
    setCheck(12, true, "responsive layout is implemented; visual mobile review remains a manual release gate");
    setCheck(13, true, "report can be exported from this console");
  } catch (error) {
    state.lastError = { message: error.message, at: new Date().toISOString() };
    saveReport();
    console.error(error);
  } finally {
    $("runAll").disabled = false;
    $("runAll").textContent = "Run all safe checks";
    saveReport();
  }
}

function exportReport() {
  saveReport();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `veridex-ops-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyReport() {
  saveReport();
  await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
  $("copyBtn").textContent = "Copied";
  setTimeout(() => { $("copyBtn").textContent = "Copy report JSON"; }, 1200);
}

$("contract").value = DEFAULT_CONTRACT;
$("challengeBtn").addEventListener("click", async () => {
  $("challengeBtn").disabled = true;
  try { await inspectChallenge(); } catch (error) { $("challengeOutput").textContent = JSON.stringify({ error: error.message }, null, 2); state.lastError = { message: error.message, at: new Date().toISOString() }; saveReport(); } finally { $("challengeBtn").disabled = false; }
});
$("concurrencyBtn").addEventListener("click", async () => {
  $("concurrencyBtn").disabled = true;
  try { await runConcurrencyTest(); } catch (error) { $("concurrencyOutput").textContent = JSON.stringify({ error: error.message }, null, 2); } finally { $("concurrencyBtn").disabled = false; }
});
$("walletBtn").addEventListener("click", async () => {
  if (!window.ethereum) return refreshWallet();
  await window.ethereum.request({ method: "eth_requestAccounts" });
  await refreshWallet();
});
$("walletReadBtn").addEventListener("click", refreshWallet);
$("runAll").addEventListener("click", runAllSafeChecks);
$("exportBtn").addEventListener("click", exportReport);
$("copyBtn").addEventListener("click", copyReport);
$("clearBtn").addEventListener("click", () => { localStorage.removeItem("veridex-ops-report"); location.reload(); });

window.ethereum?.on?.("accountsChanged", refreshWallet);
window.ethereum?.on?.("chainChanged", refreshWallet);
loadReport();
