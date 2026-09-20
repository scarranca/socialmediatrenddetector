// Trend Detector dashboard — vanilla JS, no build step.
import * as Live from "/live.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = {
  num(n) {
    if (n == null || !Number.isFinite(n)) return "–";
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return String(Math.round(n));
  },
  pct(r, d = 1) { return r == null || !Number.isFinite(r) ? "–" : `${(r * 100).toFixed(d)}%`; },
  x(n) { return n == null || !Number.isFinite(n) ? "–" : n >= 100 ? `${Math.round(n)}×` : `${n.toFixed(1)}×`; },
  date(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"; },
  ago(iso) {
    if (!iso) return "—";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  },
};

const ICON = {
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.8a4.3 4.3 0 0 1-1-2.8h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .8.1V9.7a5.7 5.7 0 1 0 4.9 5.6V9a7.3 7.3 0 0 0 4.3 1.4V7.3a4.3 4.3 0 0 1-3.3-1.5z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>',
};
const PLATFORM_LABEL = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram" };

const state = { data: null, trendFilter: "all", platformFilter: "all", selectedTrend: null, selectedScript: 0 };

// ── data ───────────────────────────────────────────────────────────────────────

async function load() {
  const res = await fetch("/api/data");
  if (!res.ok) throw new Error(`API ${res.status}`);
  state.data = await res.json();
  render();
}

function render() {
  const d = state.data;
  const hasRun = d.videos.length > 0 && d.trendReport;
  $("#empty").hidden = hasRun;
  $("#scope-industry").textContent = d.profile.industry;
  $("#foot-profile").textContent = `${d.profile.name} · ${d.profile.handle} · ${d.profile.language}`;
  $("#updated-pill").textContent = d.demo ? "Demo data · run the pipeline for yours" : d.sample ? "Dry-run data · your real results are untouched" : `Updated ${fmt.ago(d.generatedAt)}`;
  $("#window-pill").lastChild.textContent = ` Last ${d.profile.collection.lookbackDays} days`;
  $("#btn-report").href = "/api/report";
  setRunning(d.running);

  renderHero(d);
  renderKpis(d);
  renderTrends(d);
  renderVideos(d);
  renderSignals(d);
}

// ── hero ───────────────────────────────────────────────────────────────────────

function renderHero(d) {
  const overview = d.trendReport?.overview ?? "";
  const twoSentences = overview.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  $("#hero-overview").textContent = twoSentences || `Run the pipeline to analyze ${d.profile.industry}.`;

  const counts = d.stats.byPlatform ?? {};
  $("#platform-chips").innerHTML = ["tiktok", "youtube", "instagram"]
    .map((p) => {
      const n = counts[p] ?? 0;
      const on = d.profile.platforms.includes(p);
      return `<span class="chip ${on ? "" : "chip--off"}" title="${PLATFORM_LABEL[p]}">${ICON[p]}<span>${PLATFORM_LABEL[p]}</span><b>${on ? n : "off"}</b></span>`;
    })
    .join("");

  renderWeeklyChart(d);

  const totalViews = d.videos.reduce((a, v) => a + v.views, 0);
  const trendsN = d.trendReport?.trends.length ?? 0;
  const emerging = d.trendReport?.trends.filter((t) => t.momentum === "emerging").length ?? 0;
  $("#float-stats").innerHTML = `
    <div class="float__cell"><div class="label">Videos analyzed</div><div class="value">${d.stats.count}<span class="delta delta--flat">${Object.keys(counts).length} sources</span></div></div>
    <div class="float__cell"><div class="label">Trends found</div><div class="value">${trendsN}${emerging ? `<span class="delta">${emerging} emerging</span>` : ""}</div></div>
    <div class="float__cell float__cell--wide"><span class="label">Total views</span><span class="value">${fmt.num(totalViews)}</span></div>
    <div class="float__cell float__cell--wide"><span class="label">Scripts ready</span><span class="value">${d.scripts.length}</span></div>`;
}

