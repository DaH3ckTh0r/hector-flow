# tienda-web — convenciones

- JavaScript ESM, Node 20+, sin dependencias externas.
- La web recibe importes en **centavos enteros** desde tienda-api y los muestra siempre con `formatCents` de `src/money.js`. Nunca formatees dinero a mano.
- `src/cart-view.js` es una función pura: recibe la respuesta de la API y devuelve un arreglo de líneas de texto. No hace llamadas de red.
- Los textos visibles para el usuario están en español.
- Tests con `node:test` y `node:assert/strict` en `test/`, un archivo por módulo.
- `npm run build` importa cada módulo de `src/` para detectar errores; `npm test` corre todos los tests.
