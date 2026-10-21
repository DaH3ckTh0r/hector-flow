import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface Ticket {
  id: string;
  title: string;
  body: string;
  acceptanceCriteria: string[];
}

/**
 * Parses a ticket written in markdown. Parsing is deterministic on purpose:
 * no model is involved in deciding what the ticket says.
 *
 *   # AB-123: Add cache to customer lookup
 *   free text...
 *   ## Acceptance criteria
 *   - criterion one
 *   - criterion two
 */
export async function readTicket(path: string): Promise<Ticket> {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/);

  const heading = lines.find((l) => /^#\s+/.test(l));
  if (!heading) throw new Error(`Ticket ${path} has no '# title' line`);
  const headingText = heading.replace(/^#\s+/, "").trim();

  const idMatch = headingText.match(/^([A-Za-z][A-Za-z0-9]*-\d+)\s*[:\-–]\s*(.+)$/);
  const id = idMatch?.[1] ?? basename(path, extname(path));
  const title = idMatch?.[2]?.trim() ?? headingText;

  const acIndex = lines.findIndex((l) => /^##\s+(acceptance criteria|criterios de aceptaci[oó]n)/i.test(l));
  const acceptanceCriteria: string[] = [];
  if (acIndex >= 0) {
    for (const line of lines.slice(acIndex + 1)) {
      if (/^##\s+/.test(line)) break;
      const item = line.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(.+)$/);
      if (item?.[1]) acceptanceCriteria.push(item[1].trim());
    }
  }
  if (acceptanceCriteria.length === 0) {
    throw new Error(
      `Ticket ${path} has no acceptance criteria. Add a '## Acceptance criteria' section with bullet points: ` +
        `they become the locked tests, so the flow refuses to run without them.`,
    );
  }

  return { id, title, body: text, acceptanceCriteria };
}
