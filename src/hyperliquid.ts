import type { AbortReason, SimulationResult } from "./index.js";

export type HyperliquidPerpsRiskInput = {
  accountEquityUsd: string;
  existingNotionalUsd?: string;
  newOrderNotionalUsd: string;
  leverage: string;
  maxSlippageUsd?: string;
  estimatedFeesUsd?: string;
  markPrice: string;
  liquidationPrice?: string;
};

export type HyperliquidPerpsRiskResult = {
  marginRatioBps: number;
  liquidationBufferBps: number;
  totalNotionalUsd: number;
  estimatedLossUsd: number;
  reasonCodes: AbortReason[];
};

export function simulateHyperliquidPerpsRisk(params: {
  input: HyperliquidPerpsRiskInput;
  minMarginRatioBps: number;
  minLiquidationBufferBps: number;
}): HyperliquidPerpsRiskResult {
  const accountEquityUsd = parsePositive(params.input.accountEquityUsd);
  const existingNotionalUsd = parseMoney(params.input.existingNotionalUsd ?? "0");
  const newOrderNotionalUsd = parsePositive(params.input.newOrderNotionalUsd);
  const leverage = parsePositive(params.input.leverage);
  const markPrice = parsePositive(params.input.markPrice);
  const liquidationPrice = parseMoney(params.input.liquidationPrice ?? "0");
  const estimatedLossUsd =
    parseMoney(params.input.maxSlippageUsd ?? "0") +
    parseMoney(params.input.estimatedFeesUsd ?? "0");

  const totalNotionalUsd = existingNotionalUsd + newOrderNotionalUsd;
  const requiredMarginUsd = totalNotionalUsd / leverage;
  const postEquityUsd = Math.max(accountEquityUsd - estimatedLossUsd, 0);
  const marginRatioBps =
    requiredMarginUsd > 0 ? (postEquityUsd / requiredMarginUsd) * 10_000 : 0;

  const liquidationBufferBps =
    liquidationPrice > 0
      ? (Math.abs(markPrice - liquidationPrice) / markPrice) * 10_000
      : Number.POSITIVE_INFINITY;

  const reasonCodes: AbortReason[] = [];
  if (marginRatioBps < params.minMarginRatioBps) {
    reasonCodes.push("MARGIN_RATIO_LIMIT");
  }
  if (liquidationBufferBps < params.minLiquidationBufferBps) {
    reasonCodes.push("LIQUIDATION_PRICE_TOO_CLOSE");
  }

  return {
    marginRatioBps,
    liquidationBufferBps,
    totalNotionalUsd,
    estimatedLossUsd,
    reasonCodes,
  };
}

export function hyperliquidRiskToSimulation(
  risk: HyperliquidPerpsRiskResult,
): Pick<
  SimulationResult,
  | "venueSimulation"
  | "marginRatioBps"
  | "liquidationBufferBps"
  | "venueReasonCodes"
> {
  return {
    venueSimulation: "hyperliquid-margin-model",
    marginRatioBps: risk.marginRatioBps,
    liquidationBufferBps: risk.liquidationBufferBps,
    venueReasonCodes: risk.reasonCodes,
  };
}

function parsePositive(value: string): number {
  const parsed = parseMoney(value);
  if (parsed <= 0) throw new Error("INVALID_POSITIVE_NUMBER");
  return parsed;
}

function parseMoney(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("INVALID_NUMBER");
  return parsed;
}

