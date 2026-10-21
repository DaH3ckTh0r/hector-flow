import { z } from "zod";

/**
 * Contracts between steps. Every agent returns one of these, validated twice:
 * by the SDK (JSON Schema) and again here with zod before the workflow uses it.
 */

export const DiscoverySchema = z.object({
  summary: z.string().describe("What the repository does, in two or three sentences"),
  stack: z.array(z.string()).describe("Languages, frameworks and test tools in use"),
  relevantFiles: z
    .array(z.object({ path: z.string(), why: z.string() }))
    .describe("Files the ticket will most likely touch or depend on"),
  conventions: z.array(z.string()).describe("Patterns the code follows that new code must respect"),
  openQuestions: z.array(z.string()).describe("Ambiguities in the ticket that the repo does not resolve"),
});
export type Discovery = z.infer<typeof DiscoverySchema>;

export const PlanSchema = z.object({
  summary: z.string(),
  tasks: z
    .array(
      z.object({
        id: z.string().describe("T1, T2, ..."),
        component: z.string().describe("The ONE component this task changes (a name from the components list)"),
        dependsOn: z
          .array(z.string())
          .describe("Ids of tasks that must be finished first. Empty when the task can start right away, so it runs in parallel."),
        description: z.string(),
        files: z.array(z.string()).describe("Paths relative to the component folder"),
        acceptanceCriteria: z.array(z.string()),
      }),
    )
    .min(1),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = Plan["tasks"][number];

export const TestAuthoringSchema = z.object({
  testFiles: z.array(z.string()).describe("Test files created or changed"),
  acceptanceMap: z
    .array(
      z.object({
        criterion: z.string().describe("The acceptance criterion, verbatim"),
        command: z
          .string()
          .describe("A single shell command that exits 0 only if this criterion is met, e.g. running just the tests for it"),
      }),
    )
    .min(1)
    .describe("One executable check per acceptance criterion. The workflow runs these itself to decide if the ticket is done."),
});
export type TestAuthoring = z.infer<typeof TestAuthoringSchema>;
export type AcceptanceCheck = TestAuthoring["acceptanceMap"][number];

export const ImplementationSchema = z.object({
  changedFiles: z
    .array(z.string())
    .describe("Every file you created, modified or deleted in this round. Undeclared changes are discarded."),
  notes: z.string().describe("What was done, assumptions made, and anything the reviewer should know"),
});
export type Implementation = z.infer<typeof ImplementationSchema>;

export const DiagnosisSchema = z.object({
  owner: z
    .enum(["implementation", "test", "environment"])
    .describe(
      "implementation: the production code is wrong. test: the test itself is wrong or contradicts the ticket. environment: missing dependency, tool, config or service.",
    ),
  errorSignature: z
    .string()
    .describe("Stable short identifier for this failure, e.g. 'TS2345 in src/cache.ts' or 'CS8862'"),
  rootCause: z.string(),
  files: z.array(z.string()).describe("Files that need to change"),
  fixPlan: z.string().describe("Concrete fix, specific enough for another engineer to apply"),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const ReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor"]),
      component: z.string().describe("Component the file belongs to"),
      file: z.string().describe("Path relative to the component folder"),
      description: z.string(),
    }),
  ),
});
export type Review = z.infer<typeof ReviewSchema>;

export const AnswerSchema = z.object({
  answer: z.string(),
  confident: z
    .boolean()
    .describe("true only if the ticket, research, plan or repository actually settles the question"),
  basis: z.string().describe("Where the answer comes from: ticket section, file path, plan task"),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const QaPlanSchema = z.object({
  markdown: z
    .string()
    .describe("Manual test plan for a teammate: setup, numbered steps, expected results. Only cases that can actually happen."),
});
export type QaPlan = z.infer<typeof QaPlanSchema>;

export const DistillSchema = z.object({
  lessons: z.array(
    z.object({
      role: z
        .enum(["enrich", "plan", "testAuthor", "coder", "review"])
        .describe("The step whose output the human had to correct"),
      guideline: z
        .string()
        .describe("A general, reusable instruction for that step so the mistake does not happen again. Not specific to this ticket."),
      evidence: z.string().describe("What the human changed that shows the mistake"),
    }),
  ),
});
export type Distill = z.infer<typeof DistillSchema>;

/** Converts a zod schema to the JSON Schema the Agent SDK expects. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
