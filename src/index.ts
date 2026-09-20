import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildClusters, scoreVideos, selectEvidence, summarizeStats } from "./analyze.ts";
import { collectVideos } from "./collect.ts";
import { APIFY_MAX_SPEND_USD, DATA_DIR, OUTPUT_DIR, ROOT, loadProfile, requireEnv } from "./config.ts";
import { emit } from "./events.ts";
import { synthesizeTrends, writeScripts } from "./llm.ts";
import { renderReport } from "./report.ts";
import { TrendReportSchema, type Script, type TrendReport, type Video } from "./types.ts";

const USAGE = `trend-detector

Usage:
  tsx src/index.ts <command> [options]

Commands:
  collect   Scrape videos from Apify (TikTok / YouTube Shorts / Instagram Reels) -> data/videos.json
  analyze   Score + cluster videos, ask Claude to name the trends -> data/trends.json
  scripts   Write on-trend scripts for your profile -> data/scripts.json + output/report-<date>.md
  run       collect -> analyze -> scripts

Options:
  --sample            Use fixtures/sample-videos.json instead of calling Apify (no Apify spend)
  --profile <path>    Profile JSON (default: config/profile.json)
  --max-spend <usd>   Cap Apify spend for this collect run (default: $${APIFY_MAX_SPEND_USD})
  --trends <n>        How many trends to write scripts for (default: 4)
  --per-trend <n>     Scripts per trend (default: 2)
  -h, --help
`;

const log = (msg: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
const TRENDS_FILE = path.join(DATA_DIR, "trends.json");
const SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");
const SAMPLE_FILE = path.join(ROOT, "fixtures", "sample-videos.json");

function readJson<T>(file: string, what: string): T {
  if (!existsSync(file)) throw new Error(`${what} not found at ${file}. Run the previous step first.`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
  log(`wrote ${path.relative(ROOT, file)}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sample: { type: "boolean", default: false },
      profile: { type: "string" },
      "max-spend": { type: "string" },
      trends: { type: "string", default: "4" },
      "per-trend": { type: "string", default: "2" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command || !["collect", "analyze", "scripts", "run"].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const profile = loadProfile(values.profile);
  log(`profile: ${profile.name} · ${profile.industry}`);

  const doCollect = command === "collect" || command === "run";
  const doAnalyze = command === "analyze" || command === "run";
  const doScripts = command === "scripts" || command === "run";

  // ---- collect -------------------------------------------------------------
  if (doCollect) {
    emit({ type: "stage", stage: "collect", status: "start", detail: values.sample ? "sample fixtures" : profile.platforms.join(", ") });
    let videos: Video[];
    if (values.sample) {
      videos = readJson<Video[]>(SAMPLE_FILE, "Sample fixture");
      log(`--sample: loaded ${videos.length} fixture videos (no Apify calls)`);
      // Mirror what a real collect emits so the live UI shows the same flow on a dry run.
      const byPlatform = new Map<string, Video[]>();
      for (const v of videos) byPlatform.set(v.platform, [...(byPlatform.get(v.platform) ?? []), v]);
      for (const [platform, list] of byPlatform) {
        emit({ type: "actor", platform, status: "start", actorId: "fixtures/sample-videos.json", queries: profile.keywords });
        await new Promise((r) => setTimeout(r, 900));
        emit({ type: "actor", platform, status: "done", actorId: "fixtures/sample-videos.json", raw: list.length, kept: list.length });
        emit({ type: "videos", platform, items: list.slice().sort((a, b) => b.views - a.views).slice(0, 40).map((v) => ({ id: v.id, author: v.author, views: v.views, caption: v.caption.replace(/\s+/g, " ").slice(0, 90), url: v.url })) });
      }
      emit({ type: "filter", kept: videos.length, droppedViews: 0, droppedOld: 0, droppedDup: 0 });
    } else {
      const token = requireEnv("APIFY_TOKEN");
      const maxSpendUsd = values["max-spend"] ? Number(values["max-spend"]) : APIFY_MAX_SPEND_USD;
      log(`collecting from ${profile.platforms.join(", ")} · spend cap $${maxSpendUsd.toFixed(2)}`);
      videos = await collectVideos(profile, { token, maxSpendUsd, log });
      log(`collected ${videos.length} videos after filtering`);
    }
    writeJson(VIDEOS_FILE, videos);
    emit({ type: "stage", stage: "collect", status: "done", detail: `${videos.length} videos` });
  }

  // ---- analyze -------------------------------------------------------------
  if (doAnalyze) {
    requireEnv("ANTHROPIC_API_KEY");
    const videos = readJson<Video[]>(VIDEOS_FILE, "videos.json");
    if (videos.length === 0) throw new Error("No videos to analyze — widen keywords or lower collection.minViews.");

    emit({ type: "stage", stage: "analyze", status: "start" });
    const scored = scoreVideos(videos);
    const clusters = buildClusters(scored);
    const evidence = selectEvidence(scored, clusters);
    const stats = summarizeStats(scored);
    log(`scored ${scored.length} videos · ${clusters.length} clusters · ${evidence.length} evidence videos → Claude`);
    emit({ type: "analyze", scored: scored.length, clusters: clusters.length, evidence: evidence.length, topClusters: clusters.slice(0, 8).map((c) => (c.kind === "hashtag" ? `#${c.key}` : c.key)) });
    emit({ type: "stage", stage: "analyze", status: "done", detail: `${clusters.length} clusters` });

    emit({ type: "stage", stage: "synthesize", status: "start" });
    const trendReport = await synthesizeTrends({ profile, evidence, clusters, stats, log });
    writeJson(TRENDS_FILE, trendReport);
    emit({ type: "stage", stage: "synthesize", status: "done", detail: `${trendReport.trends.length} trends` });
    for (const t of trendReport.trends) {
      log(`  trend: ${t.name} [${t.momentum}, fit ${t.fitForProfile}/10]`);
    }
  }

  // ---- scripts -------------------------------------------------------------
  if (doScripts) {
    requireEnv("ANTHROPIC_API_KEY");
    const videos = readJson<Video[]>(VIDEOS_FILE, "videos.json");
    const trendReport: TrendReport = TrendReportSchema.parse(readJson(TRENDS_FILE, "trends.json"));
    const scored = scoreVideos(videos);
    const clusters = buildClusters(scored);
    const evidence = selectEvidence(scored, clusters);

    emit({ type: "stage", stage: "scripts", status: "start" });
    const scripts: Script[] = await writeScripts({
      profile,
      trendReport,
      evidence,
      maxTrends: Number(values.trends),
      scriptsPerTrend: Number(values["per-trend"]),
      log,
    });
    writeJson(SCRIPTS_FILE, scripts);
    emit({ type: "stage", stage: "scripts", status: "done", detail: `${scripts.length} scripts` });

    const generatedAt = new Date();
    const md = renderReport({ profile, generatedAt, videos: scored, clusters, trendReport, scripts });
    const reportFile = path.join(OUTPUT_DIR, `report-${generatedAt.toISOString().slice(0, 10)}.md`);
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(reportFile, md);
    log(`report → ${path.relative(ROOT, reportFile)} (${scripts.length} scripts, ${trendReport.trends.length} trends)`);
    emit({ type: "report", file: path.relative(ROOT, reportFile), trends: trendReport.trends.length, scripts: scripts.length });
    console.log(`\n${path.relative(ROOT, reportFile)}`);
  }
}

main().catch((err) => {
  console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
