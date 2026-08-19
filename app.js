import { createWalletClient, custom } from "viem";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const EXPECTED_NETWORK = "eip155:84532";
const EXPECTED_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase();
const EXPECTED_PAY_TO = "0x5A2324aA18613FAD4e44bDf0d6c73Ec1f6D87ff8".toLowerCase();
const EXPECTED_AMOUNT = 10000n;

let walletClient = null;
let walletAddress = null;
let fetchWithPayment = null;
let analysisInFlight = false;

const statusEl = document.querySelector("#status");
const outputEl = document.querySelector("#output");
const connectButton = document.querySelector("#connect");
const analyzeButton = document.querySelector("#analyze");

function setStatus(message) { statusEl.textContent = message; }
function show(value) { outputEl.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function normalizeAddress(value) { return String(value || "").toLowerCase(); }

function decodePaymentResponse(value) {
  if (!value) return null;
  for (const candidate of [value, (() => { try { return atob(value); } catch { return ""; } })()]) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function recordPayment(entry) {
  try {
    const key = "veridex-payment-history";
    const existing = JSON.parse(localStorage.getItem(key) || "[]");
    existing.unshift({ id: crypto.randomUUID(), recordedAt: new Date().toISOString(), ...entry });
    localStorage.setItem(key, JSON.stringify(existing.slice(0, 50)));
  } catch (error) { console.warn("Could not persist payment evidence", error); }
}

function selectPaymentRequirements(_version, accepts) {
  if (!Array.isArray(accepts) || accepts.length === 0) throw new Error("No x402 payment options were advertised by Veridex.");
  const baseSepoliaOption = accepts.find((item) => String(item.network || "") === EXPECTED_NETWORK);
  if (!baseSepoliaOption) throw new Error("Veridex did not advertise the expected Base Sepolia payment option.");
  const asset = normalizeAddress(baseSepoliaOption.asset);
  const payTo = normalizeAddress(baseSepoliaOption.payTo);
  const amount = BigInt(baseSepoliaOption.amount || "0");
  if (asset !== EXPECTED_ASSET) throw new Error(`Refusing payment: unexpected USDC asset ${baseSepoliaOption.asset}`);
  if (payTo !== EXPECTED_PAY_TO) throw new Error(`Refusing payment: unexpected payTo ${baseSepoliaOption.payTo}`);
  if (amount !== EXPECTED_AMOUNT) throw new Error(`Refusing payment: unexpected amount ${amount.toString()}`);
  return baseSepoliaOption;
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("No injected wallet detected. Open this page in Brave with Brave Wallet enabled.");
  setStatus("Connecting Brave Wallet...");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("Wallet returned no accounts.");
  walletAddress = accounts[0];
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x14a34", chainName: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
  }
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId !== "0x14a34") throw new Error(`Wallet is not on Base Sepolia. Current chainId: ${chainId}`);
  walletClient = createWalletClient({ account: walletAddress, chain: baseSepolia, transport: custom(window.ethereum) });
  const signer = { address: walletAddress, signTypedData: async (message) => walletClient.signTypedData({ account: walletAddress, domain: message.domain, types: message.types, primaryType: message.primaryType, message: message.message }) };
  fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: EXPECTED_NETWORK, client: new ExactEvmScheme(signer) }], paymentRequirementsSelector: selectPaymentRequirements });
  connectButton.textContent = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  analyzeButton.disabled = false;
  setStatus(`Connected · Base Sepolia · ${walletAddress}`);
  show({ wallet: walletAddress, network: EXPECTED_NETWORK, chainId: 84532, paymentGuard: { amount: EXPECTED_AMOUNT.toString(), asset: EXPECTED_ASSET, payTo: EXPECTED_PAY_TO } });
}

async function analyze() {
  if (analysisInFlight) return;
  if (!fetchWithPayment) throw new Error("Connect the wallet first.");
  const contractAddress = document.querySelector("#contract").value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) throw new Error("Invalid Ethereum contract address.");
  const startedAt = new Date().toISOString();
  analysisInFlight = true;
  analyzeButton.disabled = true;
  analyzeButton.textContent = "Processing · do not click again";
  try {
    setStatus("Calling Veridex. Waiting for x402 challenge...");
    show("The first response should be 402 Payment Required. The x402 client then selects the guarded Base Sepolia option and asks the wallet to sign the 0.01 USDC authorization. One click creates one paid request.");
    const response = await fetchWithPayment("/api/proxy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: "1", contractAddress }) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    const paymentResponseRaw = response.headers.get("PAYMENT-RESPONSE");
    const paymentResponse = decodePaymentResponse(paymentResponseRaw);
    if (!response.ok) {
      recordPayment({ status: "failed", startedAt, completedAt: new Date().toISOString(), wallet: walletAddress, contractAddress, httpStatus: response.status, error: data?.error || data?.message || String(data), reason: data?.errorReason || data?.invalidReason || "Request did not complete." });
      setStatus(`Veridex request failed · HTTP ${response.status}`);
      show({ error: data, paymentResponse });
      return;
    }
    recordPayment({ status: paymentResponse?.success === false ? "settlement_failed" : "success", startedAt, completedAt: new Date().toISOString(), wallet: walletAddress, contractAddress, httpStatus: response.status, transaction: paymentResponse?.transaction || null, network: paymentResponse?.network || EXPECTED_NETWORK, payer: paymentResponse?.payer || walletAddress, amount: paymentResponse?.amount || EXPECTED_AMOUNT.toString(), asset: paymentResponse?.asset || EXPECTED_ASSET, reason: paymentResponse?.errorReason || "Veridex x402 analysis payment", paymentResponse });
    setStatus(paymentResponse?.transaction ? "SUCCESS · payment settled · transaction captured" : "SUCCESS · analysis received · settlement hash not returned");
    show({ analysis: data, paymentResponse });
  } finally {
    analysisInFlight = false;
    analyzeButton.disabled = !fetchWithPayment;
    analyzeButton.textContent = "Analyze · 0.01 USDC";
  }
}

connectButton.addEventListener("click", async () => { try { await connectWallet(); } catch (error) { console.error(error); setStatus("Wallet connection failed"); show({ error: error.message }); } });
analyzeButton.addEventListener("click", async () => { try { await analyze(); } catch (error) { console.error(error); setStatus("Analysis/payment failed"); show({ error: error.message }); recordPayment({ status: "client_error", wallet: walletAddress, contractAddress: document.querySelector("#contract").value.trim(), error: error.message, reason: "Client-side failure before a successful analysis response." }); } });
show({ ready: true, payment: { network: EXPECTED_NETWORK, amount: EXPECTED_AMOUNT.toString(), asset: EXPECTED_ASSET, payTo: EXPECTED_PAY_TO } });
