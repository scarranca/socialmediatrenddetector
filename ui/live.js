// Live pipeline stage: renders structured `pipe` events from the server as an animated flow.
// Also replays the last recorded run with compressed timing for demos.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K` : String(Math.round(n ?? 0)));
const PLATFORM = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram" };
const ICON = {
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.8a4.3 4.3 0 0 1-1-2.8h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .8.1V9.7a5.7 5.7 0 1 0 4.9 5.6V9a7.3 7.3 0 0 0 4.3 1.4V7.3a4.3 4.3 0 0 1-3.3-1.5z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>',
};

const STAGES = [
  { id: "collect", title: "Collect", who: "Apify Actors", idle: "TikTok · YouTube · Instagram" },
  { id: "analyze", title: "Score & cluster", who: "Local", idle: "velocity · engagement · outliers" },
  { id: "synthesize", title: "Name the trends", who: "Claude", idle: "reads the evidence sample" },
  { id: "scripts", title: "Write scripts", who: "Claude", idle: "one call per top-fit trend" },
  { id: "report", title: "Report", who: "Markdown + dashboard", idle: "ready to shoot" },
];

const state = {
  mode: null, // "live" | "replay"
  startedAt: 0,
  timer: null,
  tokens: { in: 0, out: 0 },
  counts: { videos: 0, raw: 0, actors: 0, trends: 0, scripts: 0 },
  actors: {}, // platform -> { status, queries, raw, kept }
  tokenTicker: null,
  replayTimers: [],
  onFinished: null,
};

let root;

// ── mount ──────────────────────────────────────────────────────────────────────

