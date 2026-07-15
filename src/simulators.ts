import type {
  CanonicalIntent,
  SimulationResult,
  Simulator,
} from "./index.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 64_000;
const DECIMAL = /^\d+(?:\.\d+)?$/;

export type EvmSimulationTransaction = {
  from?: `0x${string}`;
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: `0x${string}`;
  gas?: `0x${string}`;
  gasPrice?: `0x${string}`;
  maxFeePerGas?: `0x${string}`;
  maxPriorityFeePerGas?: `0x${string}`;
  nonce?: `0x${string}`;
};

export type SimulationRiskEvidence = Omit<
  SimulationResult,
  "status" | "reason"
> & {
  preNavUsd: string;
  postNavUsd: string;
  gasUsd: string;
  slippageUsd: string;
  maxLossUsd: string;
  signatureExpiresAt: string;
  oracleMonotonicAgeMs: number;
  clockSkewMs: number;
  timeCalibrationSource: "durable";
  timeCalibrationSyncedAt: string;
  timeCalibrationRoundTripMs: number;
};

export type SimulationRiskEvidenceProvider = (params: {
  operation: EvmSimulationTransaction;
  intent: CanonicalIntent;
  estimatedGas?: `0x${string}`;
  callResult?: `0x${string}`;
  provider: "anvil" | "tenderly";
  /** Aborted when the provider exceeds the simulator's bounded deadline. */
  signal: AbortSignal;
}) => Promise<SimulationRiskEvidence> | SimulationRiskEvidence;

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RpcSimulatorOptions = {
  rpcUrl: string;
  chainId: number;
  riskEvidence: SimulationRiskEvidenceProvider;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxSignatureTtlMs?: number;
  maxTimeCalibrationAgeMs?: number;
  maxTimeCalibrationRoundTripMs?: number;
  maxClockSkewMs?: number;
  now?: () => Date;
  fetch?: FetchLike;
};

export type RpcSimulator = Simulator<EvmSimulationTransaction> & {
  capabilities: {
    nonBroadcasting: true;
    chainIdentityEnforced: true;
    boundedRpc: true;
    durableRiskEvidenceRequired: true;
    provider: "anvil" | "tenderly";
    supportedChainIds: number[];
  };
  probe(): Promise<{ ok: true; chainId: number; checkedAt: string }>;
};

type JsonRpcEnvelope = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: unknown;
};

type NormalizedOptions = Required<
  Pick<
    RpcSimulatorOptions,
    | "rpcUrl"
    | "chainId"
    | "riskEvidence"
    | "timeoutMs"
    | "maxResponseBytes"
    | "maxSignatureTtlMs"
    | "maxTimeCalibrationAgeMs"
    | "maxTimeCalibrationRoundTripMs"
    | "maxClockSkewMs"
    | "now"
    | "fetch"
  >
>;

export function createAnvilSimulator(
  options: RpcSimulatorOptions,
): RpcSimulator {
  const normalized = normalizeOptions(options);
  return createRpcSimulator("anvil", normalized, async (operation, rpc) => {
    const callResult = requireHexResult(
      await rpc(2, "eth_call", [operation, "latest"]),
    );
    const estimatedGas = requireHexQuantity(
      await rpc(3, "eth_estimateGas", [operation]),
    );
    return { callResult, estimatedGas, failed: false };
  });
}

export function createTenderlySimulator(
  options: RpcSimulatorOptions,
): RpcSimulator {
  const normalized = normalizeOptions(options);
  if (new URL(normalized.rpcUrl).protocol !== "https:") {
    throw new Error("SIMULATOR_TENDERLY_HTTPS_REQUIRED");
  }
  return createRpcSimulator("tenderly", normalized, async (operation, rpc) => {
    const result = await rpc(2, "tenderly_simulateTransaction", [
      operation,
      "latest",
    ]);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("SIMULATOR_RPC_INVALID_RESULT");
    }
    const record = result as Record<string, unknown>;
    const transaction =
      record.transaction && typeof record.transaction === "object"
        ? (record.transaction as Record<string, unknown>)
        : undefined;
    if (typeof record.status !== "boolean") {
      throw new Error("SIMULATOR_RPC_INVALID_RESULT");
    }
    if (
      transaction?.status !== undefined &&
      typeof transaction.status !== "boolean"
    ) {
      throw new Error("SIMULATOR_RPC_INVALID_RESULT");
    }
    const estimatedGas = normalizeGasUsed(record.gasUsed);
    const failed = record.status === false || transaction?.status === false;
    return { failed, estimatedGas };
  });
}

