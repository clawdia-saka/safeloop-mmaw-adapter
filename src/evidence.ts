export type EvidencePacket = unknown;

export function sanitizeEvidencePacket<T extends EvidencePacket>(packet: T): T {
  return sanitizeEvidenceValue(packet, []) as T;
}

function sanitizeEvidenceValue(value: unknown, keyPath: string[]): unknown {
  const key = keyPath.at(-1)?.toLowerCase() ?? "";

  if (isSensitiveEvidenceKey(key)) {
    if (key.includes("nonce")) return "[REDACTED_NONCE]";
    if (key.includes("url") || key.includes("rpc") || key.includes("endpoint")) {
      return "[REDACTED_RPC_URL]";
    }
    return "[REDACTED_SECRET]";
  }

  if (typeof value === "string") {
    return redactEvidenceString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeEvidenceValue(entry, [...keyPath, String(index)]),
    );
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeEvidenceValue(entryValue, [...keyPath, entryKey]),
      ]),
    );
  }

  return value;
}

function isSensitiveEvidenceKey(key: string): boolean {
  return [
    "authorization",
    "apikey",
    "api_key",
    "secret",
    "password",
    "token",
    "noncedomain",
    "nonce",
    "rpc",
    "rpcurl",
    "url",
    "endpoint",
  ].some((needle) => key.includes(needle));
}

function redactEvidenceString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_RPC_URL]")
    .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_TX_HASH]")
    .replace(/0x[a-fA-F0-9]{40}/g, "[REDACTED_ADDRESS]")
    .replace(
      /\b(?:gho|ghp|sk|pk|xoxb|xoxp)_[A-Za-z0-9_=-]{12,}\b/g,
      "[REDACTED_SECRET]",
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
      "Bearer [REDACTED_SECRET]",
    );
}
