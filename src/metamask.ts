import { spawn } from "node:child_process";
import type { AgentIntent, CanonicalIntent, MmawSigner } from "./index.js";

export type MetaMaskAgenticSdkLike<TUnsignedOperation, TSignedOperation> = {
  buildUnsignedOperation(intent: CanonicalIntent): Promise<TUnsignedOperation>;
  sign(operation: TUnsignedOperation): Promise<TSignedOperation>;
};

export function createMetaMaskAgenticSdkSigner<
  TUnsignedOperation,
  TSignedOperation,
>(
  sdk: MetaMaskAgenticSdkLike<TUnsignedOperation, TSignedOperation>,
): MmawSigner<TUnsignedOperation, TSignedOperation> {
  return {
    buildUnsignedOperation: (intent) => sdk.buildUnsignedOperation(intent),
    sign: (operation) => sdk.sign(operation),
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

export function createMmCliSigner(
  runner: MmCliRunner = runMmCli,
): MmawSigner<MmCliOperation, { stdout: string; stderr: string }> {
  return {
    async buildUnsignedOperation(intent) {
      return {
        command: "mm",
        args: buildMmArgs(intent),
        intent,
      };
    },
    sign: runner,
  };
}

export function buildMmArgs(intent: CanonicalIntent): string[] {
  switch (intent.actionType) {
    case "transfer":
      return buildTransferArgs(intent);
    case "swap":
      return buildSwapArgs(intent);
    default:
      throw new Error(`UNSUPPORTED_MM_CLI_ACTION:${intent.actionType}`);
  }
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

  return [
    "swap",
    "execute",
    "--from-token",
    intent.assetIn,
    "--to-token",
    intent.assetOut,
    "--amount",
    intent.amountIn,
    "--from-chain",
    String(intent.chainId),
    "--json",
  ];
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

function runMmCli(operation: MmCliOperation): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(operation.command, operation.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`MM_CLI_FAILED:${code}:${stderr}`));
    });
  });
}
