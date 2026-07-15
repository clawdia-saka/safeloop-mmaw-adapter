import { spawn } from "node:child_process";
import type { CanonicalIntent, MmawSigner, AbortReason } from "./index.js";
import { sanitizeEvidencePacket } from "./evidence.js";

export type MetaMaskEvidencePacket = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  invariantViolations: string[];
  timestamp: string;
  requestId: string;
};

export class IntentGuardError extends Error {
  constructor(
    public readonly code: AbortReason,
    public readonly reason: string,
    public readonly evidence?: MetaMaskEvidencePacket,
  ) {
    super(reason);
    this.name = "IntentGuardError";
  }
}

function sanitizeMetaMaskEvidence(
  packet: MetaMaskEvidencePacket,
): MetaMaskEvidencePacket {
  const sanitized = sanitizeEvidencePacket(packet);
  if (typeof sanitized !== "string") return sanitized;
  return {
    command: "[REDACTED]",
    exitCode: null,
    stdout: "",
    stderr: sanitized,
    invariantViolations: ["EVIDENCE_MASKING_FAILED"],
    timestamp: new Date(0).toISOString(),
    requestId: "[REDACTED]",
  };
}

/**
 * DM-F1: Pre-Sign Intent Invariant Gate
 * Blocking interceptor to verify intent trajectory before signing.
 */
export function verifyIntentTrajectory(intent: CanonicalIntent): void {
  const violations: string[] = [];

  // Check for wash trade conditions (same token in/out)
  if (intent.assetIn && intent.assetIn === intent.assetOut) {
    violations.push("WASH_TRADE_DETECTED: Same token in/out");
  }

  // Check Loss Budget (Example threshold of 50k USD per instruction)
  const tradeValue = Number(intent.estimatedTradeValueUsd ?? "0");
  if (tradeValue > 50000) {
    violations.push("LOSS_BUDGET_EXCEEDED: Intent exceeds trade value threshold");
  }

  if (violations.length > 0) {
    throw new IntentGuardError(
      violations[0].includes("LOSS") ? "CUMULATIVE_LOSS_LIMIT" : "REVERSE_SWAP_LOOP",
      violations.join("; ")
    );
  }
}

export type MetaMaskAgenticSdkLike<TUnsignedOperation, TSignedOperation> = {
  capabilities?: {
    intentBoundSignatures?: boolean;
    nonBroadcastingSignatures?: boolean;
  };
  buildUnsignedOperation(intent: CanonicalIntent): Promise<TUnsignedOperation>;
  sign(operation: TUnsignedOperation): Promise<TSignedOperation>;
  assertSignedOperationMatchesIntent?: MmawSigner<
    TUnsignedOperation,
    TSignedOperation
  >["assertSignedOperationMatchesIntent"];
};

export function createMetaMaskAgenticSdkSigner<
  TUnsignedOperation,
  TSignedOperation,
>(
  sdk: MetaMaskAgenticSdkLike<TUnsignedOperation, TSignedOperation>,
): MmawSigner<TUnsignedOperation, TSignedOperation> {
  return {
    capabilities: {
      intentBoundSignatures:
        sdk.capabilities?.intentBoundSignatures === true,
      nonBroadcastingSignatures:
        sdk.capabilities?.nonBroadcastingSignatures === true,
    },
    buildUnsignedOperation: (intent) => sdk.buildUnsignedOperation(intent),
    sign: async (operation: TUnsignedOperation) => {
      // DM-F1: Interceptor for SDK
      const intent = (operation as any).intent;
      if (intent) {
        verifyIntentTrajectory(intent);
      }

      try {
        return await sdk.sign(operation);
      } catch (error: any) {
        // DM-F3: Structured Failure Evidence Packet
        const packet = sanitizeMetaMaskEvidence({
          command: "sdk.sign",
          exitCode: null,
          stdout: "",
          stderr: error.message || String(error),
          invariantViolations: [],
          timestamp: new Date().toISOString(),
          requestId: intent?.userGoalId || "unknown",
        });

        // Fire-and-forget audit log (simulated)
        console.error("AUDIT_LOG_PACKET", JSON.stringify(packet));

        const wrapped = new Error("SDK_SIGN_FAILED_REDACTED");
        (wrapped as any).evidence = packet;
        throw wrapped;
      }
    },
    assertSignedOperationMatchesIntent:
      sdk.assertSignedOperationMatchesIntent?.bind(sdk),
  };
}

