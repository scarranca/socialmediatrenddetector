import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

import type { Profile } from "./config.ts";
import {
  ScriptBatchSchema,
  TrendReportSchema,
  type ClusterSignal,
  type Script,
  type ScoredVideo,
  type Trend,
  type TrendReport,
} from "./types.ts";
import { emit } from "./events.ts";

// ---------------------------------------------------------------------------
// Client + request defaults
// ---------------------------------------------------------------------------

export const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01"; // required header for the `fallbacks: "default"` scalar form

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  // Lazy so importing this module never touches env / credentials.
  return (_client ??= new Anthropic());
}

type Log = (m: string) => void;
const noop: Log = () => {};

// ---------------------------------------------------------------------------
// System prompts (exported so they can be tuned without touching call sites)
// ---------------------------------------------------------------------------

export const TREND_SYSTEM_PROMPT = `You are a short-form video strategist who studies what actually gets reach on TikTok, Instagram Reels and YouTube Shorts for a specific industry. You receive a sample of recent high-performing videos plus aggregate stats and clusters, and you distill them into a small set of repeatable content patterns a solo creator can act on this week.

How you work:
- A trend is a content pattern (format + hook structure + angle), not a topic and not a single video. Name it by the pattern.
- Prefer patterns that show up across at least two different creators. A single viral video is an anecdote, not a trend.
- Judge momentum from age vs velocity: young videos with high views/day and high outlier factor are emerging; broad spread with steady velocity is peaking; old, high-view, low-velocity is saturated.
- Ground every trend in evidenceVideoIds taken only from the provided sample. Never invent ids.
- Note when a pattern is platform-specific rather than cross-platform.
- Judge fitForProfile against the creator's positioning, tone, audience, formats and avoid list, and explain the score honestly, including poor fits.
- Be concrete and skip filler.`;

export const SCRIPT_SYSTEM_PROMPT = `You are a short-form video scriptwriter for a solo creator who shoots with a phone and no crew. You turn one identified trend plus its evidence into ready-to-film scripts that are unmistakably about this creator's product and industry, not generic riffs on the trend.

How you work:
- The hook follows the trend's hook pattern structurally but is specific to the creator's offer and audience.
- Every beat has the exact spoken words and a concrete on-screen direction one person can execute alone with a phone (framing, b-roll, screen recording, on-screen text).
- Pacing fits the target duration; timestamps in beats add up to durationSec.
- Never copy an evidence caption or line verbatim. Write new lines in the same spirit.
- The CTA points to the creator's actual offer.
- Caption and hashtags are ready to paste as-is.
- Scripts for the same trend differ in format, drawing from the creator's preferred formats.`;

// ---------------------------------------------------------------------------
// Compact payload helpers
// ---------------------------------------------------------------------------

const round = (n: number | null | undefined, dp: number): number | null =>
  n == null || !Number.isFinite(n) ? null : Number(n.toFixed(dp));

function compactVideo(v: ScoredVideo) {
  return {
    id: v.id,
    platform: v.platform,
    author: v.author,
    authorFollowers: v.authorFollowers,
    views: v.views,
    engagementRate: round(v.engagementRate, 4),
    viewsPerDay: round(v.viewsPerDay, 0),
    outlierFactor: round(v.outlierFactor, 2),
    durationSec: v.durationSec,
    publishedAt: v.publishedAt,
    sound: v.sound?.name ?? null,
    hashtags: v.hashtags.slice(0, 8),
    caption: v.caption.length > 220 ? `${v.caption.slice(0, 220)}…` : v.caption,
  };
}

function compactCluster(c: ClusterSignal) {
  return {
    key: c.key,
    kind: c.kind,
    videos: c.videoIds.length,
    totalViews: c.totalViews,
    medianEngagementRate: round(c.medianEngagementRate, 4),
    platforms: c.platforms,
  };
}

function profileBrief(p: Profile) {
  return {
    name: p.name,
    handle: p.handle,
    industry: p.industry,
    language: p.language,
    platforms: p.platforms,
    audience: p.audience,
    positioning: p.positioning,
    tone: p.tone,
    offer: p.offer,
    formats: p.formats,
    avoid: p.avoid,
    targetDurationSeconds: p.targetDurationSeconds,
  };
}

// ---------------------------------------------------------------------------
// Core call wrapper: retry, structured output, stop-reason checks
// ---------------------------------------------------------------------------

const RETRYABLE = [Anthropic.RateLimitError, Anthropic.InternalServerError, Anthropic.APIConnectionError] as const;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1500;

function isRetryable(err: unknown): boolean {
  return RETRYABLE.some((E) => err instanceof E);
}

