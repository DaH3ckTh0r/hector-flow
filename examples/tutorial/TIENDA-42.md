# TIENDA-42: Cupones de descuento en el carrito

Queremos que los clientes puedan aplicar un cupón al cotizar el carrito. El cálculo vive en
tienda-api y el resumen del carrito en tienda-web lo muestra.

## Diseño técnico (aprobado)

### Cupones disponibles

| Código         | Descuento                                                   |
|----------------|-------------------------------------------------------------|
| `BIENVENIDA10` | 10 % del subtotal, redondeado hacia abajo al centavo         |
| `ENVIO`        | 500 centavos fijos, sin superar el subtotal                  |

El código no distingue mayúsculas de minúsculas (`envio` equivale a `ENVIO`).

### Contrato de `POST /cart/quote` (tienda-api)

Request: `{ "items": Item[], "coupon"?: string }`

- **Sin `coupon`:** la respuesta no cambia: `200 { "subtotal": n, "total": n }`.
- **Con un cupón válido:** `200 { "subtotal": n, "discount": n, "total": n, "coupon": "CODIGO" }`
  - `discount` en centavos, `total = subtotal - discount`, nunca negativo.
  - `coupon` es el código normalizado en mayúsculas.
- **Con un cupón desconocido:** `400 { "error": "cupon_invalido" }`.

### Resumen del carrito (tienda-web)

`renderCart(respuesta)` recibe el body de la respuesta anterior:

- Con descuento: `["Subtotal: $39.98", "Descuento (BIENVENIDA10): -$3.99", "Total: $35.99"]`
- Sin descuento: igual que hoy, `["Subtotal: …", "Total: …"]`
- Con `{ "error": "cupon_invalido" }`: `["Cupón inválido"]`

### Subtareas

1. **api** — Módulo `src/coupons.js` con la tabla de cupones y el cálculo del descuento.
2. **api** — Aceptar `coupon` en `POST /cart/quote` usando el módulo anterior (depende de la 1).
3. **web** — Línea de descuento y mensaje de cupón inválido en `renderCart` (independiente: usa el contrato de arriba).

## Acceptance criteria
- Con el cupón BIENVENIDA10, POST /cart/quote descuenta el 10 % del subtotal, redondeado hacia abajo al centavo
- Con el cupón ENVIO se descuentan 500 centavos y el total nunca es negativo
- Un cupón desconocido responde 400 con { "error": "cupon_invalido" }
- Sin cupón, la respuesta de POST /cart/quote no cambia
- El resumen del carrito muestra "Descuento (CÓDIGO): -$X.XX" entre el subtotal y el total
- El resumen del carrito muestra "Cupón inválido" cuando la API responde cupon_invalido