function createRpcSimulator(
  provider: "anvil" | "tenderly",
  options: NormalizedOptions,
  runSimulation: (
    operation: EvmSimulationTransaction,
    rpc: (id: number, method: string, params: unknown[]) => Promise<unknown>,
  ) => Promise<{
    callResult?: `0x${string}`;
    estimatedGas?: `0x${string}`;
    failed: boolean;
  }>,
): RpcSimulator {
  const rpc = (id: number, method: string, params: unknown[]) =>
    rpcCall(options, { jsonrpc: "2.0", id, method, params });

  async function probe(): Promise<{
    ok: true;
    chainId: number;
    checkedAt: string;
  }> {
    const result = requireHexResult(await rpc(1, "eth_chainId", []));
    const chainId = parseHexChainId(result);
    if (chainId !== options.chainId) {
      throw new Error("SIMULATOR_CHAIN_MISMATCH");
    }
    return { ok: true, chainId, checkedAt: options.now().toISOString() };
  }

  return {
    capabilities: {
      nonBroadcasting: true,
      chainIdentityEnforced: true,
      boundedRpc: true,
      durableRiskEvidenceRequired: true,
      provider,
      supportedChainIds: [options.chainId],
    },
    probe,
    async simulate(operation, intent) {
      validateOperation(operation);
      if (intent.actionType.startsWith("perps_")) {
        throw new Error("SIMULATOR_NON_EVM_ACTION_UNSUPPORTED");
      }
      if (intent.chainId !== options.chainId) {
        throw new Error("SIMULATOR_CHAIN_MISMATCH");
      }
      const operationSnapshot = { ...operation };
      const intentSnapshot = { ...intent };
      await probe();
      const simulation = await runSimulation({ ...operationSnapshot }, rpc);
      let evidence: SimulationRiskEvidence;
      try {
        evidence = await withTimeout(
          (signal) => options.riskEvidence({
              operation: { ...operationSnapshot },
              intent: { ...intentSnapshot },
              provider,
              signal,
              callResult: simulation.callResult,
              estimatedGas: simulation.estimatedGas,
            }),
          options.timeoutMs,
        );
      } catch {
        throw new Error("SIMULATOR_RISK_EVIDENCE_UNAVAILABLE");
      }
      validateRiskEvidence(evidence, options);
      return {
        ...evidence,
        status: simulation.failed ? "failed" : "passed",
        reason: simulation.failed ? "RPC_SIMULATION_REJECTED" : undefined,
      };
    },
  };
}

function normalizeOptions(options: RpcSimulatorOptions): NormalizedOptions {
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(options.rpcUrl);
  } catch {
    throw new Error("SIMULATOR_RPC_URL_REQUIRED");
  }
  if (rpcUrl.protocol !== "http:" && rpcUrl.protocol !== "https:") {
    throw new Error("SIMULATOR_RPC_URL_REQUIRED");
  }
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    throw new Error("SIMULATOR_CHAIN_ID_REQUIRED");
  }
  if (typeof options.riskEvidence !== "function") {
    throw new Error("SIMULATOR_RISK_EVIDENCE_REQUIRED");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("SIMULATOR_INVALID_TIMEOUT");
  }
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new Error("SIMULATOR_INVALID_RESPONSE_LIMIT");
  }
  return {
    rpcUrl: rpcUrl.toString(),
    chainId: options.chainId,
    riskEvidence: options.riskEvidence,
    timeoutMs,
    maxResponseBytes,
    maxSignatureTtlMs: boundedPositiveInteger(
      options.maxSignatureTtlMs,
      15_000,
      300_000,
      "SIMULATOR_INVALID_SIGNATURE_TTL",
    ),
    maxTimeCalibrationAgeMs: boundedPositiveInteger(
      options.maxTimeCalibrationAgeMs,
      60_000,
      600_000,
      "SIMULATOR_INVALID_CALIBRATION_AGE",
    ),
    maxTimeCalibrationRoundTripMs:
      boundedPositiveInteger(
        options.maxTimeCalibrationRoundTripMs,
        250,
        30_000,
        "SIMULATOR_INVALID_CALIBRATION_ROUND_TRIP",
      ),
    maxClockSkewMs: boundedPositiveInteger(
      options.maxClockSkewMs,
      250,
      5_000,
      "SIMULATOR_INVALID_CLOCK_SKEW",
    ),
    now: options.now ?? (() => new Date()),
    fetch: options.fetch ?? globalThis.fetch,
  };
}