async function withRetry<T>(fn: () => Promise<T>, log: Log, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * 2 ** attempt;
      const name = err instanceof Error ? err.constructor.name : "error";
      log(`${label}: ${name}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * One structured-output call. Uses `client.beta.messages.parse` because, under the installed SDK types,
 * the beta parse path is the only one that accepts `output_config.format` (auto-parsed into `parsed_output`)
 * together with the `fallbacks` param — the non-beta `messages.parse` has no `fallbacks`.
 */
async function callStructured<S extends z.ZodType>(args: {
  schema: S;
  system: string;
  user: string;
  log: Log;
  label: string;
  phase: "trends" | "scripts";
}): Promise<z.infer<S>> {
  const { schema, system, user, log, label, phase } = args;
  const client = getClient();

  emit({ type: "llm", phase, status: "start", model: MODEL, label });
  const response = await withRetry(
    () =>
      client.beta.messages.parse({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: user }],
      }),
    log,
    label,
  );

  log(`${label}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens (${response.model})`);
  emit({ type: "llm", phase, status: "done", model: response.model, label, inTokens: response.usage.input_tokens, outTokens: response.usage.output_tokens });

  if (response.stop_reason === "refusal") {
    const why = response.stop_details?.explanation ?? "no explanation provided";
    throw new Error(`${label}: model refused the request — ${why}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`${label}: response hit max_tokens (${MAX_TOKENS}) before finishing the JSON; reduce input or raise the limit.`);
  }

  const parsed = response.parsed_output;
  if (parsed == null) {
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    throw new Error(`${label}: structured output failed to parse. First 300 chars: ${text.slice(0, 300)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// synthesizeTrends
// ---------------------------------------------------------------------------

const MAX_CLUSTERS_IN_PROMPT = 20;

export async function synthesizeTrends(args: {
  profile: Profile;
  evidence: ScoredVideo[];
  clusters: ClusterSignal[];
  stats: unknown;
  log?: (m: string) => void;
}): Promise<TrendReport> {
  const { profile, evidence, clusters, stats, log = noop } = args;
  if (evidence.length === 0) throw new Error("synthesizeTrends: no evidence videos provided.");

  const topClusters = [...clusters].sort((a, b) => b.totalViews - a.totalViews).slice(0, MAX_CLUSTERS_IN_PROMPT);

  const user = [
    `Industry: ${profile.industry}`,
    "",
    "## Creator profile",
    JSON.stringify(profileBrief(profile), null, 1),
    "",
    "## Aggregate stats for the sample",
    JSON.stringify(stats, null, 1),
    "",
    `## Top ${topClusters.length} clusters (hashtag / sound / keyword groupings)`,
    JSON.stringify(topClusters.map(compactCluster)),
    "",
    `## Evidence videos (${evidence.length}; ids are the only valid values for evidenceVideoIds)`,
    JSON.stringify(evidence.map(compactVideo)),
    "",
    "## Task",
    "Identify 3 to 8 distinct trends in this sample. Each trend is a content pattern, not an individual video and not a topic label.",
    "For each trend:",
    "- Name it by the pattern (what the videos do), not the subject.",
    "- Prefer patterns present across two or more creators; if you include a single-creator pattern, say so in the summary.",
    "- evidenceVideoIds: only ids from the list above, the 2-6 videos that best show the pattern.",
    "- momentum: judge from publishedAt/age vs viewsPerDay and outlierFactor.",
    "- signals: the hashtags and sound names actually shared by the evidence, plus typical duration.",
    "- If the pattern lives mainly on one platform, say which in the summary.",
    `- fitForProfile and fitReason: judge against the profile (positioning, tone, audience, formats, avoid list). Content will be produced in "${profile.language}".`,
    "Write the overview as a 3-5 sentence executive summary of what is working in this industry right now.",
  ].join("\n");

  const report = await callStructured({
    schema: TrendReportSchema,
    system: TREND_SYSTEM_PROMPT,
    user,
    log,
    label: "synthesizeTrends",
    phase: "trends",
  });

  // Defensive: drop hallucinated ids and warn (schema requires min 1 id, so keep the trend if any survive).
  const validIds = new Set(evidence.map((v) => v.id));
  const trends: Trend[] = [];
  for (const t of report.trends) {
    const kept = t.evidenceVideoIds.filter((id) => validIds.has(id));
    if (kept.length === 0) {
      log(`synthesizeTrends: dropping trend "${t.name}" — none of its evidence ids exist in the sample`);
      continue;
    }
    if (kept.length !== t.evidenceVideoIds.length) {
      log(`synthesizeTrends: trend "${t.name}" cited ${t.evidenceVideoIds.length - kept.length} unknown id(s); removed`);
    }
    trends.push({ ...t, evidenceVideoIds: kept });
    emit({ type: "trend", name: t.name, momentum: t.momentum, fit: t.fitForProfile, format: t.format });
  }
  if (trends.length === 0) throw new Error("synthesizeTrends: every returned trend cited unknown evidence ids.");
  return { ...report, trends };
}

