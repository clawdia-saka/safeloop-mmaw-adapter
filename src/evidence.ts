export type EvidencePacket = unknown;

/**
 * DM-F8: Masking Panic Leak
 * Wrap everything in a try-catch to ensure no failure ever leaks raw data.
 */
export function sanitizeEvidencePacket<T extends EvidencePacket>(packet: T): T | string {
  try {
    const seen = new WeakSet<object>();
    const sanitized = sanitizeEvidenceValue(packet, [], seen);
    
    // DM-F9: Final Regex Filter over serialized JSON to catch leaks
    const serialized = JSON.stringify(sanitized);
    const hardened = redactEvidenceString(serialized);
    
    if (packet !== null && typeof packet === "object") {
      return JSON.parse(hardened) as T;
    }
    return sanitized as T;
  } catch (error) {
    return "CONFIDENTIAL_DATA_MASKING_FAILED_REDACTED_ALL";
  }
}

function sanitizeEvidenceValue(value: unknown, keyPath: string[], seen: WeakSet<object>): unknown {
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[REDACTED_CIRCULAR_REFERENCE]";
    }
    seen.add(value);
  }

  const key = keyPath.length > 0 ? keyPath[keyPath.length - 1].toLowerCase() : "";

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
      sanitizeEvidenceValue(entry, [...keyPath, String(index)], seen),
    );
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(obj).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeEvidenceValue(entryValue, [...keyPath, entryKey], seen),
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
    "privatekey",
    "pk",
    "sk",
    "mnemonic",
    "seed"
  ].some((needle) => key.includes(needle));
}

function redactEvidenceString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_RPC_URL]")
    .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_SECRET]")
    .replace(/0x[a-fA-F0-9]{40}/g, (match) => match.slice(0, 6) + "..." + match.slice(-4))
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(
      /\b(?:gho|ghp|sk|pk|xoxb|xoxp)_[A-Za-z0-9_=-]{12,}\b/g,
      "[REDACTED_SECRET]",
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
      "Bearer [REDACTED_SECRET]",
    );
}