export type MmCliOperation = {
  command: "mm";
  args: string[];
  intent: CanonicalIntent;
};

export type MmCliRunner = (
  operation: MmCliOperation,
) => Promise<{ stdout: string; stderr: string }>;

export type MmCliRunnerOptions = {
  executable?: string;
  executableArgs?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const DEFAULT_MM_CLI_TIMEOUT_MS = 620_000;
const DEFAULT_MM_CLI_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_MM_CLI_SLIPPAGE_BPS_LENGTH = 24;
const MAX_MM_CLI_SLIPPAGE_BPS_DECIMAL_PLACES = 18;

export function createMmCliRunner(
  options: MmCliRunnerOptions = {},
): MmCliRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MM_CLI_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_MM_CLI_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > DEFAULT_MM_CLI_TIMEOUT_MS
  ) {
    throw new Error("INVALID_MM_CLI_TIMEOUT");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > DEFAULT_MM_CLI_MAX_OUTPUT_BYTES
  ) {
    throw new Error("INVALID_MM_CLI_OUTPUT_LIMIT");
  }

  return (operation) =>
    runMmCli(operation, {
      executable: options.executable ?? operation.command,
      executableArgs: options.executableArgs ?? [],
      timeoutMs,
      maxOutputBytes,
    });
}

export function createMmCliSigner(
  runner: MmCliRunner = createMmCliRunner(),
): MmawSigner<MmCliOperation, { stdout: string; stderr: string }> {
  return {
    capabilities: {
      intentBoundSignatures: false,
      nonBroadcastingSignatures: false,
    },
    async buildUnsignedOperation(intent) {
      return {
        command: "mm",
        args: buildMmArgs(intent),
        intent,
      };
    },
    sign: async (operation) => {
      // DM-F1: Interceptor for CLI
      verifyIntentTrajectory(operation.intent);
      try {
        return await runner(operation);
      } catch (error) {
        const existingEvidence =
          error && typeof error === "object" && "evidence" in error
            ? (error as { evidence?: MetaMaskEvidencePacket }).evidence
            : undefined;
        const packet = existingEvidence ?? sanitizeMetaMaskEvidence({
          command: `${operation.command} ${operation.args.join(" ")}`,
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          invariantViolations: [],
          timestamp: new Date().toISOString(),
          requestId: operation.intent.userGoalId,
        });
        if (!existingEvidence) {
          console.error("AUDIT_LOG_PACKET", JSON.stringify(packet));
        }
        const wrapped = new Error("MM_CLI_FAILED_REDACTED");
        (wrapped as { evidence?: MetaMaskEvidencePacket }).evidence = packet;
        throw wrapped;
      }
    },
  };
}

export function buildMmArgs(intent: CanonicalIntent): string[] {
  switch (intent.actionType) {
    case "transfer":
      return buildTransferArgs(intent);
    case "swap":
      return buildSwapArgs(intent);
    case "perps_open":
      return buildPerpsOpenArgs(intent);
    case "perps_close":
      return buildPerpsCloseArgs(intent);
    case "perps_modify":
      return buildPerpsModifyArgs(intent);
    case "perps_cancel":
      return buildPerpsCancelArgs(intent);
    default:
      throw new Error(`UNSUPPORTED_MM_CLI_ACTION:${intent.actionType}`);
  }
}

export function buildWalletRequestsListArgs(sync = true): string[] {
  return sync
    ? ["wallet", "requests", "list", "--sync", "--json"]
    : ["wallet", "requests", "list", "--no-sync", "--json"];
}

export function buildWalletRequestsWatchArgs(pollingId: string): string[] {
  if (!pollingId) throw new Error("MISSING_POLLING_ID");
  return ["wallet", "requests", "watch", "--polling-id", pollingId, "--json"];
}

