import type { Role } from "./config.js";
import type { ErrorLesson, Guideline } from "./lessons.js";
import type { AcceptanceCheck, Diagnosis, Discovery, Plan, PlanTask, Review } from "./schemas.js";
import type { Ticket } from "./ticket.js";

/**
 * Prompts are plain functions of typed inputs. Each agent gets exactly the
 * context its step needs — never the whole conversation of previous steps.
 * What each role IS (its instructions) lives in skills/<role>/SKILL.md.
 */

/**
 * A step's system prompt: its skill instructions (from SKILL.md, see src/skills.ts)
 * plus the guidelines distilled from past human corrections.
 */
export function systemPrompt(instructions: string, guidelines: Guideline[]): string {
  if (!guidelines.length) return instructions;
  return `${instructions}

<guidelines_from_past_corrections>
Humans had to correct this step before. Follow these guidelines:
${guidelines.map((g) => `- ${g.guideline}`).join("\n")}
</guidelines_from_past_corrections>`;
}

/** What prompts need to know about a component. */
export interface ComponentInfo {
  name: string;
  description?: string;
  repoName: string;
  path: string;
  /** Absolute folder of the component in the ticket's integration workspace. */
  dir: string;
  testCommand: string;
  allowedCommands: string[];
}

/** One entry per commit the flow makes. Files come from git, not from the agent. */
export interface LedgerEntry {
  step: string;
  role: Role;
  component: string;
  repo: string;
  taskId?: string;
  description: string;
  sha: string;
  /** Repo-relative paths. */
  files: string[];
  /** Files the agent changed but did not declare (reverted or flagged, per policy). */
  undeclared: string[];
  notes: string;
}

export const renderIssues = (issues: Review["issues"]) =>
  issues.map((i) => `- [${i.severity}] ${i.component}/${i.file}: ${i.description}`).join("\n");

export const renderDiagnosis = (d: Diagnosis, failure: string) => `Root cause: ${d.rootCause}
Files: ${d.files.join(", ")}
Fix: ${d.fixPlan}

Failure output:
${failure}`;

const ticketBlock = (t: Ticket) => `<ticket id="${t.id}">
${t.body}
</ticket>`;

const componentsBlock = (cs: ComponentInfo[]) => `<components>
${cs
  .map(
    (c) =>
      `- ${c.name}: ${c.description ?? "(no description)"}\n  repo: ${c.repoName}, folder: ${c.path}\n  read it at: ${c.dir}\n  tests: ${c.testCommand}`,
  )
  .join("\n")}
</components>`;

const ledgerBlock = (ledger: LedgerEntry[]) =>
  ledger.length
    ? `
<task_ledger>
Every commit the workflow has made so far (step, component, owner task, SHA, files, notes):
${ledger
  .map(
    (e) =>
      `- ${e.step} (${e.component})${e.taskId ? ` [${e.taskId}]` : ""} @ ${e.sha.slice(0, 8)}: ${e.description}\n  files: ${e.files.join(", ") || "(none)"}\n  notes: ${e.notes}`,
  )
  .join("\n")}
</task_ledger>`
    : "";

