import { subtotal } from "./cart.js";

/**
 * Enrutador puro: recibe { method, path, body } y devuelve { status, body }.
 * No toca la red, así que se prueba sin levantar el servidor.
 */
export function handle(request) {
  if (request.method === "POST" && request.path === "/cart/quote") {
    return quote(request.body ?? {});
  }
  return { status: 404, body: { error: "no_encontrado" } };
}

/** POST /cart/quote — body: { items: Item[] } → { subtotal, total } */
function quote(body) {
  if (!Array.isArray(body.items)) {
    return { status: 400, body: { error: "items_requeridos" } };
  }
  let sub;
  try {
    sub = subtotal(body.items);
  } catch (err) {
    return { status: 400, body: { error: "item_invalido", detail: err.message } };
  }
  return { status: 200, body: { subtotal: sub, total: sub } };
}