export function buildTxHistoryArgs(params: {
  addresses?: `0x${string}`[];
  chains?: Array<number | `eip155:${number}`>;
  type?: "in" | "out" | "self" | string;
  limit?: number;
} = {}): string[] {
  const args = ["tx", "history", "--json"];

  if (params.addresses?.length) {
    args.push("--addresses", params.addresses.join(","));
  }

  if (params.chains?.length) {
    args.push("--chain", params.chains.join(","));
  }

  appendOptional(args, "--type", params.type);

  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 500) {
      throw new Error("INVALID_TX_HISTORY_LIMIT");
    }
    args.push("--limit", String(params.limit));
  }

  return args;
}

function buildTransferArgs(intent: CanonicalIntent): string[] {
  requireFields(intent, ["assetOut", "amountIn", "targetContract"]);

  return [
    "transfer",
    "--token",
    intent.assetOut,
    "--amount",
    intent.amountIn,
    "--to",
    intent.targetContract,
    "--chain-id",
    String(intent.chainId),
    "--json",
  ];
}

function buildSwapArgs(intent: CanonicalIntent): string[] {
  requireFields(intent, ["assetIn", "assetOut", "amountIn"]);

  const args = [
    "swap",
    "execute",
    "--from",
    intent.assetIn,
    "--to",
    intent.assetOut,
    "--amount",
    intent.amountIn,
    "--from-chain",
    String(intent.chainId),
  ];

  if (intent.maxSlippageBps !== undefined) {
    args.push("--slippage", basisPointsToPercent(intent.maxSlippageBps));
  }
  args.push("--json");

  return args;
}

