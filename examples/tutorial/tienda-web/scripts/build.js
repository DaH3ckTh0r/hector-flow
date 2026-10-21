// "Build" de un proyecto JavaScript sin compilador: importa cada módulo de src/
// para detectar errores de sintaxis e imports rotos. Termina con código 1 si alguno falla.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = join(import.meta.dirname, "..", "src");
let failed = 0;
for (const file of readdirSync(dir, { recursive: true })) {
  if (!String(file).endsWith(".js")) continue;
  try {
    await import(pathToFileURL(join(dir, String(file))).href);
  } catch (err) {
    failed++;
    console.error(`✖ src/${file}: ${err.message}`);
  }
}
if (failed) process.exit(1);
console.log("build ok");