async function rpcCall(
  options: NormalizedOptions,
  envelope: {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params: unknown[];
  },
): Promise<unknown> {
  if (
    envelope.method.startsWith("eth_send") ||
    envelope.method.includes("broadcast") ||
    envelope.method === "eth_signTransaction"
  ) {
    throw new Error("SIMULATOR_BROADCAST_METHOD_FORBIDDEN");
  }
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("SIMULATOR_REQUEST_TOO_LARGE");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("SIMULATOR_RPC_HTTP_FAILED");
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      Number(contentLength) > options.maxResponseBytes
    ) {
      throw new Error("SIMULATOR_RPC_RESPONSE_TOO_LARGE");
    }
    const text = await readBoundedResponse(response, options.maxResponseBytes);
    let parsed: JsonRpcEnvelope;
    try {
      parsed = JSON.parse(text) as JsonRpcEnvelope;
    } catch {
      throw new Error("SIMULATOR_RPC_INVALID_JSON");
    }
    if (
      parsed.jsonrpc !== "2.0" ||
      parsed.id !== envelope.id ||
      parsed.error !== undefined ||
      !("result" in parsed)
    ) {
      throw new Error("SIMULATOR_RPC_REJECTED");
    }
    return parsed.result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("SIMULATOR_RPC_TIMEOUT");
    }
    if (
      error instanceof Error &&
      error.message.startsWith("SIMULATOR_")
    ) {
      throw error;
    }
    throw new Error("SIMULATOR_RPC_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("SIMULATOR_RPC_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function validateOperation(operation: EvmSimulationTransaction): void {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("SIMULATOR_INVALID_OPERATION");
  }
  const address = /^0x[0-9a-fA-F]{40}$/;
  const hex = /^0x(?:[0-9a-fA-F]{2})*$/;
  const quantity = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
  const allowedKeys = new Set([
    "from",
    "to",
    "data",
    "value",
    "gas",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
  ]);
  if (Object.keys(operation).some((key) => !allowedKeys.has(key))) {
    throw new Error("SIMULATOR_INVALID_OPERATION");
  }
  for (const value of Object.values(operation)) {
    if (typeof value !== "string" || value.length > MAX_REQUEST_BYTES) {
      throw new Error("SIMULATOR_INVALID_OPERATION");
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(operation);
  } catch {
    throw new Error("SIMULATOR_INVALID_OPERATION");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("SIMULATOR_REQUEST_TOO_LARGE");
  }
  if (!address.test(operation.to) || (operation.from && !address.test(operation.from))) {
    throw new Error("SIMULATOR_INVALID_OPERATION");
  }
  if (operation.data !== undefined && !hex.test(operation.data)) {
    throw new Error("SIMULATOR_INVALID_OPERATION");
  }
  for (const value of [
    operation.value,
    operation.gas,
    operation.gasPrice,
    operation.maxFeePerGas,
    operation.maxPriorityFeePerGas,
    operation.nonce,
  ]) {
    if (value !== undefined && !quantity.test(value)) {
      throw new Error("SIMULATOR_INVALID_OPERATION");
    }
  }
}

function validateRiskEvidence(
  evidence: SimulationRiskEvidence,
  options: NormalizedOptions,
): void {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("SIMULATOR_RISK_EVIDENCE_REQUIRED");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(evidence);
  } catch {
    throw new Error("SIMULATOR_RISK_EVIDENCE_REQUIRED");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("SIMULATOR_RISK_EVIDENCE_REQUIRED");
  }
  for (const value of [
    evidence.preNavUsd,
    evidence.postNavUsd,
    evidence.gasUsd,
    evidence.slippageUsd,
    evidence.maxLossUsd,
  ]) {
    if (
      typeof value !== "string" ||
      value.length > 64 ||
      !DECIMAL.test(value)
    ) {
      throw new Error("SIMULATOR_FINANCIAL_EVIDENCE_REQUIRED");
    }
  }
  for (const value of [
    evidence.tradeValueUsd,
    evidence.accountExposureUsd,
    evidence.nativeBalanceUsd,
    evidence.estimatedMaxGasUsd,
    evidence.inFlightGasUsd,
    evidence.revertedGasUsd,
    evidence.gasSpentLookbackUsd,
    evidence.filledSize,
    evidence.expectedFillSize,
  ]) {
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 64 || !DECIMAL.test(value))
    ) {
      throw new Error("SIMULATOR_FINANCIAL_EVIDENCE_REQUIRED");
    }
  }
  for (const value of [
    evidence.volatilityBps,
    evidence.validUntilBlock,
    evidence.marginRatioBps,
    evidence.liquidationBufferBps,
    evidence.accountMarginRatioBps,
    evidence.accountLiquidationBufferBps,
    evidence.gasRunwayTransactions,
    evidence.timeCalibrationMaxVolatilityBps,
  ]) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new Error("SIMULATOR_FINANCIAL_EVIDENCE_REQUIRED");
    }
  }
  const observedAt = options.now().getTime();
  const expiresAt = Date.parse(evidence.signatureExpiresAt);
  const calibratedAt = Date.parse(evidence.timeCalibrationSyncedAt);
  if (
    !Number.isFinite(observedAt) ||
    evidence.timeCalibrationSource !== "durable" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= observedAt + options.maxClockSkewMs ||
    expiresAt - observedAt > options.maxSignatureTtlMs ||
    !Number.isFinite(calibratedAt) ||
    calibratedAt > observedAt ||
    observedAt - calibratedAt > options.maxTimeCalibrationAgeMs ||
    !Number.isFinite(evidence.oracleMonotonicAgeMs) ||
    evidence.oracleMonotonicAgeMs < 0 ||
    !Number.isFinite(evidence.clockSkewMs) ||
    Math.abs(evidence.clockSkewMs) > options.maxClockSkewMs ||
    !Number.isFinite(evidence.timeCalibrationRoundTripMs) ||
    evidence.timeCalibrationRoundTripMs < 0 ||
    evidence.timeCalibrationRoundTripMs >
      options.maxTimeCalibrationRoundTripMs
  ) {
    throw new Error("SIMULATOR_TIME_EVIDENCE_REQUIRED");
  }
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("SIMULATOR_RISK_EVIDENCE_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireHexResult(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error("SIMULATOR_RPC_INVALID_RESULT");
  }
  return value as `0x${string}`;
}

function requireHexQuantity(value: unknown): `0x${string}` {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
  ) {
    throw new Error("SIMULATOR_RPC_INVALID_RESULT");
  }
  return value as `0x${string}`;
}

function parseHexChainId(value: `0x${string}`): number {
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("SIMULATOR_RPC_INVALID_CHAIN_ID");
  }
  const chainId = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("SIMULATOR_RPC_INVALID_CHAIN_ID");
  }
  return chainId;
}

function normalizeGasUsed(value: unknown): `0x${string}` | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    return value as `0x${string}`;
  }
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    return `0x${(value as number).toString(16)}`;
  }
  throw new Error("SIMULATOR_RPC_INVALID_RESULT");
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  errorCode: string,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > maximum
  ) {
    throw new Error(errorCode);
  }
  return normalized;
}