function basisPointsToPercent(value: string): string {
  if (
    value.length > MAX_MM_CLI_SLIPPAGE_BPS_LENGTH ||
    !/^\d+(?:\.\d+)?$/.test(value)
  ) {
    throw new Error("INVALID_MM_CLI_SLIPPAGE_BPS");
  }

  const [rawWhole, fraction = ""] = value.split(".");
  if (fraction.length > MAX_MM_CLI_SLIPPAGE_BPS_DECIMAL_PLACES) {
    throw new Error("INVALID_MM_CLI_SLIPPAGE_BPS");
  }
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  if (
    whole.length > 5 ||
    (whole.length === 5 && whole > "10000") ||
    (whole === "10000" && /[1-9]/.test(fraction))
  ) {
    throw new Error("INVALID_MM_CLI_SLIPPAGE_BPS");
  }

  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length - 2;
  const percent = decimalIndex > 0
    ? `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
    : `0.${"0".repeat(-decimalIndex)}${digits}`;
  const decimalPoint = percent.indexOf(".");
  let end = percent.length;
  while (end > decimalPoint + 1 && percent.charCodeAt(end - 1) === 48) {
    end -= 1;
  }
  if (end === decimalPoint + 1) end = decimalPoint;
  const normalized = percent.slice(0, end);

  return normalized || "0";
}

function buildPerpsOpenArgs(intent: CanonicalIntent): string[] {
  requireFields(intent, ["symbol", "side", "size", "leverage"]);

  const args = [
    "perps",
    "open",
    "--venue",
    intent.venue ?? "hyperliquid",
    "--symbol",
    intent.symbol,
    "--side",
    intent.side,
    "--size",
    intent.size,
    "--leverage",
    intent.leverage,
    "--type",
    intent.orderType ?? "market",
    "--network",
    intent.network ?? "mainnet",
    "--dry-run",
    "--json",
  ];

  appendOptional(args, "--limit-px", intent.limitPx);
  appendOptional(args, "--max-slippage-bps", intent.maxSlippageBps);

  return args;
}

function buildPerpsCloseArgs(intent: CanonicalIntent): string[] {
  const args = [
    "perps",
    "close",
    "--venue",
    intent.venue ?? "hyperliquid",
    "--network",
    intent.network ?? "mainnet",
    "--dry-run",
    "--json",
  ];

  if (intent.closeAll) {
    args.push("--all");
  } else {
    requireFields(intent, ["symbol"]);
    args.push("--symbol", intent.symbol);
    appendOptional(args, "--size", intent.size);
  }

  appendOptional(args, "--max-slippage-bps", intent.maxSlippageBps);

  return args;
}

function buildPerpsModifyArgs(intent: CanonicalIntent): string[] {
  requireFields(intent, ["symbol"]);

  if (!intent.leverage && !intent.takeProfitPx && !intent.stopLossPx) {
    throw new Error("MISSING_PERPS_MODIFY_FIELD");
  }

  const args = [
    "perps",
    "modify",
    "--venue",
    intent.venue ?? "hyperliquid",
    "--symbol",
    intent.symbol,
    "--network",
    intent.network ?? "mainnet",
    "--dry-run",
    "--json",
  ];

  appendOptional(args, "--leverage", intent.leverage);
  appendOptional(args, "--tp", intent.takeProfitPx);
  appendOptional(args, "--sl", intent.stopLossPx);

  return args;
}

function buildPerpsCancelArgs(intent: CanonicalIntent): string[] {
  requireFields(intent, ["orderId"]);

  const args = [
    "perps",
    "cancel",
    "--venue",
    intent.venue ?? "hyperliquid",
    "--order-id",
    intent.orderId,
    "--network",
    intent.network ?? "mainnet",
    "--dry-run",
    "--json",
  ];

  appendOptional(args, "--symbol", intent.symbol);

  return args;
}

function requireFields<T extends keyof CanonicalIntent>(
  intent: CanonicalIntent,
  fields: T[],
): asserts intent is CanonicalIntent & Required<Pick<CanonicalIntent, T>> {
  const missing = fields.filter((field) => !intent[field]);
  if (missing.length > 0) {
    throw new Error(`MISSING_MM_CLI_FIELDS:${missing.join(",")}`);
  }
}

function appendOptional(args: string[], flag: string, value?: string): void {
  if (value) args.push(flag, value);
}

function runMmCli(
  operation: MmCliOperation,
  options: Required<MmCliRunnerOptions>,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const args = [...options.executableArgs, ...operation.args];
    const child = spawn(options.executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (
      outcome:
        | { ok: true; stdout: string; stderr: string }
        | { ok: false; error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (outcome.ok) {
        resolve({ stdout: outcome.stdout, stderr: outcome.stderr });
      } else {
        reject(outcome.error);
      }
    };

    const failClosed = (
      code: "MM_CLI_TIMEOUT" | "MM_CLI_OUTPUT_LIMIT" | `MM_CLI_FAILED:${string}`,
      includeOutput: boolean,
    ) => {
      const packet = sanitizeMetaMaskEvidence({
        command: `${options.executable} ${args.join(" ")}`,
        exitCode: null,
        stdout: includeOutput ? stdout : "",
        stderr: includeOutput ? stderr : "",
        invariantViolations: [code],
        timestamp: new Date().toISOString(),
        requestId: operation.intent.userGoalId,
      });
      const error = new Error(code);
      (error as { evidence?: MetaMaskEvidencePacket }).evidence = packet;
      finish({ ok: false, error });
    };

    const append = (target: "stdout" | "stderr", chunk: string) => {
      if (settled) return;
      const chunkBytes = Buffer.byteLength(chunk);
      if (outputBytes + chunkBytes > options.maxOutputBytes) {
        child.kill("SIGKILL");
        failClosed("MM_CLI_OUTPUT_LIMIT", false);
        return;
      }
      outputBytes += chunkBytes;
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      failClosed("MM_CLI_TIMEOUT", false);
    }, options.timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      append("stderr", chunk);
    });
    child.on("error", () => {
      failClosed("MM_CLI_FAILED:SPAWN", false);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        finish({ ok: true, stdout, stderr });
        return;
      }
      
      // DM-F3: Structured Failure Evidence Packet
      const packet = sanitizeMetaMaskEvidence({
        command: `${options.executable} ${args.join(" ")}`,
        exitCode: code,
        stdout,
        stderr,
        invariantViolations: [],
        timestamp: new Date().toISOString(),
        requestId: operation.intent.userGoalId,
      });

      // Fire-and-forget audit log (simulated)
      console.error("AUDIT_LOG_PACKET", JSON.stringify(packet));

      const error = new Error(`MM_CLI_FAILED:${code ?? "UNKNOWN"}`);
      (error as any).evidence = packet;
      finish({ ok: false, error });
    });
  });
}
