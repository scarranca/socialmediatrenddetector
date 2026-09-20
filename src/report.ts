import type { Profile } from "./config.js";
import type { ClusterSignal, Script, ScoredVideo, Trend, TrendReport } from "./types.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** 999 → "999", 1234 → "1.2K", 3_400_000 → "3.4M", 2e9 → "2B". */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const scale = (v: number, suffix: string) => {
    const s = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    return `${sign}${s}${suffix}`;
  };
  if (abs >= 1e9) return scale(abs / 1e9, "B");
  if (abs >= 1e6) return scale(abs / 1e6, "M");
  if (abs >= 1e3) return scale(abs / 1e3, "K");
  return `${sign}${Math.round(abs)}`;
}

/** 0.0523 → "5.2%". */
export function pct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "–";
  return `${(ratio * 100).toFixed(digits)}%`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "–";
  return `${Math.round(sec)}s`;
}

/** Make a value safe inside a Markdown table cell: single line, pipes escaped. */
export function cell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

/** Collapse whitespace to one line and truncate with an ellipsis. */
export function truncate(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function hashtagList(tags: string[]): string {
  const clean = tags.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
  return clean.length ? clean.map((t) => `#${t}`).join(" ") : "–";
}

function handle(author: string): string {
  const a = author.trim();
  return a.startsWith("@") ? a : `@${a}`;
}

function videoLine(v: ScoredVideo): string {
  const caption = truncate(v.caption, 90);
  const parts = [v.platform, handle(v.author), `${fmtNum(v.views)} views`, `${pct(v.engagementRate)} eng.`, `[link](${v.url})`];
  return `${parts.join(" · ")}${caption ? ` — ${caption}` : ""}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(profile: Profile, generatedAt: Date, videos: ScoredVideo[]): string {
  const platforms = [...new Set(videos.map((v) => v.platform))];
  const platformText = platforms.length ? platforms.join(", ") : profile.platforms.join(", ");
  return [
    `# Trend report — ${profile.industry} — ${fmtDate(generatedAt)}`,
    "",
    `**Profile:** ${profile.name} (${handle(profile.handle)})  `,
    `**Data:** ${videos.length} videos · ${platformText} · last ${profile.collection.lookbackDays} days`,
  ].join("\n");
}

function renderTrend(trend: Trend, index: number, byId: Map<string, ScoredVideo>): string {
  const lines: string[] = [];
  lines.push(`### ${index}. ${trend.name}`, "");
  lines.push(
    table(
      ["Momentum", "Fit /10", "Format", "Typical duration"],
      [[trend.momentum, String(trend.fitForProfile), trend.format, fmtDuration(trend.signals.typicalDurationSec)]],
    ),
    "",
  );
  lines.push(trend.summary.trim(), "");
  lines.push("**Hook pattern**", "", `> ${trend.hookPattern.replace(/\r?\n+/g, " ").trim()}`, "");
  if (trend.fitReason?.trim()) lines.push(`**Why it fits:** ${trend.fitReason.trim()}`, "");

  lines.push("**Signals**", "");
  lines.push(`- Hashtags: ${hashtagList(trend.signals.hashtags)}`);
  lines.push(`- Sounds: ${trend.signals.sounds.length ? trend.signals.sounds.join(", ") : "–"}`);
  lines.push("");

  const evidence = trend.evidenceVideoIds.map((id) => byId.get(id)).filter((v): v is ScoredVideo => Boolean(v));
  lines.push("**Evidence**", "");
  if (evidence.length === 0) {
    lines.push("- _No sampled videos resolved for this trend._");
  } else {
    for (const v of evidence) lines.push(`- ${videoLine(v)}`);
  }
  return lines.join("\n");
}

function renderTrends(trendReport: TrendReport, byId: Map<string, ScoredVideo>): string {
  const sorted = [...trendReport.trends].sort((a, b) => b.fitForProfile - a.fitForProfile);
  if (sorted.length === 0) return "## Trends\n\n_No trends identified._";
  return ["## Trends", "", ...sorted.map((t, i) => renderTrend(t, i + 1, byId)).flatMap((s) => [s, ""])].join("\n").trimEnd();
}

function renderScript(script: Script): string {
  const lines: string[] = [];
  lines.push(`### ${script.title}`, "");
  lines.push(`_${script.trendName} · ${script.platform} · ${script.format} · ${fmtDuration(script.durationSec)}_`, "");
  lines.push(`**Hook:** ${script.hook.replace(/\r?\n+/g, " ").trim()}`, "");
  lines.push(
    table(
      ["Time", "Say", "Show"],
      script.beats.map((b) => [b.t, b.say, b.show]),
    ),
    "",
  );
  lines.push(`**CTA:** ${script.cta.replace(/\r?\n+/g, " ").trim()}`, "");
  lines.push("**Caption**", "", "```text", script.caption.replace(/```/g, "'''").trim(), "```", "");
  lines.push(`**Hashtags:** ${hashtagList(script.hashtags)}`, "");
  lines.push(`**Sound:** ${script.soundSuggestion?.trim() || "original audio / none"}`, "");
  lines.push(`**Why this works:** ${script.whyThisWorks.trim()}`);
  return lines.join("\n");
}

function renderScripts(scripts: Script[]): string {
  if (scripts.length === 0) return "## Scripts\n\n_No scripts generated._";
  return ["## Scripts", "", ...scripts.map(renderScript).flatMap((s) => [s, ""])].join("\n").trimEnd();
}

function renderTopVideos(videos: ScoredVideo[], limit = 15): string {
  const top = [...videos].sort((a, b) => b.score - a.score).slice(0, limit);
  if (top.length === 0) return "## Top videos in the sample\n\n_No videos._";
  const rows = top.map((v, i) => [
    String(i + 1),
    v.platform,
    handle(v.author),
    fmtNum(v.views),
    pct(v.engagementRate),
    fmtNum(v.viewsPerDay),
    v.score.toFixed(1),
    `[open](${v.url})`,
  ]);
  return ["## Top videos in the sample", "", table(["#", "Platform", "Author", "Views", "ER", "Views/day", "Score", "Link"], rows)].join("\n");
}

function renderSignals(clusters: ClusterSignal[], limit = 15): string {
  const top = clusters.slice(0, limit);
  if (top.length === 0) return "## Signals\n\n_No clusters with enough videos._";
  const rows = top.map((c) => [
    c.kind,
    c.kind === "hashtag" ? `#${c.key}` : c.key,
    String(c.videoIds.length),
    fmtNum(c.totalViews),
    pct(c.medianEngagementRate),
    c.platforms.join(", "),
  ]);
  return ["## Signals", "", table(["Kind", "Key", "Videos", "Total views", "Median ER", "Platforms"], rows)].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderReport(args: {
  profile: Profile;
  generatedAt: Date;
  videos: ScoredVideo[];
  clusters: ClusterSignal[];
  trendReport: TrendReport;
  scripts: Script[];
}): string {
  const { profile, generatedAt, videos, clusters, trendReport, scripts } = args;
  const byId = new Map(videos.map((v) => [v.id, v]));

  const sections = [
    renderHeader(profile, generatedAt, videos),
    "## Overview",
    trendReport.overview.trim(),
    renderTrends(trendReport, byId),
    renderScripts(scripts),
    renderTopVideos(videos),
    renderSignals(clusters),
  ];

  return `${sections.join("\n\n")}\n`;
}
