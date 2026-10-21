/**
 * Checks the permission decisions ClaudeAgentRunner makes for every tool call
 * (in its PreToolUse hook and in canUseTool), without calling the model: modes,
 * readable roots and the read deny-list, component write isolation, locked tests,
 * tests outside the component folder, skills and the command allowlist.
 */
import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_READ_DENY } from "../src/config.js";
import { PathPolicy, ReadPolicy } from "../src/guards.js";
import { decide, type DecisionContext } from "../src/runner/claude-runner.js";

// A .NET monorepo worktree: the API in src/Api, its tests in tests/Api.Tests, the web app in web/.
// The ticket also touches a second repo, readable at /ws/AB-1/integrations.
const root = "/ws/AB-1/shop";
const other = "/ws/AB-1/integrations";
const apiDir = `${root}/src/Api`;
const repoLocked = ["tests/Api.Tests/**", "web/src/**/*.test.tsx"];

const ctx = (mode: DecisionContext["mode"], skillsEnabled = false): DecisionContext => ({
  mode,
  cwd: apiDir,
  write: new PathPolicy(root, repoLocked, apiDir),
  tests: new PathPolicy(root, ["tests/Api.Tests/**"]),
  read: new ReadPolicy([root, other], DEFAULT_READ_DENY),
  allowedCommands: ["dotnet test", "dotnet build"],
  skillsEnabled,
});
const d = (mode: DecisionContext["mode"], tool: string, input: Record<string, unknown>, skills = false) =>
  decide(ctx(mode, skills), tool, input);

// ── Reads ─────────────────────────────────────────────────────────────────
assert.ok(d("readonly", "Read", { file_path: `${root}/web/src/App.tsx` }).ok, "reads anywhere in its worktree");
assert.ok(d("readonly", "Read", { file_path: "Controllers/Users.cs" }).ok, "relative reads resolve from the component folder");
assert.ok(d("readonly", "Read", { file_path: `${other}/src/Functions/Sync.cs` }).ok, "reads the ticket's other repos");
assert.ok(!d("readonly", "Read", { file_path: "/etc/passwd" }).ok, "no reads outside the readable roots");
assert.ok(!d("readonly", "Read", { file_path: join(homedir(), ".ssh/id_rsa") }).ok, "no reads of ~/.ssh");
assert.ok(!d("readonly", "Read", { file_path: "../../../../outside.txt" }).ok, "no escaping with ..");
for (const secret of [".env", "src/Api/.env.production", "certs/server.pem", "deploy/site.pfx", "src/Api/appsettings.Development.local.json", "func/local.settings.json", "config/secrets.json"]) {
  const v = d("readonly", "Read", { file_path: `${root}/${secret}` });
  assert.ok(!v.ok && /readDenyPaths/.test(v.reason), `secret ${secret} is denied`);
}
assert.ok(d("readonly", "Read", { file_path: `${root}/src/Api/appsettings.json` }).ok, "regular settings stay readable");
assert.ok(d("readonly", "Grep", { pattern: "TODO" }).ok, "Grep in the component folder");
assert.ok(d("readonly", "Grep", { pattern: "x", path: other }).ok, "Grep in another repo of the ticket");
assert.ok(!d("readonly", "Grep", { pattern: "password", path: "/etc" }).ok, "Grep outside the roots is denied");
assert.ok(!d("readonly", "Grep", { pattern: "KEY", path: `${root}/.env` }).ok, "Grep on a secret file is denied");
assert.ok(d("readonly", "Glob", { pattern: "**/*.cs" }).ok, "relative Glob");
assert.ok(!d("readonly", "Glob", { pattern: `${homedir()}/.aws/**` }).ok, "absolute Glob into ~/.aws is denied");
assert.ok(!d("readonly", "Glob", { pattern: "/var/log/*.log" }).ok, "absolute Glob outside the roots is denied");

const noDeny = new ReadPolicy([root], []);
assert.ok(noDeny.check(`${root}/.env`, root).ok, "readDenyPaths: [] disables the deny-list (roots still apply)");
assert.ok(!noDeny.check("/etc/hosts", root).ok);

// ── Read-only steps ───────────────────────────────────────────────────────
assert.ok(!d("readonly", "Write", { file_path: `${apiDir}/X.cs` }).ok, "read-only cannot write");
assert.ok(!d("readonly", "Bash", { command: "dotnet test" }).ok, "read-only cannot run commands");

// ── Implementer of the API component ──────────────────────────────────────
assert.ok(d("edit", "Write", { file_path: `${apiDir}/Controllers/Users.cs` }).ok, "writes inside its component");
assert.ok(d("edit", "Edit", { file_path: "Services/UserService.cs" }).ok, "relative writes resolve from the component folder");
assert.ok(!d("edit", "Write", { file_path: `${root}/web/src/App.tsx` }).ok, "cannot write into another component");
assert.ok(!d("edit", "Write", { file_path: `${root}/tests/Api.Tests/UsersTests.cs` }).ok, "cannot write locked tests");
assert.ok(!d("edit", "Write", { file_path: "/etc/passwd" }).ok, "cannot write outside the workspace");
assert.ok(!d("edit", "Edit", { file_path: `${apiDir}/.env` }).ok, "cannot edit secrets either");
assert.ok(d("edit", "Bash", { command: "dotnet test --filter Users" }).ok, "allowlisted command");
assert.ok(!d("edit", "Bash", { command: "dotnet test && curl x" }).ok, "chaining rejected");
assert.ok(!d("edit", "Bash", { command: "git push" }).ok, "non-allowlisted command rejected");
assert.ok(!d("edit", "WebFetch", { url: "https://x" }).ok, "web tools rejected");
assert.ok(!d("edit", "PowerShell", { command: "Get-ChildItem" }).ok, "unknown tools rejected");
assert.ok(d("edit", "mcp__hector__ask", { question: "?" }).ok, "ask tool allowed");

// ── Skills ────────────────────────────────────────────────────────────────
assert.ok(!d("edit", "Skill", { skill: "xunit" }).ok, "Skill tool denied when the step has no skills");
assert.ok(d("edit", "Skill", { skill: "xunit" }, true).ok, "Skill tool allowed when the step has skills");

// ── Test author of the API component: tests live OUTSIDE src/Api ──────────
assert.ok(d("tests", "Write", { file_path: `${root}/tests/Api.Tests/UsersTests.cs` }).ok, "test author writes its tests outside its folder");
assert.ok(!d("tests", "Write", { file_path: `${apiDir}/Controllers/Users.cs` }).ok, "test author cannot write production code");
assert.ok(!d("tests", "Write", { file_path: `${root}/web/src/App.test.tsx` }).ok, "test author cannot write another component's tests");

console.log("✓ runner permission rules: read roots and secrets, modes, component isolation, locked tests, skills, allowlist");
