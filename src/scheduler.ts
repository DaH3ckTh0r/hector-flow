/**
 * Runs tasks as a dependency graph with a concurrency cap. A task starts only
 * when every task it depends on has finished. On the first failure no new
 * tasks start; running ones are awaited, then the first error is rethrown.
 */
export interface DagTask {
  id: string;
  dependsOn: string[];
}

export function validateDag(tasks: DagTask[]): void {
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new Error("Plan has duplicate task ids.");
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) throw new Error(`Task ${t.id} depends on unknown task ${d}.`);
      if (d === t.id) throw new Error(`Task ${t.id} depends on itself.`);
    }
  }
  // Cycle check (Kahn).
  const indegree = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const t of tasks) {
      if (t.dependsOn.includes(id)) {
        const n = indegree.get(t.id)! - 1;
        indegree.set(t.id, n);
        if (n === 0) queue.push(t.id);
      }
    }
  }
  if (visited !== tasks.length) throw new Error("Plan has a dependency cycle.");
}

export async function runDag<T extends DagTask>(
  tasks: T[],
  maxParallel: number,
  run: (task: T) => Promise<void>,
): Promise<void> {
  validateDag(tasks);
  const done = new Set<string>();
  const started = new Set<string>();
  const running = new Map<string, Promise<void>>();
  let failure: unknown;

  const ready = () =>
    tasks.filter((t) => !started.has(t.id) && t.dependsOn.every((d) => done.has(d)));

  while (done.size < tasks.length) {
    if (!failure) {
      for (const t of ready()) {
        if (running.size >= maxParallel) break;
        started.add(t.id);
        running.set(
          t.id,
          run(t).then(
            () => {
              done.add(t.id);
              running.delete(t.id);
            },
            (err) => {
              failure ??= err;
              running.delete(t.id);
            },
          ),
        );
      }
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  if (failure) throw failure;
}
