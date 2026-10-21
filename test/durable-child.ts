/**
 * Child process for test/durable.ts: runs a ticket and kills ITSELF with
 * SIGKILL in the middle of task T2, after writing half-done, uncommitted
 * edits. Nothing gets a chance to clean up: this is a real crash.
 *
 *   tsx test/durable-child.ts <repo> <ticket.md> <config.json> [save-memory]
 */
import { readFileSync } from "node:fs";
import { ConfigSchema } from "../src/config.js";
import { readTicket } from "../src/ticket.js";
import { implementTicket } from "../src/workflow.js";
import { byTask, ScriptedRunner, write } from "./helpers.js";
import { CLAMP, durableScript } from "./durable-fixture.js";

const [repo, ticketPath, configPath] = process.argv.slice(2) as [string, string, string];
const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));

const runner = new ScriptedRunner(
  {
    ...durableScript(),
    "coder:T1": [
      async (cwd, req) => {
        // With a memory backend, T1 records something before the crash: it must survive it.
        if (process.argv[5] === "save-memory") {
          await req.memory?.save?.({ title: "clamp uses Math.min/Math.max", content: "clamp is min(max(n, lo), hi) in src/clamp.js", kind: "convention", files: ["src/clamp.js"] });
        }
        write(cwd, "src/clamp.js", CLAMP);
        return { changedFiles: ["src/clamp.js"], notes: "clamp" };
      },
    ],
    "coder:T2": [
      (cwd) => {
        write(cwd, "src/lerp.js", "// half-written\n");
        write(cwd, "src/scratch.js", "// junk\n");
        process.kill(process.pid, "SIGKILL"); // the agent process dies mid-task
        return { changedFiles: [], notes: "unreachable" };
      },
    ],
  },
  byTask,
);
await implementTicket({ repo, ticket: await readTicket(ticketPath), config, runner });
console.log("UNREACHABLE: the run should have been killed");
