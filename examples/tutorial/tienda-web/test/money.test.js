import test from "node:test";
import assert from "node:assert/strict";
import { formatCents } from "../src/money.js";

test("formatCents formatea dólares y centavos", () => {
  assert.equal(formatCents(123456), "$1,234.56");
  assert.equal(formatCents(5), "$0.05");
});

test("formatCents pone el signo delante de los negativos", () => {
  assert.equal(formatCents(-150), "-$1.50");
});
