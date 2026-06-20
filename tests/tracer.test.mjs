import { formatDebugTrace } from "../src/tracer.ts";
import { sanitizeEvidencePacket } from "../src/evidence.ts";
import assert from "node:assert";
import { test } from "node:test";

test("DM-F8: Circular references are safely handled", () => {
  const circular = {};
  circular.self = circular;
  
  const result = sanitizeEvidencePacket(circular);
  assert.strictEqual(typeof result, "object");
  assert.strictEqual(result.self, "[REDACTED_CIRCULAR_REFERENCE]");
});

test("DM-F9: Nested objects and deep regex masking", () => {
  const deepContext = {
    level1: {
      level2: {
        email: "leak@example.com",
        pk: "0x" + "a".repeat(64),
        wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      }
    }
  };
  
  const result = formatDebugTrace("DUPLICATE_INTENT", { evidence: deepContext });
  
  // Verify masking of deep nested properties
  assert.ok(result.includes("[REDACTED_EMAIL]"), "Should mask email");
  assert.ok(result.includes("[REDACTED_SECRET]"), "Should mask private key");
  assert.ok(result.includes("0x742d...f44e"), "Should mask wallet address with prefix/suffix");
  
  // Negative checks
  assert.ok(!result.includes("leak@example.com"));
  assert.ok(!result.includes("a".repeat(64)));
  assert.ok(!result.includes("0x742d35Cc6634C0532925a3b844Bc454e4438f44e"));
});

test("DM-F8: Masking Panic Leak handles unexpected errors", () => {
  // Creating an object that throws on access
  const evil = {
    get property() {
      throw new Error("Panic!");
    }
  };
  
  const result = sanitizeEvidencePacket(evil);
  assert.strictEqual(result, "CONFIDENTIAL_DATA_MASKING_FAILED_REDACTED_ALL");
});

test("DM-F10: Trace formatting for DM-F7", () => {
  const result = formatDebugTrace("SIGNED_OPERATION_INTENT_MISMATCH");
  assert.ok(result.includes("DM-F7"));
  assert.ok(result.includes("Triggering post-sign cleanup."));
});
