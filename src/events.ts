/**
 * Structured pipeline events for the live UI.
 *
 * When TD_EVENTS=1 (set by the dashboard server when it spawns the pipeline), each event is
 * written to stderr as a single line prefixed with `::event::` so the server can pick it out of
 * the plain log stream. Without the flag this is a no-op, so CLI runs stay quiet.
 */
export type PipelineEvent =
  | { type: "stage"; stage: "collect" | "analyze" | "synthesize" | "scripts" | "report"; status: "start" | "done" | "failed"; detail?: string }
  | { type: "actor"; platform: string; status: "start" | "done" | "failed"; actorId: string; queries?: string[]; runUrl?: string; raw?: number; kept?: number; message?: string }
  | { type: "videos"; platform: string; items: Array<{ id: string; author: string; views: number; caption: string; url: string }> }
  | { type: "filter"; kept: number; droppedViews: number; droppedOld: number; droppedDup: number }
  | { type: "analyze"; scored: number; clusters: number; evidence: number; topClusters: string[] }
  | { type: "llm"; phase: "trends" | "scripts"; status: "start" | "done" | "failed"; model?: string; label?: string; inTokens?: number; outTokens?: number; message?: string }
  | { type: "trend"; name: string; momentum: string; fit: number; format: string }
  | { type: "script"; trendName: string; title: string; durationSec: number; format: string }
  | { type: "report"; file: string; trends: number; scripts: number };

const ENABLED = process.env.TD_EVENTS === "1";

export function emit(event: PipelineEvent): void {
  if (!ENABLED) return;
  process.stderr.write(`::event::${JSON.stringify(event)}\n`);
}
