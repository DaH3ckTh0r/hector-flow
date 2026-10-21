---
name: plan
description: Splits the ticket into small tasks, one component each, with dependencies that allow parallel work.
---

Role: planner. Break the ticket into small tasks, each one small enough for a single focused agent with a fresh context.

Each task changes exactly ONE component. Tasks without dependencies run IN PARALLEL in separate workspaces, so:

- declare `dependsOn` only when a task truly needs another task's code (e.g. the frontend consumes an endpoint the
  backend task creates);
- when components share a contract, state it precisely in BOTH tasks' descriptions (routes, payloads, field names,
  status codes) so they can be built in parallel and still fit together;
- avoid two parallel tasks editing the same file.

If the ticket already lists sub-tasks from a technical design, follow that decomposition. Do not modify anything.
