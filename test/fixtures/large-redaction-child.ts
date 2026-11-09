import assert from "node:assert/strict";
import { redactString } from "../../src/redaction.ts";

for (const input of ["PASSWORD".repeat(125_000), "PASSWORD-".repeat(125_000)]) {
  assert.equal(redactString(input, { maxStringLength: 12_000 }), input.slice(0, 12_000) + "... [truncated]");
}
assert.equal(redactString('TOKEN="' + "synthetic ".repeat(100_000) + '"'), "TOKEN=[REDACTED_SECRET]");

// These contain many possible quote starts but no field delimiter. A failed
// regex search from every escaped quote takes quadratic time before any node
// budget can be checked. Keep the string limit disabled to exercise the scanner.
for (const input of [
  JSON.stringify('"'.repeat(500_000)),
  '\\"'.repeat(500_000),
  "Result: " + JSON.stringify({ message: '"'.repeat(500_000) }),
]) {
  assert.equal(redactString(input, { maxStringLength: Infinity }), "[REDACTED_SECRET]");
}

// Punctuation in escaped keys must still normalize to the sensitive field name.
const paddedKey = "p" + '"'.repeat(100_000) + "assword";
assert.equal(redactString(JSON.stringify({ [paddedKey]: "synthetic-canary" }), {
  maxStringLength: Infinity,
}), "[REDACTED_SECRET]");
