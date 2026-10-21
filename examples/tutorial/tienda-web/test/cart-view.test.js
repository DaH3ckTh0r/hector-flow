import test from "node:test";
import assert from "node:assert/strict";
import { renderCart } from "../src/cart-view.js";

test("renderCart muestra subtotal y total", () => {
  assert.deepEqual(renderCart({ subtotal: 3998, total: 3998 }), ["Subtotal: $39.98", "Total: $39.98"]);
});