/** Stepped, dotted-gradient area chart of weekly views. */
function renderWeeklyChart(d) {
  const lookback = d.profile.collection.lookbackDays;
  const weeks = Math.max(3, Math.min(6, Math.ceil(lookback / 7)));
  const now = d.asOf ? Date.parse(d.asOf) : Date.now();
  const buckets = Array.from({ length: weeks }, () => ({ views: 0, n: 0 }));
  for (const v of d.videos) {
    if (!v.publishedAt) continue;
    const age = (now - Date.parse(v.publishedAt)) / 86400e3;
    const idx = weeks - 1 - Math.min(weeks - 1, Math.floor(age / 7));
    if (idx >= 0) { buckets[idx].views += v.views; buckets[idx].n++; }
  }
  // Size the viewBox to the element so text and dots render at 1:1 instead of stretching.
  const host = $("#weekly-chart");
  const W = Math.max(320, host.clientWidth - 22 || 640), H = Math.max(200, host.clientHeight || 340);
  const padT = 46, padB = 14, padX = 10;
  const max = Math.max(1, ...buckets.map((b) => b.views));
  const colW = (W - padX * 2) / weeks;
  const gap = 8;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);

  const bars = buckets.map((b, i) => {
    const x = padX + i * colW + gap / 2;
    const w = colW - gap;
    const top = y(b.views);
    const bottom = H - padB;
    return { x, w, top, bottom, b };
  });

  // outline path stepping across the tops of the bars (the "staircase" look)
  let outline = "";
  bars.forEach((r, i) => {
    outline += i === 0 ? `M${r.x},${r.top} ` : `L${r.x},${r.top} `;
    outline += `L${r.x + r.w},${r.top} `;
  });

  const svg = `
  <svg viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="g-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="oklch(0.72 0.13 250)" stop-opacity="0.95"/>
        <stop offset="1" stop-color="oklch(0.86 0.08 180)" stop-opacity="0.85"/>
      </linearGradient>
      <pattern id="p-dots" width="7" height="7" patternUnits="userSpaceOnUse">
        <circle cx="3.5" cy="3.5" r="1" fill="white" fill-opacity="0.55"/>
      </pattern>
    </defs>
    <line x1="${padX}" x2="${W - padX}" y1="${H - padB}" y2="${H - padB}" stroke="oklch(0.85 0.005 250)" stroke-width="1.5" stroke-linecap="round"/>
    ${bars.map((r) => `
      <g class="bar" style="--i:${bars.indexOf(r)}">
        <rect x="${r.x}" y="${r.top}" width="${r.w}" height="${Math.max(0, r.bottom - r.top)}" fill="url(#g-fill)" rx="3"/>
        <rect x="${r.x}" y="${r.top}" width="${r.w}" height="${Math.max(0, r.bottom - r.top)}" fill="url(#p-dots)" rx="3"/>
      </g>`).join("")}
    <path d="${outline}" fill="none" stroke="oklch(0.9 0.004 250)" stroke-width="10" stroke-linejoin="round" opacity="0.9"/>
    <path d="${outline}" fill="none" stroke="white" stroke-width="6" stroke-linejoin="round"/>
    ${bars.map((r) => `
      <circle cx="${r.x + r.w / 2}" cy="${r.top}" r="6" fill="white" stroke="oklch(0.72 0.13 250)" stroke-width="2.5"/>
      <text x="${r.x + r.w / 2}" y="${r.top - 16}" text-anchor="middle" font-size="15" font-weight="500" fill="oklch(0.3 0.01 260)">${r.b.n ? fmt.num(r.b.views) : ""}</text>`).join("")}
  </svg>`;
  $("#weekly-chart").innerHTML = svg;
  $("#axis-start").textContent = fmt.date(new Date(now - weeks * 7 * 86400e3).toISOString());
  $("#axis-end").textContent = fmt.date(new Date(now).toISOString());
}

// ── KPIs ───────────────────────────────────────────────────────────────────────

