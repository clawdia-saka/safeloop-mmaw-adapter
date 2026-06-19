import type { AbortReason, SimulationResult } from "./index.js";

export type HyperliquidPerpsRiskInput = {
  accountEquityUsd: string;
  existingNotionalUsd?: string;
  newOrderNotionalUsd: string;
  leverage: string;
  maxSlippageUsd?: string;
  estimatedFeesUsd?: string;
  markPrice: string;
  markPriceObservedAt: string;
  oracleSource?: string;
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
  maxOracleAgeMs: number;
  now?: Date;
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
  if (
    isStaleOracle(
      params.input.markPriceObservedAt,
      params.now ?? new Date(),
      params.maxOracleAgeMs,
    )
  ) {
    reasonCodes.push("ORACLE_PRICE_STALE");
  }
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
  input?: Pick<HyperliquidPerpsRiskInput, "markPriceObservedAt" | "oracleSource">,
): Pick<
  SimulationResult,
  | "venueSimulation"
  | "marginRatioBps"
  | "liquidationBufferBps"
  | "oracleObservedAt"
  | "oracleSource"
  | "venueReasonCodes"
> {
  return {
    venueSimulation: "hyperliquid-margin-model",
    marginRatioBps: risk.marginRatioBps,
    liquidationBufferBps: risk.liquidationBufferBps,
    oracleObservedAt: input?.markPriceObservedAt,
    oracleSource: input?.oracleSource,
    venueReasonCodes: risk.reasonCodes,
  };
}

function isStaleOracle(
  observedAt: string,
  now: Date,
  maxOracleAgeMs: number,
): boolean {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return now.getTime() - observedMs > maxOracleAgeMs;
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
