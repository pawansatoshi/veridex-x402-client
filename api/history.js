const BLOCKSCOUT = "https://base-sepolia.blockscout.com/api/v2";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase();
const PAY_TO = "0x5A2324aA18613FAD4e44bDf0d6c73Ec1f6D87ff8".toLowerCase();
const AMOUNT = 10000n;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function asAmount(item) {
  try { return BigInt(item?.total?.value || "0"); } catch { return 0n; }
}

function toUsdc(item) {
  const raw = asAmount(item);
  const decimals = Number(item?.total?.decimals ?? item?.token?.decimals ?? 6);
  const base = 10 ** decimals;
  return Number(raw) / base;
}

async function blockscout(path) {
  const response = await fetch(`${BLOCKSCOUT}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`);
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const address = String(req.query?.address || "").trim();
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: "invalid_address" });

  try {
    let next = null;
    const items = [];
    for (let page = 0; page < 4; page += 1) {
      const params = new URLSearchParams({ type: "ERC-20", filter: "from", token: USDC, items_count: "50" });
      if (next) for (const [key, value] of Object.entries(next)) params.set(key, String(value));
      const data = await blockscout(`/addresses/${address}/token-transfers?${params.toString()}`);
      items.push(...(Array.isArray(data.items) ? data.items : []));
      next = data.next_page_params || null;
      if (!next) break;
    }

    const matches = items
      .filter((item) => String(item?.token?.address_hash || "").toLowerCase() === USDC)
      .filter((item) => String(item?.from?.hash || "").toLowerCase() === address.toLowerCase())
      .filter((item) => String(item?.to?.hash || "").toLowerCase() === PAY_TO)
      .filter((item) => asAmount(item) === AMOUNT)
      .map((item) => ({
        transactionHash: item.transaction_hash,
        timestamp: item.timestamp,
        from: item.from?.hash,
        to: item.to?.hash,
        token: item.token?.symbol || "USDC",
        tokenAddress: item.token?.address_hash,
        amountAtomic: String(item.total?.value || "0"),
        amountUsdc: toUsdc(item),
        method: item.method || "transfer",
        reason: "Matched Veridex x402 payment requirement: 0.01 USDC to the configured payTo address.",
        explorerUrl: `https://base-sepolia.blockscout.com/tx/${item.transaction_hash}`,
        source: "base-sepolia-blockscout",
      }));

    return res.status(200).json({
      network: "eip155:84532",
      wallet: address,
      expected: { token: USDC, payTo: PAY_TO, amountAtomic: String(AMOUNT), amountUsdc: 0.01 },
      count: matches.length,
      items: matches,
      scannedTransfers: items.length,
      source: "Blockscout Base Sepolia",
      sourceUrl: "https://base-sepolia.blockscout.com",
      note: "History is recovered from on-chain USDC Transfer events; it does not depend on browser localStorage.",
    });
  } catch (error) {
    console.error("Veridex history error", error);
    return res.status(502).json({ error: "history_unavailable", detail: error instanceof Error ? error.message : String(error) });
  }
}
