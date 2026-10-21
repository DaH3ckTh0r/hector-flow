# tienda-api — convenciones

- JavaScript ESM, Node 20+, sin dependencias externas.
- Todos los importes son **enteros en centavos**. Nunca uses decimales para dinero.
- `src/routes.js` es un enrutador puro (`handle(request) → { status, body }`); la lógica de negocio vive en módulos aparte (`src/cart.js`) y se importa desde ahí.
- Los errores de la API se devuelven como `{ status: 4xx, body: { error: "codigo_en_snake_case" } }`.
- Tests con `node:test` y `node:assert/strict` en `test/`, un archivo por módulo, nombres de test en español.
- `npm run build` importa cada módulo de `src/` para detectar errores; `npm test` corre todos los tests.