function renderKpis(d) {
  const vids = d.videos;
  const byPlat = {};
  for (const v of vids) (byPlat[v.platform] ??= []).push(v);
  const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const platMedianER = Object.entries(byPlat).map(([p, xs]) => [p, median(xs.map((v) => v.engagementRate))]).sort((a, b) => b[1] - a[1]);

  const er = d.stats.medianEngagementRate;
  const outliers = vids.filter((v) => v.outlierFactor != null);
  const outlierShare = outliers.length ? outliers.filter((v) => v.outlierFactor > 1).length / outliers.length : null;
  const big = outliers.filter((v) => v.outlierFactor >= 10).length;
  const vpd = median(vids.map((v) => v.viewsPerDay));
  const topVpd = Math.max(0, ...vids.map((v) => v.viewsPerDay));

  const cards = [
    {
      label: "Median engagement rate",
      value: fmt.pct(er),
      delta: platMedianER.length > 1 ? `<span class="delta">${PLATFORM_LABEL[platMedianER[0][0]]} ${fmt.pct(platMedianER[0][1])}</span>` : "",
      sub: `likes + comments + shares + saves ÷ views · ${vids.length} videos`,
      spark: sparkBars(vids.map((v) => v.engagementRate).sort((a, b) => a - b), { highlightMedian: true }),
    },
    {
      label: "Escaped their audience",
      value: fmt.pct(outlierShare, 0),
      delta: big ? `<span class="delta">${big} at 10×+</span>` : "",
      sub: `share of videos with more views than the creator has followers (${outliers.length} with known follower counts)`,
      spark: sparkWave(outliers.map((v) => Math.log10(1 + v.outlierFactor)).sort((a, b) => a - b)),
    },
    {
      label: "Median velocity",
      value: `${fmt.num(vpd)}<span style="font-size:20px;color:var(--ink-3);font-weight:500;margin-left:6px">/day</span>`,
      delta: topVpd ? `<span class="delta delta--warm">peak ${fmt.num(topVpd)}/day</span>` : "",
      sub: "views per day since posting — how fast the sample is moving",
      spark: sparkGrid(vids.slice().sort((a, b) => Date.parse(a.publishedAt ?? 0) - Date.parse(b.publishedAt ?? 0)).map((v) => Math.log10(1 + v.viewsPerDay))),
    },
  ];
  $("#kpis").innerHTML = cards.map((c) => `
    <article class="kpi">
      <div class="kpi__label">${c.label}</div>
      <div class="kpi__value"><span class="kpi__num">${c.value}</span>${c.delta}</div>
      <div class="kpi__sub">${c.sub}</div>
      <div class="kpi__spark">${c.spark}</div>
    </article>`).join("");
}

/** Thin vertical bars (like an equalizer); optional median highlight. */
function sparkBars(values, { highlightMedian = false } = {}) {
  const n = Math.min(values.length, 64);
  const step = values.length / n;
  const pts = Array.from({ length: n }, (_, i) => values[Math.floor(i * step)]);
  const max = Math.max(1e-9, ...pts);
  const W = 400, H = 56, bw = 3, g = (W - n * bw) / Math.max(1, n - 1);
  const mid = Math.floor(n / 2);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${pts.map((v, i) => {
    const h = Math.max(4, (v / max) * H);
    const hot = highlightMedian && i === mid;
    return `<rect x="${i * (bw + g)}" y="${H - h}" width="${bw}" height="${h}" rx="1.5" fill="${hot ? "var(--red)" : i >= mid ? "var(--green)" : "var(--line-strong)"}"/>`;
  }).join("")}</svg>`;
}

/** Symmetric wave of thin bars — reads as a distribution. */
function sparkWave(values) {
  const n = Math.min(values.length, 90);
  if (!n) return "";
  const step = values.length / n;
  const pts = Array.from({ length: n }, (_, i) => values[Math.floor(i * step)]);
  const max = Math.max(1e-9, ...pts);
  const W = 400, H = 56, bw = 2.2, g = (W - n * bw) / Math.max(1, n - 1);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${pts.map((v, i) => {
    const h = Math.max(3, (v / max) * H);
    const y = (H - h) / 2;
    return `<rect x="${i * (bw + g)}" y="${y}" width="${bw}" height="${h}" rx="1" fill="${v > Math.log10(2) ? "var(--green)" : "var(--line-strong)"}"/>`;
  }).join("")}</svg>`;
}

