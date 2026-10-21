# tienda-api

API del carrito de la tienda de ejemplo del tutorial de hector-flow.

```bash
npm test        # tests
npm run build   # verifica que todos los módulos cargan
npm start       # http://localhost:3000
```

```bash
curl -s -X POST localhost:3000/cart/quote \
  -H 'content-type: application/json' \
  -d '{"items":[{"sku":"camiseta","unitPrice":1999,"quantity":2}]}'
# {"subtotal":3998,"total":3998}
```
