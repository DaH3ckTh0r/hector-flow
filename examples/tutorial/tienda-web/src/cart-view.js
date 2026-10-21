import { formatCents } from "./money.js";

/**
 * Convierte la respuesta de POST /cart/quote de tienda-api en las líneas de
 * texto que muestra el resumen del carrito.
 *
 * quote: { subtotal: number, total: number }   (importes en centavos)
 * Devuelve: string[]  — una línea por renglón del resumen.
 */
export function renderCart(quote) {
  return [`Subtotal: ${formatCents(quote.subtotal)}`, `Total: ${formatCents(quote.total)}`];
}
