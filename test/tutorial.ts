/**
 * Runs the tutorial exactly as docs/09-tutorial.md describes it, with a scripted
 * runner that applies a reference solution instead of calling the model:
 * setup script → check → run → human correction → distill → clean.
 *
 * If this passes, the tutorial's repos, ticket and config work with the flow.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preflight } from "../src/check.js";
import { cleanTicket } from "../src/clean.js";
import { loadConfig } from "../src/config.js";
import { distillTicket } from "../src/distill.js";
import { readTicket } from "../src/ticket.js";
import { implementTicket } from "../src/workflow.js";
import { byTask, ScriptedRunner, sh, write } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "hector-tutorial-"));
const target = join(root, "hector-tutorial");
execFileSync("node", [resolve(import.meta.dirname, "../scripts/setup-tutorial.mjs"), target], { stdio: "ignore" });
const api = join(target, "tienda-api");
const web = join(target, "tienda-web");
const ticketPath = join(target, "TIENDA-42.md");

// ── Step: check ───────────────────────────────────────────────────────────
const config = await loadConfig(api);
const lines = await preflight({ repo: api, config, ticketPath });
assert.ok(lines.every((l) => l.ok && !l.warn), lines.filter((l) => !l.ok || l.warn).map((l) => `${l.label}\n${l.detail}`).join("\n"));
console.log("✓ setup script creates two clean repos and 'check' passes");

// ── Reference solution, as the agents would write it ──────────────────────
const API_ACCEPTANCE = `import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/routes.js";

const items = [{ sku: "camiseta", unitPrice: 1999, quantity: 2 }]; // subtotal 3998
const quote = (body) => handle({ method: "POST", path: "/cart/quote", body });

test("BIENVENIDA10 descuenta el 10 % redondeado hacia abajo", () => {
  assert.deepEqual(quote({ items, coupon: "BIENVENIDA10" }), {
    status: 200,
    body: { subtotal: 3998, discount: 399, total: 3599, coupon: "BIENVENIDA10" },
  });
});

test("ENVIO descuenta 500 centavos y el total nunca es negativo", () => {
  assert.equal(quote({ items, coupon: "envio" }).body.discount, 500);
  const small = quote({ items: [{ sku: "sticker", unitPrice: 300, quantity: 1 }], coupon: "ENVIO" });
  assert.deepEqual(small.body, { subtotal: 300, discount: 300, total: 0, coupon: "ENVIO" });
});

test("cupón desconocido responde 400 cupon_invalido", () => {
  assert.deepEqual(quote({ items, coupon: "GRATIS" }), { status: 400, body: { error: "cupon_invalido" } });
});

test("sin cupón la respuesta no cambia", () => {
  assert.deepEqual(quote({ items }), { status: 200, body: { subtotal: 3998, total: 3998 } });
});
`;
const WEB_ACCEPTANCE = `import test from "node:test";
import assert from "node:assert/strict";
import { renderCart } from "../src/cart-view.js";

test("muestra la línea de descuento entre subtotal y total", () => {
  assert.deepEqual(renderCart({ subtotal: 3998, discount: 399, total: 3599, coupon: "BIENVENIDA10" }), [
    "Subtotal: $39.98",
    "Descuento (BIENVENIDA10): -$3.99",
    "Total: $35.99",
  ]);
});

test("muestra Cupón inválido cuando la API responde cupon_invalido", () => {
  assert.deepEqual(renderCart({ error: "cupon_invalido" }), ["Cupón inválido"]);
});
`;
const COUPONS = `/** Cupones disponibles: código → función que calcula el descuento en centavos a partir del subtotal. */
const COUPONS = {
  BIENVENIDA10: (subtotal) => Math.floor(subtotal / 10),
  ENVIO: (subtotal) => Math.min(500, subtotal),
};

/**
 * Aplica un cupón a un subtotal en centavos.
 * Devuelve { coupon, discount, total } o null si el código no existe.
 */
