# 8. Aprendizaje: corregir cada error una sola vez

El segundo pilar del video dice que un error solo debería ocurrir una vez: cuando aparece, no basta con arreglar el resultado (eso es un parche); hay que corregir la **pieza del sistema** que lo produjo. hector-flow tiene dos mecanismos para eso.

| Mecanismo | Fuente | Se guarda cuando | Se usa en |
|---|---|---|---|
| **Pautas** (`guidelines`) | Tus correcciones manuales, vía `distill` | Ejecutas `distill` y el agente identifica una lección | El system prompt del rol responsable, en cada ejecución futura |
| **Lecciones de error** (`errors`) | Las reparaciones automáticas del propio flujo | Una reparación hizo pasar el check | El prompt de `diagnose` cuando la salida contiene el mismo código de error |

Ambos viven en un archivo por repo principal:

```
<workspaces>/_lessons/<nombre-del-repo-principal>.json
```

## Pautas con `distill`

### Cuándo usarlo

Después de revisar el resultado de un ticket y corregir algo a mano en las ramas `hector/<ID>`. Cuanto antes lo hagas, mejor: la siguiente ejecución ya se beneficia.

### Cómo

1. Corrige en el **worktree de integración** de cada repo (las rutas están en `summary.json` → `repos[].worktree`). Puedes commitear o dejar los cambios sin commitear: `distill` ve ambos.
2. Ejecuta:

   ```bash
   npm run flow -- distill --repo <repo principal> --ticket-id <ID>
   ```

### Qué hace

1. Busca la ejecución **más reciente** de ese ticket en `_runs/`.
2. En cada repo de esa ejecución, calcula el diff entre su `flowCommit` (el último commit del flujo) y el estado actual del worktree.
3. Si no hay diferencias, termina: `No human changes after the flow's last commit: nothing to learn.`
4. Si las hay, un agente `distill` (solo lectura) recibe el ticket, el **ledger** (qué paso produjo cada commit) y tus cambios, y devuelve lecciones con:
   - `role`: el paso que causó el error (`enrich`, `plan`, `testAuthor`, `coder` o `review`),
   - `guideline`: una instrucción general y reutilizable, no específica del ticket,
   - `evidence`: qué cambiaste que lo demuestra.
5. Agrega las pautas nuevas al archivo de lecciones. Una pauta idéntica (sin distinguir mayúsculas ni espacios) para el mismo rol no se duplica.

Los cambios puramente cosméticos que no enseñan nada deberían ignorarse.

### Cómo se aplican

En cada ejecución, el system prompt de cada rol se compone de sus instrucciones base más sus pautas:

```
<guidelines_from_past_corrections>
Humans had to correct this step before. Follow these guidelines:
- Documenta con un comentario las reglas de negocio no obvias (redondeos, límites), citando el requisito que las exige.
</guidelines_from_past_corrections>
```

Solo el rol indicado recibe la pauta. Una pauta para `coder` no la ve el revisor.

## Lecciones de error

Cuando el bucle de reparación consigue que un check pase, el **último** diagnóstico se guarda como lección validada: `signature` (la firma del error que dio el diagnóstico), `rootCause`, `fix`, `ticketId` y `validatedAt`.

En diagnósticos futuros, el código busca en la salida del fallo códigos con forma de error de compilador (dos a cuatro mayúsculas seguidas de tres a cinco dígitos: `TS2345`, `CS8862`, `CA1062`) y pasa al diagnóstico las lecciones cuya firma contiene alguno de esos códigos, como *"fixes validados que se usaron antes"*. El diagnóstico decide si aplican.

Una lección solo se guarda después de que la verificación pase, nunca a partir de lo que un modelo afirme.

## El archivo de lecciones

Es JSON legible, pensado para que lo revises y edites:

```json
{
  "errors": [
    {
      "signature": "CS8862 in src/Api/Services/CouponService.cs",
      "rootCause": "El constructor primario de la clase derivada no invoca al de la base",
      "fix": "Invocar explícitamente el constructor base con los parámetros del constructor primario",
      "ticketId": "AB-120",
      "validatedAt": "2026-10-18T14:02:11.000Z"
    }
  ],
  "guidelines": [
    {
      "role": "plan",
      "guideline": "Cuando el ticket define textos visibles, cópialos literalmente en la descripción de la tarea.",
      "evidence": "El humano reemplazó 'Invalid coupon' por 'Cupón inválido'",
      "ticketId": "TIENDA-42",
      "addedAt": "2026-10-21T00:45:59.738Z"
    }
  ]
}
```

Puedes:

- **Editar** una pauta para hacerla más clara o más general.
- **Borrar** pautas que ya no apliquen o que se contradigan.
- **Agregar** pautas a mano, con los mismos campos (`role` debe ser un rol válido).

## Buenas prácticas

- **Revisa las pautas cada cierto tiempo.** El video propone una retro semanal: leer las correcciones de la semana y mejorar el flujo. Con el tiempo, una pauta puede convertirse en un cambio permanente en el prompt base (`src/prompts.ts`), en el `CLAUDE.md` del repo o en una skill.
- **Mantén pocas pautas por rol.** Muchas pautas largas compiten por la atención del modelo. Consolida las que digan lo mismo.
- **Corrige la pieza, no el resultado.** Si un error viene de un ticket mal escrito, la corrección es mejorar la plantilla de tickets, no una pauta.
- **Las convenciones del repo van en `CLAUDE.md`**, no en pautas: así también las ve cualquier persona que use Claude Code en ese repo.
