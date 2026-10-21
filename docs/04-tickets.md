# 4. Escribir tickets

El ticket es la entrada del flujo, y su calidad es lo que más influye en el resultado. Como dice el video: el sistema no va de una idea suelta a una feature, sino de un **diseño técnico revisado** a una feature.

## Formato

Un ticket es un archivo markdown. hector-flow lo lee **con código**, sin modelo, con estas reglas (`src/ticket.ts`):

```markdown
# AB-123: Título corto del ticket            ← obligatorio: primera línea que empieza con "# "

Texto libre: contexto, diseño técnico,       ← todo el archivo se pasa a los agentes tal cual
contratos, tablas, ejemplos…

## Acceptance criteria                        ← obligatorio (o "## Criterios de aceptación")
- Primer criterio verificable                ← cada viñeta "- " o "* " es un criterio
- [ ] Segundo criterio                       ← las casillas "[ ]" y "[x]" se ignoran
* Tercer criterio

## Otra sección                               ← la lista de criterios termina en el siguiente "## "
```

| Regla | Detalle |
|---|---|
| Título | La **primera** línea que empieza con `# `. |
| ID | Si el título tiene la forma `ID: título` (o `ID - título`, `ID – título`) y el ID es letras/dígitos, guion y número (`AB-123`, `TIENDA-42`, `PROJ2-7`), se usa ese ID. Si no, el ID es el nombre del archivo sin extensión. |
| Criterios | Viñetas bajo `## Acceptance criteria` o `## Criterios de aceptación` (sin distinguir mayúsculas), hasta el siguiente `## `. |
| Mínimo | Al menos un criterio. Sin criterios, el flujo no arranca: se convertirán en tests bloqueados, así que son imprescindibles. |
| Contenido | Los agentes reciben el archivo **completo**, incluidos el contexto y el diseño. |

El ID se usa en los nombres de ramas (`hector/AB-123`), carpetas y commits. Evita reutilizar un ID mientras sus ramas existan; usa `clean` antes de repetir.

## Qué hace que un ticket funcione bien

### 1. Incluye el diseño técnico

Los agentes inventan menos cuanto más concreto es el diseño. Incluye lo que se decidió en la revisión: reglas de negocio con ejemplos numéricos, redondeos, casos borde, textos visibles exactos, códigos de error, nombres de campos.

### 2. Define los contratos entre componentes

Si el ticket toca varias capas, el contrato entre ellas es lo que permite construirlas **en paralelo**. Escríbelo con precisión: ruta, método, request, respuestas (incluidos errores) y ejemplos.

```markdown
### Contrato de `POST /cart/quote`
Request: `{ "items": Item[], "coupon"?: string }`
- Sin `coupon`: `200 { "subtotal": n, "total": n }` (sin cambios)
- Cupón válido: `200 { "subtotal": n, "discount": n, "total": n, "coupon": "CODIGO" }`
- Cupón desconocido: `400 { "error": "cupon_invalido" }`
```

Sin contrato, el planificador tiene que serializar las tareas (la web espera a la API) o, peor, cada lado inventa el suyo y el revisor lo detecta tarde.

### 3. Sugiere las subtareas y sus dependencias

Si tu diseño ya trae la división, el planificador la respeta. Indica qué capa toca cada una y de cuál depende:

```markdown
### Subtareas
1. **api** — Módulo de cupones.
2. **api** — Aceptar `coupon` en el endpoint (depende de la 1).
3. **web** — Línea de descuento en el carrito (independiente: usa el contrato).
```

Evita que dos subtareas independientes editen el mismo archivo: provocaría conflictos de merge.

### 4. Escribe criterios verificables

Cada criterio se convierte en tests bloqueados y en un comando que el código ejecuta. Debe poder comprobarse automáticamente.

| Mal | Bien |
|---|---|
| El descuento funciona correctamente | Con el cupón BIENVENIDA10, POST /cart/quote descuenta el 10 % del subtotal, redondeado hacia abajo al centavo |
| Manejar errores | Un cupón desconocido responde 400 con `{ "error": "cupon_invalido" }` |
| No romper nada | Sin cupón, la respuesta de POST /cart/quote no cambia |
| Buena UX | El resumen del carrito muestra "Cupón inválido" cuando la API responde cupon_invalido |
| Rápido | (no es verificable por un test unitario: déjalo fuera o defínelo con un umbral medible) |

Un criterio por comportamiento. Si un criterio mezcla tres cosas, divídelo.

### 5. Ten en cuenta los tests existentes

Los tests que ya están en `lockedPaths` también quedan bloqueados. Si el ticket cambia un comportamiento que un test existente comprueba, dilo explícitamente ("actualizar el test X para reflejar Y") o diseña el cambio de forma compatible. Si no, la estabilización fallará y el diagnóstico puede atribuir la culpa al test (`needs_human`).

### 6. Deja claro lo que no se sabe

Si algo no está decidido, dilo ("el texto del botón está pendiente de UX; usa 'Aplicar'"). Lo que el ticket no resuelva, los workers lo preguntarán con `ask`; si nadie puede responder con fundamento, decidirán de forma conservadora y lo verás como **supuesto abierto** al final.

## Plantilla

```markdown
# ID-000: Verbo + qué

Contexto en dos o tres frases: qué problema resuelve y para quién.

## Diseño técnico (aprobado)

### Reglas
- …con ejemplos numéricos

### Contrato entre componentes
- Ruta / mensaje / evento, request, respuestas y errores, con ejemplos

### Textos visibles
- "…" exactamente

### Subtareas
1. **componente** — …
2. **componente** — … (depende de la 1)
3. **componente** — … (independiente)

### Fuera de alcance
- …

## Acceptance criteria
- …
- …
```

## Ejemplo completo

`examples/tutorial/TIENDA-42.md` es un ticket real que toca dos repos, con diseño, contrato, subtareas y seis criterios. Lo usa el [tutorial](09-tutorial.md).
