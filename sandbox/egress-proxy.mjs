#!/usr/bin/env node
/**
 * hector-flow egress proxy: the sandbox's only way out.
 *
 * The hector container sits on an internal Docker network with no route to the
 * internet. Its HTTPS_PROXY points here. This proxy tunnels HTTPS (CONNECT) and
 * forwards plain HTTP only to hosts on the allowlist, and logs every decision
 * as one JSON line.
 *
 * Allowlist file: one entry per line, # comments.
 *   api.anthropic.com      exact host
 *   *.githubcopilot.com    any subdomain (not the bare domain)
 *   .npmjs.org             the domain and any subdomain
 *
 * Environment: ALLOWLIST (file, default ./allowed-domains.txt), PORT (3128),
 * HOST (0.0.0.0), ALLOWED_PORTS (443,80), LOG (path; stdout when unset).
 * No dependencies: runs on any Node 20+.
 */
import { appendFileSync, readFileSync, watchFile } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const file = process.env.ALLOWLIST ?? new URL("./allowed-domains.txt", import.meta.url).pathname;
let ports = new Set((process.env.ALLOWED_PORTS ?? "443,80").split(",").map((p) => Number(p.trim())));
const logFile = process.env.LOG;

export function parseAllowlist(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(host, rules) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return rules.some((r) => {
    if (r.startsWith("*.")) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    if (r.startsWith(".")) return h === r.slice(1) || h.endsWith(r);
    return h === r;
  });
}

let rules = [];
function load() {
  try {
    rules = parseAllowlist(readFileSync(file, "utf8"));
    log({ event: "allowlist", entries: rules.length, file });
  } catch (err) {
    rules = [];
    log({ event: "allowlist", error: String(err.message), file });
  }
}

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (logFile) appendFileSync(logFile, line + "\n");
  else console.log(line);
}

function decide(host, port) {
  if (!ports.has(port)) return `port ${port} is not allowed`;
  if (!isAllowed(host, rules)) return `${host} is not on the allowlist`;
  return null;
}

export function createProxy() {
  const server = createServer((req, res) => {
    req.on("error", () => res.destroy());
    res.on("error", () => undefined);
    // Plain HTTP through a proxy: the request line carries an absolute URL.
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end("hector egress proxy: absolute URL required\n");
      return;
    }
    const port = Number(url.port || 80);
    const denied = decide(url.hostname, port);
    log({ event: "http", host: url.hostname, port, method: req.method, allowed: !denied, ...(denied ? { reason: denied } : {}) });
    if (denied) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`hector egress proxy: ${denied}\n`);
      return;
    }
    const upstream = httpRequest(
      { host: url.hostname, port, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: url.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`hector egress proxy: ${err.message}\n`);
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, client, head) => {
    // A client that hangs up (e.g. after a 403) must never crash the proxy.
    client.on("error", () => client.destroy());
    const [host, portText] = splitHostPort(req.url ?? "");
    const port = Number(portText || 443);
    const denied = host ? decide(host, port) : "bad CONNECT target";
    log({ event: "connect", host, port, allowed: !denied, ...(denied ? { reason: denied } : {}) });
    if (denied) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nhector egress proxy: ${denied}\n`);
      return;
    }
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", (err) => {
      log({ event: "connect-error", host, port, error: err.message });
      if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      close();
    });
    client.on("error", close);
    client.on("close", () => upstream.destroy());
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

function splitHostPort(target) {
  const m = target.match(/^\[([^\]]+)\]:(\d+)$/) ?? target.match(/^([^:]+):(\d+)$/);
  return m ? [m[1], m[2]] : [target, ""];
}

/** For tests and embedding: replace the allowlist (and optionally the allowed ports). */
export function useAllowlist(list, allowedPorts) {
  rules = list;
  if (allowedPorts) ports = new Set(allowedPorts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.on("uncaughtException", (err) => log({ event: "error", error: String(err?.stack ?? err) }));
  load();
  watchFile(file, { interval: 2000 }, load); // edit the allowlist without restarting
  const port = Number(process.env.PORT ?? 3128);
  createProxy().listen(port, process.env.HOST ?? "0.0.0.0", () => log({ event: "listening", port }));
  process.on("SIGTERM", () => process.exit(0));
}
