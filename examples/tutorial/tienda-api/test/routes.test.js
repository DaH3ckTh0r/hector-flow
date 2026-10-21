import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/routes.js";

test("POST /cart/quote devuelve subtotal y total", () => {
  const res = handle({ method: "POST", path: "/cart/quote", body: { items: [{ sku: "a", unitPrice: 1000, quantity: 3 }] } });
  assert.deepEqual(res, { status: 200, body: { subtotal: 3000, total: 3000 } });
});

test("POST /cart/quote sin items responde 400", () => {
  const res = handle({ method: "POST", path: "/cart/quote", body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "items_requeridos");
});

test("ruta desconocida responde 404", () => {
  assert.equal(handle({ method: "GET", path: "/nada" }).status, 404);
});