export function applyCoupon(subtotal, code) {
  const coupon = String(code).trim().toUpperCase();
  const rule = COUPONS[coupon];
  if (!rule) return null;
  const discount = rule(subtotal);
  return { coupon, discount, total: subtotal - discount };
}
`;
const ROUTES = readFileSync(join(api, "src/routes.js"), "utf8")
  .replace(`import { subtotal } from "./cart.js";`, `import { subtotal } from "./cart.js";\nimport { applyCoupon } from "./coupons.js";`)
  .replace(
    `  return { status: 200, body: { subtotal: sub, total: sub } };`,
    `  if (body.coupon === undefined) return { status: 200, body: { subtotal: sub, total: sub } };
  const applied = applyCoupon(sub, body.coupon);
  if (!applied) return { status: 400, body: { error: "cupon_invalido" } };
  return { status: 200, body: { subtotal: sub, discount: applied.discount, total: applied.total, coupon: applied.coupon } };`,
  );
const CART_VIEW = `import { formatCents } from "./money.js";

/**
 * Convierte la respuesta de POST /cart/quote de tienda-api en las líneas de
 * texto que muestra el resumen del carrito.
 */
export function renderCart(quote) {
  if (quote.error === "cupon_invalido") return ["Cupón inválido"];
  const lines = [\`Subtotal: \${formatCents(quote.subtotal)}\`];
  if (quote.discount > 0) lines.push(\`Descuento (\${quote.coupon}): \${formatCents(-quote.discount)}\`);
  lines.push(\`Total: \${formatCents(quote.total)}\`);
  return lines;
}
`;

const task = (id: string, component: string, dependsOn: string[], description: string, files: string[]) => ({
  id,
  component,
  dependsOn,
  description,
  files,
  acceptanceCriteria: ["ver ticket"],
});

const runner = new ScriptedRunner(
  {
    enrich: [() => ({ summary: "API de carrito y vista web", stack: ["node", "node:test"], relevantFiles: [], conventions: ["centavos enteros"], openQuestions: [] })],
    plan: [
      () => ({
        summary: "cupones en API y web",
        tasks: [
          task("T1", "api", [], "módulo src/coupons.js", ["src/coupons.js"]),
          task("T2", "api", ["T1"], "aceptar coupon en POST /cart/quote", ["src/routes.js"]),
          task("T3", "web", [], "línea de descuento y cupón inválido en renderCart", ["src/cart-view.js"]),
        ],
        risks: ["redondeo del 10 %"],
      }),
    ],
    testAuthor: [
      (cwd) => (
        write(cwd, "test/cupones.test.js", API_ACCEPTANCE),
        {
          testFiles: ["test/cupones.test.js"],
          acceptanceMap: [
            { criterion: "BIENVENIDA10", command: 'node --test --test-name-pattern="BIENVENIDA10"' },
            { criterion: "ENVIO", command: 'node --test --test-name-pattern="ENVIO"' },
            { criterion: "desconocido", command: 'node --test --test-name-pattern="desconocido"' },
            { criterion: "sin cupón", command: 'node --test --test-name-pattern="sin cupón"' },
          ],
        }
      ),
      (cwd) => (
        write(cwd, "test/cart-view-cupon.test.js", WEB_ACCEPTANCE),
        {
          testFiles: ["test/cart-view-cupon.test.js"],
          acceptanceMap: [
            { criterion: "línea de descuento", command: 'node --test --test-name-pattern="descuento"' },
            { criterion: "cupón inválido", command: 'node --test --test-name-pattern="inválido"' },
          ],
        }
      ),
    ],
    "coder:T1": [(cwd) => (write(cwd, "src/coupons.js", COUPONS), { changedFiles: ["src/coupons.js"], notes: "tabla de cupones" })],
    "coder:T2": [(cwd) => (write(cwd, "src/routes.js", ROUTES), { changedFiles: ["src/routes.js"], notes: "coupon opcional" })],
    "coder:T3": [(cwd) => (write(cwd, "src/cart-view.js", CART_VIEW), { changedFiles: ["src/cart-view.js"], notes: "descuento y error" })],
    review: [() => ({ approved: true, issues: [] })],
    qaPlan: [() => ({ markdown: "# Plan de pruebas\n1. Cotizar con BIENVENIDA10…\n" })],
  },
  byTask,
  (key) => (key === "coder:T1" || key === "coder:T3" ? 40 : 0),
);

// ── Step: run ─────────────────────────────────────────────────────────────
const s = await implementTicket({ repo: api, ticket: await readTicket(ticketPath), config, runner });
assert.equal(s.status, "completed", s.reason);
assert.equal(s.maxConcurrentWorkers, 2, "T1 (api) and T3 (web) run in parallel");
assert.deepEqual(s.repos.map((r) => r.name).sort(), ["tienda-api", "tienda-web"]);
for (const r of s.repos) {
  assert.equal(r.branch, "hector/TIENDA-42");
  execFileSync("npm", ["test"], { cwd: r.worktree, stdio: "ignore" }); // throws if red
  assert.equal(sh(r.root, "status", "--porcelain"), "", "your checkout is untouched");
}
const apiWt = s.repos.find((r) => r.name === "tienda-api")!.worktree;
const webWt = s.repos.find((r) => r.name === "tienda-web")!.worktree;
assert.ok(existsSync(join(apiWt, "src/coupons.js")));
assert.match(readFileSync(join(webWt, "src/cart-view.js"), "utf8"), /Cupón inválido/);
assert.equal(apiWt, join(target, ".hector-workspaces/TIENDA-42/tienda-api"), "documented worktree path");
for (const f of ["plan.md", "ledger.json", "acceptance-map.json", "qa-report.json", "test-plan.md"]) {
  assert.ok(existsSync(join(s.runDir, "artifacts", f)), `artifact ${f}`);
}
assert.ok(existsSync(join(s.runDir, "events.jsonl")) && existsSync(join(s.runDir, "summary.json")));
const qa = JSON.parse(readFileSync(join(s.runDir, "artifacts/qa-report.json"), "utf8"));
assert.equal(qa.length, 6);
assert.ok(qa.every((q: { ok: boolean }) => q.ok));
console.log("✓ run: TIENDA-42 completed across tienda-api and tienda-web, 2 workers in parallel, 6/6 acceptance checks");

// ── Step: human correction + distill ──────────────────────────────────────
// As in step 10 of the tutorial: document the rounding rule, keep tests green, commit.
write(
  apiWt,
  "src/coupons.js",
  readFileSync(join(apiWt, "src/coupons.js"), "utf8").replace(
    "export function applyCoupon",
    "/**\n * Los descuentos porcentuales se redondean hacia ABAJO al centavo (Math.floor).\n */\nexport function applyCoupon",
  ),
);
execFileSync("npm", ["test"], { cwd: apiWt, stdio: "ignore" });
sh(apiWt, "commit", "-qam", "docs: documentar la regla de redondeo de cupones");
const res = await distillTicket({
  repo: api,
  ticketId: "TIENDA-42",
  config,
  runner: new ScriptedRunner({
    distill: [
      (_cwd, req) => {
        assert.match(req.prompt, /repository tienda-api/, "distill sees the correction");
        assert.match(req.prompt, /redondean hacia ABAJO/);
        return {
          lessons: [{ role: "coder", guideline: "Documenta las reglas de negocio no obvias.", evidence: "comentario de redondeo" }],
        };
      },
    ],
  }),
});
assert.ok(!("reason" in res) && res.added === 1);
assert.ok(existsSync(join(target, ".hector-workspaces/_lessons/tienda-api.json")));
console.log("✓ distill: the documented correction becomes a guideline for the coder");

// As in step 12: merge locally.
for (const repo of [api, web]) sh(repo, "merge", "--no-ff", "-q", "hector/TIENDA-42", "-m", "TIENDA-42: cupones");
execFileSync("npm", ["test"], { cwd: api, stdio: "ignore" });
execFileSync("npm", ["test"], { cwd: web, stdio: "ignore" });
console.log("✓ merge: both branches merge into main and tests pass there");

// ── Step: clean ───────────────────────────────────────────────────────────
const cleaned = await cleanTicket({ repo: api, ticketId: "TIENDA-42", config });
assert.deepEqual(cleaned.deletedBranches.sort(), ["tienda-api:hector/TIENDA-42", "tienda-web:hector/TIENDA-42"]);
assert.equal(sh(api, "branch", "--list", "hector*"), "");
assert.equal(sh(web, "branch", "--list", "hector*"), "");
assert.ok(existsSync(s.runDir), "logs survive clean");
console.log("✓ clean: branches and worktrees removed in both repos, logs kept");
console.log("\ntutorial checks passed");
