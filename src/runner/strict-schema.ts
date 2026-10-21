/**
 * OpenAI's strict structured outputs (used by Codex) require every object to
 * list all of its properties as required and to forbid extra ones. Optional
 * properties are expressed as "may be null" instead.
 *
 * strictify() rewrites a JSON Schema into that shape; dropNulls() undoes it on
 * the answer, so the original zod contract still validates it.
 */
export function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictify(v)]));
    } else if (["items", "anyOf", "oneOf", "allOf", "$defs", "definitions", "additionalProperties"].includes(key)) {
      out[key] =
        key === "$defs" || key === "definitions"
          ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strictify(v)]))
          : strictify(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const name of Object.keys(props)) {
      if (!required.has(name)) props[name] = { anyOf: [props[name], { type: "null" }] };
    }
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** Removes object keys whose value is null, at any depth. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, dropNulls(v)]),
  );
}