export function mount(el, { onFinished } = {}) {
  root = el;
  state.onFinished = onFinished;
  root.innerHTML = `
    <div class="live__head">
      <div class="live__status"><span class="live__dot"></span><strong id="live-title">Pipeline</strong><span class="live__mode" id="live-mode"></span></div>
      <div class="live__clock" id="live-clock">00:00</div>
      <div class="live__actions">
        <button class="btn btn--ghost btn--sm" id="live-replay" type="button" title="Replay the last recorded run at demo speed">Replay last run</button>
        <button class="iconbtn iconbtn--sm" id="live-close" type="button" aria-label="Hide live view"><svg viewBox="0 0 20 20" width="16" height="16"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      </div>
    </div>
    <ol class="flow" id="live-flow">
      ${STAGES.map((s, i) => `
        <li class="node" data-stage="${s.id}">
          <div class="node__top"><span class="node__who">${s.who}</span><span class="node__state" aria-hidden="true"></span></div>
          <div class="node__title">${s.title}</div>
          <div class="node__detail">${s.idle}</div>
          <div class="node__extra"></div>
        </li>
        ${i < STAGES.length - 1 ? `<li class="link" aria-hidden="true"><span class="link__line"></span></li>` : ""}`).join("")}
    </ol>
    <div class="live__body">
      <div class="stream" id="live-stream">
        <div class="stream__hint" id="live-hint">Waiting for the first Actor run…</div>
      </div>
      <pre class="live__log" id="live-log" aria-label="Pipeline log"></pre>
    </div>`;

  $("#live-close", root).addEventListener("click", () => { root.hidden = true; });
  $("#live-replay", root).addEventListener("click", () => replay());
  fetch("/api/replay", { method: "GET" }).then((r) => { if (!r.ok) $("#live-replay", root).hidden = true; }).catch(() => {});
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

export function begin(mode = "live") {
  stopReplay();
  state.mode = mode;
  state.startedAt = Date.now();
  state.tokens = { in: 0, out: 0 };
  state.counts = { videos: 0, raw: 0, actors: 0, trends: 0, scripts: 0 };
  state.actors = {};
  root.hidden = false;
  root.classList.remove("is-done", "is-failed");
  root.classList.add("is-running");
  $("#live-title", root).textContent = mode === "replay" ? "Replaying last run" : "Pipeline running";
  $("#live-mode", root).textContent = mode === "replay" ? "demo speed" : "live";
  $("#live-log", root).textContent = "";
  $("#live-stream", root).innerHTML = `<div class="stream__hint" id="live-hint">Waiting for the first Actor run…</div>`;
  for (const li of root.querySelectorAll(".node")) {
    li.className = "node";
    const s = STAGES.find((x) => x.id === li.dataset.stage);
    $(".node__detail", li).textContent = s.idle;
    $(".node__extra", li).innerHTML = "";
  }
  for (const l of root.querySelectorAll(".link")) l.className = "link";
  clearInterval(state.timer);
  state.timer = setInterval(tick, 250);
  tick();
  root.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function finish(status) {
  clearInterval(state.timer);
  stopTokenTicker();
  root.classList.remove("is-running");
  root.classList.add(status === "done" ? "is-done" : "is-failed");
  $("#live-title", root).textContent = status === "done" ? "Run complete" : "Run failed";
  if (status === "done") {
    const hint = document.createElement("div");
    hint.className = "stream__done";
    hint.innerHTML = `<span><strong>${state.counts.trends} trends · ${state.counts.scripts} scripts</strong> from ${state.counts.kept ?? state.counts.videos} videos in ${$("#live-clock", root).textContent}</span> <button class="btn btn--primary btn--sm" id="live-results" type="button">See results ↓</button>`;
    $("#live-stream", root).prepend(hint);
    $("#live-results", hint).addEventListener("click", () => {
      root.hidden = true;
      document.getElementById("trends")?.scrollIntoView({ behavior: "smooth" });
    });
  }
  state.onFinished?.(status);
}

export function log(line) {
  const el = $("#live-log", root);
  if (!el) return;
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function tick() {
  const s = Math.floor((Date.now() - state.startedAt) / 1000);
  $("#live-clock", root).textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── event handling ─────────────────────────────────────────────────────────────

const node = (id) => root.querySelector(`.node[data-stage="${id}"]`);
const setNode = (id, status, detail, extraHtml) => {
  const li = node(id);
  if (!li) return;
  li.classList.remove("is-active", "is-done", "is-failed");
  if (status) li.classList.add(`is-${status}`);
  if (detail != null) $(".node__detail", li).textContent = detail;
  if (extraHtml != null) $(".node__extra", li).innerHTML = extraHtml;
  // light up the connector leading into an active/done node
  const idx = STAGES.findIndex((s) => s.id === id);
  const links = root.querySelectorAll(".link");
  if (idx > 0 && links[idx - 1]) {
    links[idx - 1].classList.toggle("is-flowing", status === "active");
    links[idx - 1].classList.toggle("is-done", status === "done");
  }
};

export function handle(e) {
  switch (e.type) {
    case "stage": return onStage(e);
    case "actor": return onActor(e);
    case "videos": return onVideos(e);
    case "filter": return onFilter(e);
    case "analyze": return onAnalyze(e);
    case "llm": return onLlm(e);
    case "trend": return onTrend(e);
    case "script": return onScript(e);
    case "report": return onReport(e);
  }
}

function onStage(e) {
  if (e.status === "start") setNode(e.stage, "active", e.stage === "collect" ? `starting · ${e.detail ?? ""}` : "working…");
  else if (e.status === "done") setNode(e.stage, "done", e.detail ?? "done");
  else setNode(e.stage, "failed", e.detail ?? "failed");
}

function onActor(e) {
  state.actors[e.platform] = { ...(state.actors[e.platform] ?? {}), ...e };
  $("#live-hint", root)?.remove();
  const rows = Object.values(state.actors).map((a) => `
    <div class="actor actor--${a.status}">
      <span class="actor__icon">${ICON[a.platform] ?? ""}</span>
      <span class="actor__name">${PLATFORM[a.platform] ?? a.platform}</span>
      <span class="actor__meta">${a.status === "start" ? `scraping ${a.queries?.length ?? ""} queries` : a.status === "done" ? `${a.raw} raw → ${a.kept} kept` : "failed"}</span>
      <span class="actor__state"></span>
    </div>`).join("");
  setNode("collect", "active", `${Object.values(state.actors).filter((a) => a.status === "done").length}/${Object.keys(state.actors).length} Actors finished`, rows);
  if (e.status === "start") {
    pushCard("query", `<span class="card__k">${PLATFORM[e.platform]}</span> searching <b>${esc((e.queries ?? []).slice(0, 4).join(", "))}${(e.queries?.length ?? 0) > 4 ? ` +${e.queries.length - 4}` : ""}</b>`);
  }
  if (e.status === "done") {
    state.counts.raw += e.raw ?? 0;
    state.counts.actors++;
  }
}

function onVideos(e) {
  const items = e.items ?? [];
  state.counts.videos += items.length;
  // Create the row now (so later cards stack above it), then stagger the tiles into it so they read as "landing".
  const row = document.createElement("div");
  row.className = "tiles";
  $("#live-stream", root).prepend(row);
  trimStream();
  items.slice(0, 24).forEach((v, i) => {
    setTimeout(() => {
      if (!row.isConnected) return;
      row.insertAdjacentHTML("beforeend", `
        <a class="tile tile--${e.platform}" href="${esc(v.url)}" target="_blank" rel="noopener">
          <span class="tile__icon">${ICON[e.platform] ?? ""}</span>
          <span class="tile__views">${fmtNum(v.views)}</span>
          <span class="tile__author">@${esc(v.author)}</span>
          <span class="tile__cap">${esc(v.caption)}</span>
        </a>`);
    }, i * 70);
  });
}

function onFilter(e) {
  state.counts.kept = e.kept;
  const dropped = e.droppedViews + e.droppedOld + e.droppedDup;
  pushCard("filter", `Kept <b>${e.kept}</b> videos${dropped ? ` · filtered ${dropped} (${e.droppedViews} low views, ${e.droppedOld} too old, ${e.droppedDup} dupes)` : ""}`);
}

function onAnalyze(e) {
  setNode("analyze", "active", `${e.scored} scored · ${e.clusters} clusters · ${e.evidence} evidence`);
  pushCard("clusters", `<span class="card__k">Clusters</span> ${e.topClusters.map((c) => `<span class="chip-sm">${esc(c)}</span>`).join("")}`);
}

function onLlm(e) {
  const stage = e.phase === "trends" ? "synthesize" : "scripts";
  if (e.status === "start") {
    startTokenTicker(stage, e.label);
    setNode(stage, "active", e.phase === "trends" ? "reading the evidence…" : `writing · ${e.label?.replace(/^writeScripts\[|\]$/g, "") ?? ""}`);
  } else if (e.status === "done") {
    stopTokenTicker();
    state.tokens.in += e.inTokens ?? 0;
    state.tokens.out += e.outTokens ?? 0;
    setNode(stage, "active", undefined, tokenHtml(e.model));
  } else {
    stopTokenTicker();
    pushCard("error", `Claude call failed: ${esc(e.message ?? "")}`);
  }
}

function onTrend(e) {
  state.counts.trends++;
  setNode("synthesize", "active", `${state.counts.trends} trends named`, tokenHtml());
  pushCard("trend", `
    <span class="card__k">Trend ${String(state.counts.trends).padStart(2, "0")}</span>
    <b>${esc(e.name)}</b>
    <span class="mom mom--${esc(e.momentum)}">${esc(e.momentum)}</span>
    <span class="fit">${e.fit}<small>/10</small></span>
    <span class="card__sub">${esc(e.format)}</span>`);
}

function onScript(e) {
  state.counts.scripts++;
  setNode("scripts", "active", `${state.counts.scripts} scripts written`, tokenHtml());
  pushCard("script", `<span class="card__k">Script</span> <b>${esc(e.title)}</b><span class="card__sub">${esc(e.trendName)} · ${esc(e.format)} · ${e.durationSec}s</span>`);
}

function onReport(e) {
  setNode("report", "done", `${e.trends} trends · ${e.scripts} scripts`);
}

// ── token ticker (Claude "thinking" feedback) ──────────────────────────────────

function tokenHtml(model) {
  return `<div class="tokens"><span>${fmtNum(state.tokens.in)} in</span><span>${fmtNum(state.tokens.out)} out</span>${model ? `<span class="tokens__model">${esc(model)}</span>` : ""}</div>`;
}

function startTokenTicker(stage, label) {
  stopTokenTicker();
  const li = node(stage);
  const start = Date.now();
  state.tokenTicker = setInterval(() => {
    const s = ((Date.now() - start) / 1000).toFixed(1);
    $(".node__extra", li).innerHTML = `<div class="tokens tokens--live"><span class="thinking"><i></i><i></i><i></i></span><span>thinking · ${s}s</span></div>`;
  }, 100);
}
function stopTokenTicker() { clearInterval(state.tokenTicker); state.tokenTicker = null; }

// ── stream helpers ─────────────────────────────────────────────────────────────

function pushCard(kind, html) {
  const el = document.createElement("div");
  el.className = `card card--${kind}`;
  el.innerHTML = html;
  $("#live-stream", root).prepend(el);
  trimStream();
}

function trimStream() {
  const s = $("#live-stream", root);
  while (s.children.length > 40) s.lastElementChild.remove();
}

// ── replay ─────────────────────────────────────────────────────────────────────

export async function replay({ targetMs = null, autoResults = false } = {}) {
  const res = await fetch("/api/replay");
  if (!res.ok) return;
  const rec = await res.json();
  begin("replay");
  log(`replaying run recorded ${new Date(rec.recordedAt).toLocaleString()} (${Math.round(rec.durationMs / 1000)}s → demo speed)`);
  // Demo pacing: keep the order, compress the long waits (Actor runs, Claude calls) and stretch the
  // bursts (Claude returns all trends/scripts at once) so each beat is readable. Lands around 40–50 s.
  const events = rec.events;
  const MIN_GAP = { trend: 850, script: 700, videos: 1700, analyze: 900, filter: 700, report: 900, stage: 450 };
  let prev = 0;
  const gaps = events.map(({ t: at, e }) => {
    let gap = Math.min(Math.max(at - prev, 150), 2200);
    // a finished Actor / Claude call should visibly "work" for a moment before resolving
    if ((e.type === "actor" || e.type === "llm") && e.status !== "start") gap = Math.max(gap, 2400);
    gap = Math.max(gap, MIN_GAP[e.type] ?? 0);
    prev = at;
    return gap;
  });
  // Optionally fit the whole thing to a fixed length (e.g. a 30 s demo slot).
  const total = gaps.reduce((a, b) => a + b, 0);
  const scale = targetMs ? (targetMs - 600) / total : 1;
  let t = 0;
  events.forEach(({ e }, i) => {
    t += gaps[i] * scale;
    state.replayTimers.push(setTimeout(() => { handle(e); log(describe(e)); }, t));
  });
  state.replayTimers.push(setTimeout(() => finish("done"), t + 600));
  if (autoResults) {
    // hold on the "Run complete" frame, then glide down to what the run produced
    state.replayTimers.push(setTimeout(() => document.getElementById("trends")?.scrollIntoView({ behavior: "smooth", block: "start" }), t + 3200));
  }
}

function describe(e) {
  switch (e.type) {
    case "stage": return `▸ ${e.stage} ${e.status}${e.detail ? ` — ${e.detail}` : ""}`;
    case "actor": return e.status === "start" ? `[${e.platform}] ${e.actorId} started · ${e.queries?.length ?? 0} queries` : e.status === "done" ? `[${e.platform}] ${e.raw} raw items → ${e.kept} normalized` : `[${e.platform}] failed: ${e.message}`;
    case "videos": return `[${e.platform}] top: ${(e.items ?? []).slice(0, 3).map((v) => `@${v.author} ${fmtNum(v.views)}`).join(", ")}`;
    case "filter": return `kept ${e.kept} · dropped ${e.droppedViews} low-views, ${e.droppedOld} old, ${e.droppedDup} dupes`;
    case "analyze": return `scored ${e.scored} · ${e.clusters} clusters · ${e.evidence} evidence videos → Claude`;
    case "llm": return e.status === "start" ? `claude ← ${e.label}` : e.status === "done" ? `claude → ${e.inTokens} in / ${e.outTokens} out (${e.model})` : `claude ✗ ${e.message}`;
    case "trend": return `  trend: ${e.name} [${e.momentum}, fit ${e.fit}/10]`;
    case "script": return `  script: ${e.title} (${e.durationSec}s)`;
    case "report": return `report → ${e.file}`;
    default: return e.type;
  }
}

function stopReplay() {
  for (const id of state.replayTimers) clearTimeout(id);
  state.replayTimers = [];
}
