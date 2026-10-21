/**
 * Checks the permission decisions ClaudeAgentRunner makes in canUseTool,
 * without calling the model: modes, component write isolation, locked tests,
 * tests that live outside the component folder, and the command allowlist.
 */
import { strict as assert } from "node:assert";
import { ConfigSchema } from "../src/config.js";
import { PathPolicy } from "../src/guards.js";
import { ClaudeAgentRunner } from "../src/runner/claude-runner.js";

const config = ConfigSchema.parse({ testCommand: "x" });
const runner = new ClaudeAgentRunner(config) as unknown as {
  decide(
    mode: "readonly" | "edit" | "tests",
    tool: string,
    input: Record<string, unknown>,
    policy: PathPolicy,
    testPolicy: PathPolicy,
    cwd: string,
    allowed: string[],
  ): { ok: boolean; reason?: string };
};

// A .NET monorepo: the API lives in src/Api, its tests in tests/Api.Tests, the web app in web/.
const root = "/ws/AB-1/shop";
const apiDir = `${root}/src/Api`;
const repoLocked = ["tests/Api.Tests/**", "web/src/**/*.test.tsx"];
const apiTests = ["tests/Api.Tests/**"];
const policy = new PathPolicy(root, repoLocked, apiDir);
const testPolicy = new PathPolicy(root, apiTests);
const allowed = ["dotnet test", "dotnet build"];
const d = (mode: "readonly" | "edit" | "tests", tool: string, input: Record<string, unknown>) =>
  runner.decide(mode, tool, input, policy, testPolicy, apiDir, allowed);

// Read-only steps.
assert.ok(d("readonly", "Read", { file_path: `${root}/web/src/App.tsx` }).ok, "anyone may read");
assert.ok(!d("readonly", "Write", { file_path: `${apiDir}/X.cs` }).ok, "read-only cannot write");
assert.ok(!d("readonly", "Bash", { command: "dotnet test" }).ok, "read-only cannot run commands");

// Implementer of the API component.
assert.ok(d("edit", "Write", { file_path: `${apiDir}/Controllers/Users.cs` }).ok, "writes inside its component");
assert.ok(d("edit", "Edit", { file_path: "Services/UserService.cs" }).ok, "relative paths resolve from the component folder");
assert.ok(!d("edit", "Write", { file_path: `${root}/web/src/App.tsx` }).ok, "cannot write into another component");
assert.ok(!d("edit", "Write", { file_path: `${root}/tests/Api.Tests/UsersTests.cs` }).ok, "cannot write locked tests");
assert.ok(!d("edit", "Write", { file_path: "/etc/passwd" }).ok, "cannot write outside the workspace");
assert.ok(d("edit", "Bash", { command: "dotnet test --filter Users" }).ok, "allowlisted command");
assert.ok(!d("edit", "Bash", { command: "dotnet test && curl x" }).ok, "chaining rejected");
assert.ok(!d("edit", "Bash", { command: "git push" }).ok, "non-allowlisted command rejected");
assert.ok(!d("edit", "WebFetch", { url: "https://x" }).ok, "web tools rejected");
assert.ok(d("edit", "mcp__hector__ask", { question: "?" }).ok, "ask tool allowed");

// Test author of the API component: tests live OUTSIDE src/Api.
assert.ok(d("tests", "Write", { file_path: `${root}/tests/Api.Tests/UsersTests.cs` }).ok, "test author writes its tests outside its folder");
assert.ok(!d("tests", "Write", { file_path: `${apiDir}/Controllers/Users.cs` }).ok, "test author cannot write production code");
assert.ok(!d("tests", "Write", { file_path: `${root}/web/src/App.test.tsx` }).ok, "test author cannot write another component's tests");

console.log("✓ runner permission rules: modes, component isolation, locked tests, out-of-folder tests, allowlist");