// ---------------------------------------------------------------------------
// writeScripts
// ---------------------------------------------------------------------------

function dominantPlatform(trend: Trend, evidence: ScoredVideo[]): Script["platform"] {
  const counts = new Map<string, number>();
  for (const v of evidence) counts.set(v.platform, (counts.get(v.platform) ?? 0) + 1);
  if (counts.size === 0) return "all";
  const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  // Only call it platform-specific when clearly dominant; otherwise "all".
  return topCount / evidence.length >= 0.7 ? (top as Script["platform"]) : "all";
}

export async function writeScripts(args: {
  profile: Profile;
  trendReport: TrendReport;
  evidence: ScoredVideo[];
  scriptsPerTrend?: number;
  maxTrends?: number;
  log?: (m: string) => void;
}): Promise<Script[]> {
  const { profile, trendReport, evidence, log = noop } = args;
  const scriptsPerTrend = Math.max(1, Math.floor(args.scriptsPerTrend ?? 2));
  const maxTrends = Math.max(1, Math.floor(args.maxTrends ?? 4));

  const byId = new Map(evidence.map((v) => [v.id, v]));
  const selected = [...trendReport.trends].sort((a, b) => b.fitForProfile - a.fitForProfile).slice(0, maxTrends);
  const [minDur, maxDur] = profile.targetDurationSeconds;

  const out: Script[] = [];
  for (const trend of selected) {
    const trendEvidence = trend.evidenceVideoIds.map((id) => byId.get(id)).filter((v): v is ScoredVideo => v != null);
    const platform = dominantPlatform(trend, trendEvidence);
    const label = `writeScripts[${trend.name}]`;

    const user = [
      "## Creator profile",
      JSON.stringify(profileBrief(profile), null, 1),
      "",
      "## Trend to script",
      JSON.stringify(trend, null, 1),
      "",
      `## Evidence videos for this trend (${trendEvidence.length})`,
      JSON.stringify(trendEvidence.map(compactVideo)),
      "",
      "## Task",
      `Write ${scriptsPerTrend} script${scriptsPerTrend === 1 ? "" : "s"} for this trend. Requirements:`,
      `- Language: write all spoken lines, on-screen text, caption and hashtags in "${profile.language}".`,
      `- Duration: durationSec between ${minDur} and ${maxDur} seconds; beat timestamps cover the whole runtime.`,
      `- Hook: follow the trend's hookPattern ("${trend.hookPattern}") but make it specific to ${profile.name}'s product and the ${profile.industry} industry.`,
      "- Beats: exact spoken lines in `say`, and in `show` a concrete direction one person can shoot alone with a phone.",
      profile.avoid.length > 0 ? `- Respect the avoid list: ${profile.avoid.join("; ")}.` : "- Respect the creator's positioning and tone.",
      `- CTA: map it to this offer: ${profile.offer}`,
      "- Caption and hashtags: ready to paste; 3-8 hashtags, mixing trend signals with the creator's niche.",
      "- Do not copy any evidence caption or line verbatim.",
      scriptsPerTrend > 1
        ? `- Vary the format across the ${scriptsPerTrend} scripts, drawing from: ${profile.formats.length > 0 ? profile.formats.join(", ") : "the creator's usual formats"}.`
        : `- Format: pick the best fit from: ${profile.formats.length > 0 ? profile.formats.join(", ") : "the trend's dominant format"}.`,
      `- trendName: "${trend.name}". platform: "${platform}".`,
      `- soundSuggestion: a sound from the trend signals if one fits, otherwise null.`,
      "- whyThisWorks: 1-2 sentences tying the script back to the evidence.",
    ].join("\n");

    try {
      const batch = await callStructured({
        schema: ScriptBatchSchema,
        system: SCRIPT_SYSTEM_PROMPT,
        user,
        log,
        label,
        phase: "scripts",
      });
      // Normalize the two fields we told the model to fix, in case it drifted.
      const scripts = batch.scripts.map((s) => ({ ...s, trendName: trend.name, platform }));
      out.push(...scripts);
      log(`${label}: ${scripts.length} script(s)`);
      for (const sc of scripts) emit({ type: "script", trendName: sc.trendName, title: sc.title, durationSec: sc.durationSec, format: sc.format });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${label}: failed — ${msg}`);
      emit({ type: "llm", phase: "scripts", status: "failed", label, message: msg });
    }
  }

  if (out.length === 0 && selected.length > 0) {
    throw new Error("writeScripts: every trend failed to produce scripts; see log for details.");
  }
  return out;
}
