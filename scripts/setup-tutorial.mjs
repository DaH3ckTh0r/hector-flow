#!/usr/bin/env node
// Crea los repositorios del tutorial de hector-flow:
//
//   <destino>/
//     tienda-api/     repo git (componente "api", contiene hector-flow.config.json)
//     tienda-web/     repo git (componente "web")
//     TIENDA-42.md    el ticket
//
// Uso: node scripts/setup-tutorial.mjs [destino]     (por defecto ./hector-tutorial)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const templates = resolve(here, "..", "examples", "tutorial");
const target = resolve(process.argv[2] ?? "hector-tutorial");

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`✖ ${target} ya existe y no está vacío. Elige otra carpeta o bórrala primero.`);
  process.exit(1);
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const hasGlobal = (key) => {
  try {
    return git(target, "config", "--get", key) !== "";
  } catch {
    return false;
  }
};

for (const repo of ["tienda-api", "tienda-web"]) {
  const dest = join(target, repo);
  cpSync(join(templates, repo), dest, { recursive: true });
  git(dest, "init", "-q", "-b", "main");
  // Si no tienes identidad de git configurada, se usa una local solo para estos repos.
  if (!hasGlobal("user.email")) git(dest, "config", "user.email", "tutorial@hector-flow.local");
  if (!hasGlobal("user.name")) git(dest, "config", "user.name", "Tutorial hector-flow");
  git(dest, "add", "-A");
  git(dest, "commit", "-q", "-m", "Estado inicial de la tienda");
  console.log(`✔ ${dest}`);
}
cpSync(join(templates, "TIENDA-42.md"), join(target, "TIENDA-42.md"));
console.log(`✔ ${join(target, "TIENDA-42.md")}`);

const flow = resolve(here, "..");
console.log(`
Listo. Siguiente paso (desde ${flow}):

  npm run flow -- check --repo ${join(target, "tienda-api")} --ticket ${join(target, "TIENDA-42.md")}
`);
