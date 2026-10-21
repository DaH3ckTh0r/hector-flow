/**
 * Lógica del carrito. Todos los importes son enteros en CENTAVOS.
 *
 * Un ítem tiene la forma { sku: string, unitPrice: number, quantity: number }.
 */

/** Valida un ítem y lanza un Error con un mensaje claro si no es válido. */
export function validateItem(item) {
  if (typeof item?.sku !== "string" || item.sku === "") throw new Error("sku inválido");
  if (!Number.isInteger(item.unitPrice) || item.unitPrice < 0) throw new Error(`precio inválido para ${item.sku}`);
  if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error(`cantidad inválida para ${item.sku}`);
}

/** Suma de precio × cantidad de todos los ítems, en centavos. */
export function subtotal(items) {
  items.forEach(validateItem);
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}
