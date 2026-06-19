import type { AgentIntent, CanonicalIntent } from "./index.js";

export type Hip3Market = {
  venue: "hyperliquid";
  dex?: string;
  symbol: string;
  network?: "mainnet" | "testnet";
};

export function qualifyHip3Symbol(market: Pick<Hip3Market, "dex" | "symbol">): string {
  if (!market.dex) return market.symbol.toUpperCase();
  return `${market.dex.toLowerCase()}:${market.symbol.toLowerCase()}`;
}

export function canonicalizePerpsFields(intent: AgentIntent): Partial<CanonicalIntent> {
  if (!isPerpsAction(intent.actionType)) return {};

  return {
    venue: intent.venue ?? "hyperliquid",
    network: intent.network ?? "mainnet",
    dex: intent.dex?.toLowerCase(),
    symbol: intent.symbol
      ? qualifyHip3Symbol({ dex: intent.dex, symbol: intent.symbol })
      : undefined,
    side: intent.side,
    size: intent.size,
    leverage: intent.leverage,
    orderType: intent.orderType ?? "market",
    limitPx: intent.limitPx,
    takeProfitPx: intent.takeProfitPx,
    stopLossPx: intent.stopLossPx,
    maxSlippageBps: intent.maxSlippageBps,
    orderId: intent.orderId,
    closeAll: intent.closeAll,
  };
}

export function isPerpsAction(actionType: string): boolean {
  return actionType.startsWith("perps_");
}

export function isHip3Action(intent: CanonicalIntent): boolean {
  return isPerpsAction(intent.actionType) && Boolean(intent.dex);
}