/** Stacked square blocks per column — the "brick" sparkline. */
function sparkGrid(values) {
  const n = Math.min(values.length, 56);
  if (!n) return "";
  const step = values.length / n;
  const pts = Array.from({ length: n }, (_, i) => values[Math.floor(i * step)]);
  const max = Math.max(1e-9, ...pts);
  const rows = 6, W = 400, H = 56, cell = H / rows, bw = 4.5, g = (W - n * bw) / Math.max(1, n - 1);
  let out = "";
  pts.forEach((v, i) => {
    const lit = Math.max(1, Math.round((v / max) * rows));
    for (let r = 0; r < rows; r++) {
      const on = r < lit;
      out += `<rect x="${i * (bw + g)}" y="${H - (r + 1) * cell + 1}" width="${bw}" height="${cell - 2}" rx="1" fill="${on ? "var(--green)" : "var(--gray-bg)"}" opacity="${on ? 0.55 + 0.45 * (r / rows) : 1}"/>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${out}</svg>`;
}

// ── trends ─────────────────────────────────────────────────────────────────────

function sortedTrends(d) {
  return (d.trendReport?.trends ?? []).slice().sort((a, b) => b.fitForProfile - a.fitForProfile);
}

function renderTrends(d) {
  const all = sortedTrends(d);
  const list = all.filter((t) => state.trendFilter === "all" || t.momentum === state.trendFilter);
  if (state.selectedTrend == null || !list.some((t) => t.name === state.selectedTrend)) {
    const withScripts = list.find((t) => d.scripts.some((s) => s.trendName === t.name)) ?? list[0];
    state.selectedTrend = withScripts?.name ?? null;
    state.selectedScript = 0;
  }
  $("#trend-list").innerHTML = list.length
    ? list.map((t) => {
        const rank = all.indexOf(t) + 1;
        const nScripts = d.scripts.filter((s) => s.trendName === t.name).length;
        const sel = t.name === state.selectedTrend;
        return `
      <li>
        <button class="trend ${sel ? "is-selected" : ""}" data-trend="${esc(t.name)}" aria-pressed="${sel}">
          <span class="trend__rank">${String(rank).padStart(2, "0")}</span>
          <span>
            <div class="trend__name">${esc(t.name)}</div>
            <div class="trend__meta">
              <span class="mom mom--${t.momentum}">${t.momentum}</span>
              <span>${esc(t.format)}</span>
              ${t.signals.typicalDurationSec ? `<span>~${Math.round(t.signals.typicalDurationSec)}s</span>` : ""}
              ${nScripts ? `<span>${nScripts} script${nScripts > 1 ? "s" : ""}</span>` : ""}
            </div>
            <p class="trend__summary">${esc(t.summary)}</p>
          </span>
          <span class="trend__fit"><div class="n">${t.fitForProfile}<small>/10</small></div><div class="fitbar"><i style="width:${t.fitForProfile * 10}%"></i></div></span>
        </button>
      </li>`;
      }).join("")
    : `<li class="script--empty">No ${esc(state.trendFilter)} trends in this run.</li>`;

  renderScripts(d);
}

function renderScripts(d) {
  const trend = sortedTrends(d).find((t) => t.name === state.selectedTrend);
  const scripts = trend ? d.scripts.filter((s) => s.trendName === trend.name) : [];
  const sub = $("#scripts-sub");
  const tabs = $("#script-tabs");
  const view = $("#script-view");

  if (!trend) { sub.textContent = "Pick a trend on the left."; tabs.innerHTML = ""; view.innerHTML = ""; return; }
  sub.textContent = scripts.length ? `${scripts.length} script${scripts.length > 1 ? "s" : ""} for “${trend.name}”` : `No scripts were written for “${trend.name}” — it ranked below the cutoff. Re-run with --trends to include more.`;

  tabs.innerHTML = scripts.map((s, i) => `<button class="tab ${i === state.selectedScript ? "is-active" : ""}" data-script="${i}" role="tab" aria-selected="${i === state.selectedScript}">${esc(s.format)} · ${s.durationSec}s</button>`).join("");

  const s = scripts[state.selectedScript] ?? scripts[0];
  if (!s) {
    view.innerHTML = `
      <div class="hook"><div class="hook__k">Hook pattern seen in the wild</div><div class="hook__q">${esc(trend.hookPattern)}</div></div>
      <p class="why">${esc(trend.summary)}</p>
      ${evidenceList(d, trend)}`;
    return;
  }
  const byId = new Map(d.videos.map((v) => [v.id, v]));
  view.innerHTML = `
    <h3 class="script__title">${esc(s.title)}</h3>
    <div class="script__meta">
      <span class="meta">${s.platform === "all" ? "All platforms" : PLATFORM_LABEL[s.platform]}</span>
      <span class="meta">${esc(s.format)}</span>
      <span class="meta">${s.durationSec}s</span>
      ${s.soundSuggestion ? `<span class="meta" title="${esc(s.soundSuggestion)}">♪ ${esc(s.soundSuggestion.length > 40 ? s.soundSuggestion.slice(0, 39) + "…" : s.soundSuggestion)}</span>` : ""}
    </div>
    <div class="hook"><div class="hook__k">Hook · first 3 seconds</div><div class="hook__q">${esc(s.hook)}</div></div>
    <div class="beats">
      ${s.beats.map((b) => `<div class="beat"><div class="beat__t">${esc(b.t)}</div><div><div class="beat__say">${esc(b.say)}</div><div class="beat__show"><b>Show</b> ${esc(b.show)}</div></div></div>`).join("")}
    </div>
    <div class="kv"><div class="kv__row"><span class="kv__k">CTA</span><span>${esc(s.cta)}</span></div></div>
    <div class="caption"><button class="copy" data-copy="${esc(`${s.caption}\n\n${s.hashtags.map((h) => "#" + h.replace(/^#/, "")).join(" ")}`)}">Copy caption</button>${esc(s.caption)}</div>
    <div class="tags">${s.hashtags.map((h) => `<span class="tag">#${esc(h.replace(/^#/, ""))}</span>`).join("")}</div>
    <p class="why">${esc(s.whyThisWorks)}</p>
    ${evidenceList(d, trend, byId)}`;
}

function evidenceList(d, trend, byId = new Map(d.videos.map((v) => [v.id, v]))) {
  const rows = trend.evidenceVideoIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 5);
  if (!rows.length) return "";
  return `<div class="evidence"><h4>Evidence in the sample</h4>${rows.map((v) => `
    <a href="${esc(v.url)}" target="_blank" rel="noopener">
      <span class="ev__stat">${fmt.num(v.views)}</span>
      <span class="ev__cap">@${esc(v.author)} · ${esc(v.caption.replace(/\s+/g, " "))}</span>
    </a>`).join("")}</div>`;
}

// ── videos ─────────────────────────────────────────────────────────────────────

function renderVideos(d) {
  const rows = d.videos.filter((v) => state.platformFilter === "all" || v.platform === state.platformFilter).slice(0, 15);
  $("#video-table tbody").innerHTML = rows.length
    ? rows.map((v, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        <td><div class="vid"><span class="plat" title="${PLATFORM_LABEL[v.platform]}">${ICON[v.platform]}</span>
          <div class="vid__text"><div class="vid__author"><a href="${esc(v.url)}" target="_blank" rel="noopener">@${esc(v.author)}</a> <span style="color:var(--ink-3);font-weight:500">· ${fmt.date(v.publishedAt)}${v.durationSec ? ` · ${v.durationSec}s` : ""}</span></div>
          <div class="vid__cap">${esc(v.caption.replace(/\s+/g, " ")) || "—"}</div></div></div></td>
        <td class="num">${fmt.num(v.views)}</td>
        <td class="num">${fmt.pct(v.engagementRate)}</td>
        <td class="num">${fmt.num(v.viewsPerDay)}</td>
        <td class="num ${v.outlierFactor > 1 ? "outl--hot" : "outl"}">${fmt.x(v.outlierFactor)}</td>
        <td class="num"><span class="scorepill ${v.score >= 75 ? "scorepill--hot" : ""}">${Math.round(v.score)}</span></td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="script--empty">No ${PLATFORM_LABEL[state.platformFilter] ?? ""} videos in this run.</td></tr>`;
}

// ── signals ────────────────────────────────────────────────────────────────────

function renderSignals(d) {
  const top = d.clusters.slice(0, 18);
  const max = Math.max(1, ...top.map((c) => c.totalViews));
  const prefix = { hashtag: "#", sound: "♪", keyword: "🔍" };
  $("#signal-list").innerHTML = top.map((c) => `
    <div class="sig">
      <div>
        <div class="sig__k"><small>${prefix[c.kind]}</small>${esc(c.kind === "sound" ? c.key.replace(/\s*\[.*\]$/, "") : c.key)}</div>
        <div class="sig__bar"><i style="width:${Math.max(3, (c.totalViews / max) * 100)}%"></i></div>
      </div>
      <div class="sig__v"><b>${fmt.num(c.totalViews)}</b> views<br>${c.videoIds.length} videos · ${fmt.pct(c.medianEngagementRate)}</div>
    </div>`).join("");
}

// ── pipeline runner ────────────────────────────────────────────────────────────

let es = null;
function setRunning(running) {
  for (const b of [$("#btn-run"), $("#btn-sample")]) b.disabled = running;
  $("#btn-run").lastChild.textContent = running ? " Running…" : " Run pipeline";
}

function openDrawer() {
  const drawer = $("#drawer");
  drawer.hidden = false;
  if (es) return;
  es = new EventSource("/api/logs");
  const log = $("#drawer-log");
  es.addEventListener("log", (e) => {
    const line = JSON.parse(e.data);
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
    Live.log(line);
  });
  es.addEventListener("pipe", (e) => Live.handle(JSON.parse(e.data)));
  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    $("#drawer-dot").className = `dot dot--${s}`;
    $("#drawer-title").textContent = { running: "Pipeline running", done: "Pipeline finished", failed: "Pipeline failed", idle: "Pipeline" }[s] ?? "Pipeline";
    setRunning(s === "running");
    if (s === "done" || s === "failed") Live.finish(s);
    if (s === "done") load().catch(console.error);
  });
}

async function run(sample) {
  $("#drawer-log").textContent = "";
  Live.begin("live");
  openDrawer();
  $("#drawer").hidden = true; // the live stage shows the log; the drawer stays available via the status pill
  const res = await fetch(`/api/run?sample=${sample ? 1 : 0}`, { method: "POST" });
  if (res.status === 409) $("#drawer-log").textContent += "A run is already in progress.\n";
}

// ── events ─────────────────────────────────────────────────────────────────────

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-trend], [data-script], [data-filter], [data-platform], [data-copy], [data-action], #btn-run, #btn-sample, #btn-replay, #drawer-close");
  if (!t) return;
  if (t.dataset.trend != null) { state.selectedTrend = t.dataset.trend; state.selectedScript = 0; renderTrends(state.data); return; }
  if (t.dataset.script != null) { state.selectedScript = Number(t.dataset.script); renderScripts(state.data); return; }
  if (t.dataset.filter) { state.trendFilter = t.dataset.filter; $$("#momentum-tabs .tab").forEach((b) => { const on = b === t; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", on); }); renderTrends(state.data); return; }
  if (t.dataset.platform) { state.platformFilter = t.dataset.platform; $$("#platform-tabs .tab").forEach((b) => { const on = b === t; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", on); }); renderVideos(state.data); return; }
  if (t.dataset.copy != null) {
    await navigator.clipboard.writeText(t.dataset.copy);
    t.textContent = "Copied"; t.classList.add("is-done");
    setTimeout(() => { t.textContent = "Copy caption"; t.classList.remove("is-done"); }, 1400);
    return;
  }
  if (t.id === "btn-run" || t.dataset.action === "run") { $("#empty").hidden = true; run(false); return; }
  if (t.id === "btn-sample" || t.dataset.action === "sample") { $("#empty").hidden = true; run(true); return; }
  if (t.id === "drawer-close") { $("#drawer").hidden = true; }
  if (t.id === "btn-replay") { Live.replay(); }
});

Live.mount($("#live"), { onFinished: (status) => { if (status === "done" && !state.data?.running) load().catch(console.error); } });

// rail: highlight the section whose top has passed ~40% of the viewport (sticky panels don't confuse it)
const railItems = $$(".rail__item");
const sections = ["top", "trends", "scripts", "videos", "signals"].map((id) => document.getElementById(id)).filter(Boolean);
function updateRail() {
  const line = window.innerHeight * 0.4;
  let active = sections[0];
  for (const s of sections) {
    // use the layout position (not the sticky offset) so #scripts activates only once you're past #trends
    const top = s.getBoundingClientRect().top;
    if (top <= line && (s.id !== "scripts" || sections[1].getBoundingClientRect().bottom <= line)) active = s;
  }
  railItems.forEach((a) => a.classList.toggle("is-active", a.dataset.section === active.id));
}
addEventListener("scroll", updateRail, { passive: true });
addEventListener("resize", updateRail);
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.data && renderWeeklyChart(state.data), 120); });
updateRail();

// Demo entry point: /test (or /demo, ?demo) auto-plays the recorded run in ~30 s, then shows the results.
const isDemo = ["/test", "/demo"].includes(location.pathname) || new URLSearchParams(location.search).has("demo");

load().then(() => { if (isDemo) setTimeout(() => Live.replay({ targetMs: 30000, autoResults: true }), 900); }).catch((err) => {
  $("#hero-overview").textContent = `Couldn't load data: ${err.message}`;
});
