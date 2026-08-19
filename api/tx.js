const BLOCKSCOUT = "https://base-sepolia.blockscout.com/api/v2";
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const hash = String(req.query?.hash || "").trim();
  if (!HASH_RE.test(hash)) return res.status(400).json({ error: "invalid_transaction_hash" });
  try {
    const response = await fetch(`${BLOCKSCOUT}/transactions/${hash}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return res.status(response.status).json({ error: "transaction_not_found", status: response.status });
    const tx = await response.json();
    return res.status(200).json({
      hash: tx.hash,
      status: tx.status,
      timestamp: tx.timestamp,
      blockNumber: tx.block_number,
      from: tx.from?.hash,
      to: tx.to?.hash,
      method: tx.method,
      fee: tx.fee,
      tokenTransfers: (tx.token_transfers || []).map((item) => ({
        transactionHash: item.transaction_hash,
        from: item.from?.hash,
        to: item.to?.hash,
        token: item.token?.symbol,
        tokenAddress: item.token?.address_hash,
        amount: item.total?.value,
        decimals: item.total?.decimals,
      })),
      explorerUrl: `https://base-sepolia.blockscout.com/tx/${hash}`,
      source: "Blockscout Base Sepolia",
    });
  } catch (error) {
    return res.status(502).json({ error: "transaction_lookup_failed", detail: error instanceof Error ? error.message : String(error) });
  }
}