export const prompts = {
  enrich: (t: Ticket, cs: ComponentInfo[]) => `${ticketBlock(t)}

${componentsBlock(cs)}

Research the components and report what is needed to implement this ticket.`,

  plan: (t: Ticket, d: Discovery, cs: ComponentInfo[]) => `${ticketBlock(t)}

${componentsBlock(cs)}

<research>
${JSON.stringify(d, null, 2)}
</research>

Produce the implementation plan. Use only these component names: ${cs.map((c) => c.name).join(", ")}.`,

  testAuthor: (t: Ticket, d: Discovery, plan: Plan, c: ComponentInfo) => `${ticketBlock(t)}

<acceptance_criteria>
${t.acceptanceCriteria.map((x, i) => `${i + 1}. ${x}`).join("\n")}
</acceptance_criteria>

<plan_for_${c.name}>
${plan.tasks
  .filter((x) => x.component === c.name)
  .map((x) => `- ${x.id}: ${x.description}`)
  .join("\n")}
</plan_for_${c.name}>

<repo_context>
Stack: ${d.stack.join(", ")}
Conventions:
${d.conventions.map((x) => `- ${x}`).join("\n")}
</repo_context>

You are writing tests for component "${c.name}" (folder ${c.path}). Its suite runs with: ${c.testCommand}
Acceptance-map commands must start with one of: ${c.allowedCommands.join(", ")}`,

  coder: (t: Ticket, plan: Plan, task: PlanTask, ledger: LedgerEntry[], c: ComponentInfo, others: ComponentInfo[]) => `${ticketBlock(t)}

<plan>
${plan.summary}
${plan.tasks.map((x) => `- ${x.id} (${x.component})${x.dependsOn.length ? ` after ${x.dependsOn.join(", ")}` : ""}: ${x.description}`).join("\n")}
</plan>
${ledgerBlock(ledger)}
${
  others.length
    ? `
<other_components_read_only>
${others.map((o) => `- ${o.name} at ${o.dir}`).join("\n")}
</other_components_read_only>`
    : ""
}

<current_task id="${task.id}" component="${c.name}">
${task.description}
Files: ${task.files.join(", ") || "(decide)"}
Acceptance:
${task.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}
</current_task>

Implement this task only, inside component "${c.name}". Check with: ${c.testCommand}`,

  diagnose: (t: Ticket, c: ComponentInfo, failure: string, diff: string, known: ErrorLesson[]) => `${ticketBlock(t)}

<failing_component name="${c.name}" folder="${c.path}"/>

<failure>
${failure}
</failure>

<diff_since_tests_locked>
${diff || "(no changes)"}
</diff_since_tests_locked>
${
  known.length
    ? `
<validated_fixes>
These fixes resolved a failure with a matching signature before. Use them only if they fit this case.
${known.map((l) => `- cause: ${l.rootCause}\n  fix: ${l.fix}`).join("\n")}
</validated_fixes>`
    : ""
}

Diagnose the failure.`,

  repair: (t: Ticket, c: ComponentInfo, d: Diagnosis, failure: string) => `${ticketBlock(t)}

<component name="${c.name}" folder="${c.path}"/>

<diagnosis>
${JSON.stringify(d, null, 2)}
</diagnosis>

<failure>
${failure}
</failure>

Apply the fix described in the diagnosis. Check with: ${c.testCommand}`,

  review: (t: Ticket, diffs: string, cs: ComponentInfo[], focus?: string) => `${ticketBlock(t)}

${componentsBlock(cs)}

<diff>
${diffs}
</diff>
${focus ? `\n<review_focus>\n${focus}\n</review_focus>\n` : ""}
Review this change. Report each finding with its component and a path relative to that component's folder.`,

  reviewFix: (t: Ticket, c: ComponentInfo, issues: Review["issues"]) => `${ticketBlock(t)}

<component name="${c.name}" folder="${c.path}"/>

<review_findings>
${renderIssues(issues)}
</review_findings>

Fix these review findings without breaking the tests. Check with: ${c.testCommand}`,

  /**
   * For a resumed worker session: it already has the ticket, its task and
   * what it built in context, so only the new defects are sent.
   */
  workerDefects: (source: "verification" | "review" | "build", details: string, testCommand: string) =>
    `The workflow ${source === "review" ? "reviewed" : "checked"} your work and found defects that are yours to fix:

<defects>
${details}
</defects>

Your workspace has been updated with everything the other tasks have finished since you started.
Fix the defects without breaking anything else. Check with: ${testCommand}
Return changedFiles listing every file you changed in THIS round.`,

  /** For a resumed worker whose branch conflicts with work integrated in parallel. */
  resolveConflicts: (conflicts: string[], testCommand: string) =>
    `Other tasks finished in parallel and their changes conflict with yours. The workflow has started merging them into your workspace;
these files now contain git conflict markers (<<<<<<<, =======, >>>>>>>):

${conflicts.map((f) => `- ${f}`).join("\n")}

Resolve every conflict so that BOTH your change and theirs are preserved, and remove all markers. Do not run git commands.
Check with: ${testCommand}
Return changedFiles listing every file you edited to resolve the conflicts.`,

  answer: (t: Ticket, d: Discovery, plan: Plan, question: string, asker: string) => `${ticketBlock(t)}

<research>
${JSON.stringify(d, null, 2)}
</research>

<plan>
${JSON.stringify(plan, null, 2)}
</plan>

<question from="${asker}">
${question}
</question>

Answer the question.`,

  qaPlan: (t: Ticket, diffs: string, checks: Array<AcceptanceCheck & { component: string }>) => `${ticketBlock(t)}

<automated_checks_already_passing>
${checks.map((c) => `- [${c.component}] ${c.criterion}  (${c.command})`).join("\n")}
</automated_checks_already_passing>

<diff>
${diffs}
</diff>

Write the manual test plan.`,

  distill: (t: Ticket, ledger: LedgerEntry[], humanDiff: string) => `${ticketBlock(t)}
${ledgerBlock(ledger)}

<human_corrections>
The diff below is what a human changed AFTER the workflow finished:
${humanDiff}
</human_corrections>

Extract the lessons.`,
};
