/**
 * The sandbox pieces that run without Docker: the egress proxy (real sockets,
 * a local upstream server), the credential scrubbing of flow-run commands, and
 * the sandbox lines of `check`.
 */
import { strict as assert } from "node:assert";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { ConfigSchema } from "../src/config.js";
import { checkSandbox } from "../src/check.js";
import { commandEnv, isSecretName } from "../src/tools/env.js";
import { runShell } from "../src/tools/shell.js";
// @ts-expect-error plain ESM module without types
import { createProxy, isAllowed, parseAllowlist, useAllowlist } from "../sandbox/egress-proxy.mjs";

const listen = (server: { listen: (p: number, h: string, cb: () => void) => void; address: () => unknown }) =>
  new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));

async function rules() {
  const list = parseAllowlist("# models\napi.anthropic.com\n*.githubcopilot.com  # copilot\n.npmjs.org\n\n");
  assert.deepEqual(list, ["api.anthropic.com", "*.githubcopilot.com", ".npmjs.org"]);
  assert.ok(isAllowed("api.anthropic.com", list));
  assert.ok(isAllowed("API.Anthropic.com.", list), "case and trailing dot");
  assert.ok(!isAllowed("evil-api.anthropic.com", list));
  assert.ok(!isAllowed("api.anthropic.com.evil.com", list));
  assert.ok(isAllowed("api.individual.githubcopilot.com", list));
  assert.ok(!isAllowed("githubcopilot.com", list), "*. means subdomains only");
  assert.ok(isAllowed("npmjs.org", list) && isAllowed("registry.npmjs.org", list), ". means domain and subdomains");
  assert.ok(!isAllowed("notnpmjs.org", list));
  console.log("✓ egress allowlist: exact, *.sub and .domain rules; no suffix tricks");
}

/** CONNECT through the proxy; returns the proxy's status line. */
function tunnel(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0]!);
      s.destroy();
    });
    s.on("error", reject);
  });
}

async function proxy() {
  // A local "internet" server, so the allowed path is tested end to end.
  const upstream = createServer((req, res) => res.end(`hello from upstream ${req.url}`));
  const upPort = await listen(upstream);
  useAllowlist(["localhost"]);
  const server = createProxy();
  const port = await listen(server);

  assert.equal(await tunnel(port, "evil.com:443"), "HTTP/1.1 403 Forbidden");
  assert.equal(await tunnel(port, "localhost:22"), "HTTP/1.1 403 Forbidden", "port not allowed");
  // Many refused tunnels in a row, with clients hanging up: the proxy must survive.
  for (let i = 0; i < 20; i++) await tunnel(port, `blocked-${i}.example:443`);

  // Allowed: let the upstream's port through and tunnel a real HTTP request.
  const s = connect(port, "127.0.0.1");
  await new Promise<void>((r) => s.on("connect", () => r()));
  // Port check uses ALLOWED_PORTS (443,80); the local upstream port is not one, so expect 403 here…
  s.write(`CONNECT localhost:${upPort} HTTP/1.1\r\n\r\n`);
  const first = await new Promise<string>((r) => s.once("data", (d) => r(d.toString())));
  assert.match(first, /403 Forbidden/, "unlisted port refused even for an allowed host");
  s.destroy();

  // Allowed host and port: a real request goes through the tunnel.
  useAllowlist(["localhost"], [443, 80, upPort]);
  const t = connect(port, "127.0.0.1");
  await new Promise<void>((r) => t.on("connect", () => r()));
  t.write(`CONNECT localhost:${upPort} HTTP/1.1\r\n\r\n`);
  assert.match(await new Promise<string>((r) => t.once("data", (d) => r(d.toString()))), /200 Connection Established/);
  t.write(`GET /through-the-tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  let body = "";
  await new Promise<void>((r) => (t.on("data", (d) => (body += d)), t.on("close", () => r())));
  assert.match(body, /hello from upstream \/through-the-tunnel/);
  useAllowlist(["localhost"], [443, 80]);

  // Plain HTTP: denied host gets 403, and the proxy is still alive afterwards.
  const status = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "http://evil.com/x", method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.end();
  });
  assert.equal(status, 403);
  assert.equal(await tunnel(port, "evil.com:443"), "HTTP/1.1 403 Forbidden", "still serving");
  server.close();
  upstream.close();
  console.log("✓ egress proxy: refuses unlisted hosts and ports over CONNECT and HTTP, survives clients hanging up");
}

async function scrubbing() {
  const config = ConfigSchema.parse({
    testCommand: "npm test",
    backlog: { type: "github", repo: "o/r", tokenEnv: "MY_TICKETS" },
    commandEnv: { keep: ["DB_PASSWORD"] },
  });
  const base = { PATH: process.env.PATH, HOME: "/home/x", ANTHROPIC_API_KEY: "sk-ant", GH_TOKEN: "gh", MY_TICKETS: "t", DB_PASSWORD: "local", AZURE_FUNCTIONS_ENVIRONMENT: "Development" };
  const { env, removed } = commandEnv(config, base);
  assert.deepEqual(removed, ["ANTHROPIC_API_KEY", "GH_TOKEN", "MY_TICKETS"], "API keys, tokens and the backlog's token variable (any name)");
  assert.equal(env.DB_PASSWORD, "local", "commandEnv.keep wins");
  assert.equal(env.AZURE_FUNCTIONS_ENVIRONMENT, "Development", "ordinary settings stay");
  const r = await runShell('node -e "console.log(process.env.ANTHROPIC_API_KEY ?? \'none\', process.env.HOME)"', ".", { baseEnv: env });
  assert.equal(r.output.trim(), "none /home/x", "the command really does not see the key");
  const off = commandEnv(ConfigSchema.parse({ testCommand: "x", commandEnv: { scrubSecrets: false } }), base);
  assert.equal(off.env.ANTHROPIC_API_KEY, "sk-ant");
  assert.ok(isSecretName("AZURE_DEVOPS_EXT_PAT") && isSecretName("ConnectionStrings__Main") && !isSecretName("PATH"));
  console.log("✓ commandEnv: build/test commands run without credentials; keep list and opt-out work");
}

function checkLines() {
  const base = { testCommand: "npm test" };
  const text = (cfg: Record<string, unknown>, env: Record<string, string>) =>
    checkSandbox(ConfigSchema.parse({ ...base, ...cfg }), env)
      .map((l) => `${l.ok ? "ok" : "FAIL"}${l.warn ? "/warn" : ""} ${l.label}`)
      .join("\n");
  assert.match(text({}, { ANTHROPIC_API_KEY: "x" }), /ok build\/test commands run without 1 credential variable\(s\): ANTHROPIC_API_KEY/);
  assert.doesNotMatch(text({}, {}), /not running in a sandbox/, "attended, trusted: no nagging");
  assert.match(text({ loop: { mode: "auto" } }, {}), /ok\/warn not running in a sandbox \(loop.mode is auto\)/);
  assert.match(text({ runtime: { steps: { coder: "codex" } } }, {}), /not running in a sandbox \(steps run on Codex\)/);
  assert.match(text({}, { HECTOR_SANDBOX: "1", HTTPS_PROXY: "http://egress:3128" }), /ok running in the hector-flow sandbox; outbound traffic through http:\/\/egress:3128/);
  assert.match(text({}, { HECTOR_SANDBOX: "1" }), /FAIL running in the hector-flow sandbox/);
  console.log("✓ check: reports scrubbed variables, sandbox and proxy; warns when unattended or on Codex without one");
}

await rules();
await proxy();
await scrubbing();
checkLines();
console.log("\nsandbox checks passed");
