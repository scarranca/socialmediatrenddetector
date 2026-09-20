/**
 * Local dashboard server: serves ui/ and exposes the pipeline's JSON output.
 *
 *   GET  /api/data     scored videos, clusters, stats, trends, scripts, profile
 *   POST /api/run      spawn the pipeline (`run` or `run --sample`); one at a time
 *   GET  /api/logs     Server-Sent Events stream: `log` lines, `pipe` structured events, `status`
 *   GET  /api/replay   the last recorded run's structured events (with ms offsets) for UI replay
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { buildClusters, scoreVideos, summarizeStats } from "./analyze.ts";
import { DATA_DIR, OUTPUT_DIR, ROOT, SAMPLE_DATA_DIR, loadProfile } from "./config.ts";
import type { Script, TrendReport, Video } from "./types.ts";

const PORT = Number(process.env.PORT ?? 4173);
const UI_DIR = path.join(ROOT, "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function readJsonOr<T>(file: string, fallback: T): { value: T; mtime: string | null } {
  if (!existsSync(file)) return { value: fallback, mtime: null };
  return { value: JSON.parse(readFileSync(file, "utf8")) as T, mtime: statSync(file).mtime.toISOString() };
}

const DEMO_DATA_DIR = path.join(ROOT, "fixtures", "demo-data");

function buildPayload() {
  const profile = loadProfile();
  // Until the first run, show the bundled results of a recorded real run so a fresh clone isn't empty.
  // After a dry run, show its results (kept in data/sample) until the next real run or a restart.
  const sample = viewingSample && existsSync(path.join(SAMPLE_DATA_DIR, "videos.json"));
  const demo = !sample && !existsSync(path.join(DATA_DIR, "videos.json"));
  const dir = sample ? SAMPLE_DATA_DIR : demo ? DEMO_DATA_DIR : DATA_DIR;
  const videosFile = readJsonOr<Video[]>(path.join(dir, "videos.json"), []);
  const trends = readJsonOr<TrendReport | null>(path.join(dir, "trends.json"), null);
  const scripts = readJsonOr<Script[]>(path.join(dir, "scripts.json"), []);
  // Demo data is scored as of its recording date so velocity/age don't decay as the fixture gets older.
  const asOf = demo ? readJsonOr<{ asOf?: string }>(path.join(dir, "meta.json"), {}).value.asOf ?? null : null;
  const videos = scoreVideos(videosFile.value, asOf ? new Date(asOf) : undefined);
  return {
    profile,
    generatedAt: scripts.mtime ?? trends.mtime ?? videosFile.mtime,
    videos,
    clusters: buildClusters(videos),
    stats: summarizeStats(videos),
    trendReport: trends.value,
    scripts: scripts.value,
    demo,
    sample,
    asOf,
    running: current !== null,
  };
}

// ---- pipeline runner + SSE fan-out -------------------------------------------------------------

let current: ChildProcess | null = null;
let viewingSample = false;
const clients = new Set<ServerResponse>();
const recent: string[] = []; // log replay buffer for late-joining clients
const recentPipe: string[] = []; // structured events of the run in progress (raw JSON strings)
let runStartedAt = 0;
const REPLAY_FILE = path.join(DATA_DIR, "last-run-events.json");
const EVENT_PREFIX = "::event::";

function broadcast(event: string, data: string) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (event === "log") {
    recent.push(data);
    if (recent.length > 200) recent.shift();
  }
  for (const res of clients) res.write(frame);
}

/** Structured event from the child: fan out on the `pipe` channel and record it for replay. */
function onPipeEvent(raw: string) {
  recentPipe.push(raw);
  const frame = `event: pipe\ndata: ${raw}\n\n`;
  for (const res of clients) res.write(frame);
  replayBuffer.push({ t: Date.now() - runStartedAt, e: JSON.parse(raw) });
}
let replayBuffer: Array<{ t: number; e: unknown }> = [];

function startRun(sample: boolean) {
  if (current) return false;
  recent.length = 0;
  recentPipe.length = 0;
  replayBuffer = [];
  runStartedAt = Date.now();
  const args = ["--env-file-if-exists=.env", "src/index.ts", "run", ...(sample ? ["--sample"] : [])];
  broadcast("status", "running");
  broadcast("log", `$ tsx ${args.join(" ")}`);
  const child = spawn("npx", ["tsx", ...args], { cwd: ROOT, env: { ...process.env, TD_EVENTS: "1" } });
  current = child;
  let carry = ""; // stderr chunks can split a line; reassemble before parsing
  const onData = (chunk: Buffer) => {
    const text = carry + chunk.toString();
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          onPipeEvent(line.slice(EVENT_PREFIX.length));
        } catch {
          broadcast("log", line);
        }
      } else if (line.trim() && !line.includes("not found. Continuing without it")) {
        broadcast("log", line);
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    if (carry.trim()) onData(Buffer.from("\n"));
    current = null;
    broadcast("log", `— exited with code ${code}`);
    if (code === 0) viewingSample = sample;
    broadcast("status", code === 0 ? "done" : "failed");
    // Only real runs become the replay recording; a dry run must not replace it.
    if (code === 0 && !sample && replayBuffer.length) {
      try {
        writeFileSync(REPLAY_FILE, JSON.stringify({ recordedAt: new Date().toISOString(), sample, durationMs: Date.now() - runStartedAt, events: replayBuffer }));
      } catch (err) {
        console.error("could not save replay:", err);
      }
    }
  });
  return true;
}

// ---- http ----------------------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  // "/test" and "/demo" are the same page; the client auto-plays the recorded run there.
  const rel = urlPath === "/" || urlPath === "/test" || urlPath === "/demo" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/data" && req.method === "GET") {
    try {
      json(res, 200, buildPayload());
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === "/api/report" && req.method === "GET") {
    // Latest markdown report, served as plain text so the browser renders it inline.
    const reports = existsSync(OUTPUT_DIR)
      ? readdirSync(OUTPUT_DIR).filter((f) => f.startsWith("report-") && f.endsWith(".md")).sort()
      : [];
    const latest = reports.at(-1);
    if (!latest) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No report yet — run the pipeline first.");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    createReadStream(path.join(OUTPUT_DIR, latest)).pipe(res);
    return;
  }

  if (url.pathname === "/api/replay" && req.method === "GET") {
    // Latest recorded run, falling back to the bundled demo recording on a fresh clone.
    const file = [REPLAY_FILE, path.join(ROOT, "fixtures", "demo-run-events.json")].find((f) => existsSync(f));
    if (!file) {
      json(res, 404, { error: "No recorded run yet." });
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === "/api/run" && req.method === "POST") {
    const sample = url.searchParams.get("sample") === "1";
    const started = startRun(sample);
    json(res, started ? 202 : 409, { started, running: true });
    return;
  }

  if (url.pathname === "/api/logs" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(current ? "running" : "idle")}\n\n`);
    for (const line of recent) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    for (const raw of recentPipe) res.write(`event: pipe\ndata: ${raw}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  serveStatic(req, res, url.pathname);
});

// If the port is taken (usually a previous `npm run ui` still running), walk up to the next free one
// instead of crashing with an unhandled EADDRINUSE.
let port = PORT;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && port < PORT + 10) {
    console.error(`port ${port} is in use (another \`npm run ui\`? stop it with: lsof -ti :${port} | xargs kill) — trying ${port + 1}`);
    port += 1;
    server.listen(port);
    return;
  }
  console.error(`could not start the dashboard server: ${err.message}`);
  process.exit(1);
});
server.on("listening", () => {
  console.log(`trend-detector UI → http://localhost:${port}`);
});
server.listen(port);
