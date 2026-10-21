import test from "node:test";
import assert from "node:assert/strict";
import { subtotal } from "../src/cart.js";

test("subtotal suma precio por cantidad en centavos", () => {
  assert.equal(
    subtotal([
      { sku: "camiseta", unitPrice: 1999, quantity: 2 },
      { sku: "gorra", unitPrice: 1250, quantity: 1 },
    ]),
    5248,
  );
});

test("subtotal de un carrito vacío es 0", () => {
  assert.equal(subtotal([]), 0);
});

test("subtotal rechaza cantidades inválidas", () => {
  assert.throws(() => subtotal([{ sku: "x", unitPrice: 100, quantity: 0 }]), /cantidad inválida/);
});
