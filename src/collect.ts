import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApifyClient } from "apify-client";
import type { ActorCallOptions, ActorRun } from "apify-client";
import { DATA_DIR, type Profile } from "./config.js";
import { emit } from "./events.js";
import type { Platform, Video } from "./types.js";

// ---------------------------------------------------------------------------
// Actor IDs
// ---------------------------------------------------------------------------

const ACTORS: Record<Platform, string> = {
  tiktok: "clockworks/tiktok-scraper",
  youtube: "streamers/youtube-scraper",
  instagram: "apify/instagram-reel-scraper",
};

// ---------------------------------------------------------------------------
// Small coercion helpers — Actor output is loosely typed (numbers may arrive
// as strings, be missing, or be NaN).
// ---------------------------------------------------------------------------

/** Coerce to a finite number, or 0. Accepts "1,234", "12.5K", "3M"-style strings too. */
export function num(v: unknown): number {
  return numOrNull(v) ?? 0;
}

/** Coerce to a finite number, or null when absent/unparseable. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim().replace(/,/g, "");
    const m = /^(-?\d+(?:\.\d+)?)\s*([kKmMbB])?$/.exec(s);
    if (m) {
      const base = Number(m[1]);
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
      return Number.isFinite(base) ? Math.round(base * mult) : null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return decodeLiteralEscapes(typeof v === "string" ? v : String(v));
}

/**
 * Some Actor outputs (notably TikTok captions) arrive double-escaped, with emoji as the literal
 * text `🎙`. Turn those sequences back into real characters.
 */
function decodeLiteralEscapes(s: string): string {
  if (!s.includes("\\u")) return s;
  return s.replace(/(?:\\u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2})|\\u[0-9a-fA-F]{4}/g, (m) => {
    try {
      return JSON.parse(`"${m}"`) as string;
    } catch {
      return m;
    }
  });
}

function strOrNull(v: unknown): string | null {
  const s = str(v).trim();
  return s.length ? s : null;
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** Normalize an ISO-ish or unix timestamp to ISO 8601, or null. */
function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    // seconds vs. milliseconds
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
    return relativeDateToIso(v);
  }
  return null;
}

/** Parse YouTube-style relative dates ("3 days ago", "10 months ago", "Streamed 2 weeks ago"). */
function relativeDateToIso(s: string, now = Date.now()): string | null {
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const msPer: Record<string, number> = {
    second: 1e3,
    minute: 60e3,
    hour: 3600e3,
    day: 86400e3,
    week: 7 * 86400e3,
    month: 30 * 86400e3,
    year: 365 * 86400e3,
  };
  return new Date(now - n * msPer[unit]).toISOString();
}

/** Parse "0:45", "00:03:17", "1:23:37", "45", or a number into seconds. */
export function parseDurationSec(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  // support m:ss and h:mm:ss
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return Math.round(total);
}

/** Extract #hashtags from free text (no leading '#', lowercased, deduped). */
function hashtagsFromText(text: string): string[] {
  const out = new Set<string>();
  const re = /#([\p{L}\p{N}_]+)/gu;
  for (const m of text.matchAll(re)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Normalize a hashtag list that may contain strings or `{ name }` objects. */
function normalizeHashtags(list: unknown, fallbackText = ""): string[] {
  const out = new Set<string>();
  if (Array.isArray(list)) {
    for (const h of list) {
      const raw = typeof h === "string" ? h : h && typeof h === "object" ? str((h as { name?: unknown }).name) : "";
      const clean = raw.trim().replace(/^#/, "").toLowerCase();
      if (clean) out.add(clean);
    }
  }
  if (out.size === 0 && fallbackText) {
    for (const h of hashtagsFromText(fallbackText)) out.add(h);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Normalizers — one per platform. Each returns null for unusable items.
// ---------------------------------------------------------------------------

export function normalizeTikTok(item: any, matchedQuery: string): Video | null {
  if (!item || typeof item !== "object") return null;
  if (item.error) return null;
  const id = strOrNull(item.id);
  if (!id) return null;

  const caption = str(item.text);
  const author = str(item.authorMeta?.name ?? item.authorMeta?.nickName);
  const url = strOrNull(item.webVideoUrl) ?? (author ? `https://www.tiktok.com/@${author}/video/${id}` : `https://www.tiktok.com/video/${id}`);

  const music = item.musicMeta;
  const sound =
    music && typeof music === "object"
      ? {
          id: strOrNull(music.musicId),
          name: strOrNull(music.musicName),
          isOriginal: boolOrNull(music.musicOriginal),
        }
      : null;

  return {
    id,
    platform: "tiktok",
    url,
    caption,
    hashtags: normalizeHashtags(item.hashtags, caption),
    author,
    authorFollowers: numOrNull(item.authorMeta?.fans),
    publishedAt: isoOrNull(item.createTimeISO ?? item.createTime),
    durationSec: parseDurationSec(item.videoMeta?.duration),
    views: num(item.playCount),
    likes: num(item.diggCount),
    comments: num(item.commentCount),
    shares: num(item.shareCount),
    saves: num(item.collectCount),
    sound: sound && (sound.id || sound.name) ? sound : null,
    matchedQuery,
  };
}

export function normalizeYouTube(item: any, matchedQuery: string): Video | null {
  if (!item || typeof item !== "object") return null;
  if (item.error) return null;
  const id = strOrNull(item.id);
  if (!id) return null;

  const title = str(item.title);
  const text = str(item.text);
  const caption = title && text && !text.startsWith(title) ? `${title}\n${text}` : title || text;
  const url = strOrNull(item.url) ?? `https://www.youtube.com/shorts/${id}`;

  return {
    id,
    platform: "youtube",
    url: url.replace(/^<|>$/g, ""),
    caption,
    hashtags: normalizeHashtags(item.hashtags, caption),
    author: str(item.channelName ?? item.channelUsername),
    authorFollowers: numOrNull(item.numberOfSubscribers),
    publishedAt: isoOrNull(item.date),
    durationSec: parseDurationSec(item.duration),
    views: num(item.viewCount),
    likes: num(item.likes),
    comments: num(item.commentsCount),
    shares: 0, // YouTube does not expose share counts
    saves: 0, // nor saves
    sound: null, // Shorts audio metadata is not returned by this Actor
    matchedQuery,
  };
}

export function normalizeInstagram(item: any, matchedQuery: string): Video | null {
  if (!item || typeof item !== "object") return null;
  if (item.error) return null;
  const id = strOrNull(item.id) ?? strOrNull(item.shortCode);
  if (!id) return null;

  const caption = str(item.caption);
  const shortCode = strOrNull(item.shortCode);
  const url = strOrNull(item.url) ?? (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : `https://www.instagram.com/p/${id}/`);

  const music = item.musicInfo;
  const sound =
    music && typeof music === "object"
      ? {
          id: strOrNull(music.audio_id),
          name: strOrNull(music.song_name),
          isOriginal: boolOrNull(music.uses_original_audio),
        }
      : null;

  // videoPlayCount is the reel "plays"; fall back to videoViewCount when absent.
  const views = numOrNull(item.videoPlayCount) ?? num(item.videoViewCount);

  return {
    id,
    platform: "instagram",
    url,
    caption,
    hashtags: normalizeHashtags(item.hashtags, caption),
    author: str(item.ownerUsername),
    authorFollowers: numOrNull(item.ownerFollowersCount ?? item.followersCount), // not returned by the reel scraper; null in practice
    publishedAt: isoOrNull(item.timestamp),
    durationSec: parseDurationSec(item.videoDuration),
    views,
    likes: num(item.likesCount),
    comments: num(item.commentsCount),
    shares: num(item.sharesCount), // only present when includeSharesCount=true
    saves: 0, // not exposed by Instagram
    sound: sound && (sound.id || sound.name) ? sound : null,
    matchedQuery,
  };
}

// ---------------------------------------------------------------------------
// matchedQuery derivation per platform
// ---------------------------------------------------------------------------

function tiktokQuery(item: any): string {
  const q = strOrNull(item?.searchQuery);
  if (q) return q;
  const h = strOrNull(item?.searchHashtag?.name ?? item?.searchHashtag);
  if (h) return `#${h.replace(/^#/, "")}`;
  return "tiktok";
}

function youtubeQuery(item: any, fallbackKeywords: string[]): string {
  const direct = strOrNull(item?.input);
  if (direct) return direct;
  const from = str(item?.fromYTUrl).replace(/^<|>$/g, "");
  if (from) {
    try {
      const u = new URL(from);
      const q = u.searchParams.get("search_query");
      if (q) return q;
    } catch {
      /* not a URL */
    }
  }
  // Last resort: pick the first configured keyword that appears in the title/text.
  const hay = `${str(item?.title)} ${str(item?.text)}`.toLowerCase();
  const hit = fallbackKeywords.find((k) => hay.includes(k.toLowerCase()));
  return hit ?? "youtube";
}

function instagramQuery(item: any): string {
  const u = strOrNull(item?.ownerUsername);
  return u ? `@${u}` : "instagram";
}

// ---------------------------------------------------------------------------
// Actor inputs
// ---------------------------------------------------------------------------

function buildInput(platform: Platform, profile: Profile): Record<string, unknown> {
  const { resultsPerQuery, lookbackDays } = profile.collection;
  switch (platform) {
    case "tiktok":
      return {
        searchQueries: profile.keywords,
        hashtags: profile.hashtags.map((h) => h.replace(/^#/, "")),
        resultsPerPage: resultsPerQuery,
        searchSection: "/video",
        // Charged filters (verified from the Actor's OpenAPI input schema). Without them TikTok
        // returns "Top" results, half of which are months old and get filtered out after we paid.
        //   videoSearchDateFilter: ALL_TIME | PAST_24_HOURS | PAST_WEEK | PAST_MONTH | LAST_3_MONTHS | LAST_6_MONTHS
        //   videoSearchSorting:    MOST_RELEVANT | MOST_LIKED | LATEST
        videoSearchDateFilter:
          lookbackDays <= 7 ? "PAST_WEEK" : lookbackDays <= 31 ? "PAST_MONTH" : lookbackDays <= 92 ? "LAST_3_MONTHS" : "LAST_6_MONTHS",
        videoSearchSorting: "MOST_LIKED",
        excludePinnedPosts: true,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
        shouldDownloadAvatars: false,
        shouldDownloadMusicCovers: false,
      };
    case "youtube":
      return {
        searchQueries: profile.keywords,
        // YouTube search can't combine the Shorts shelf with sort/date filters (returns NO_VIDEOS), and
        // Shorts-by-relevance within a window is near-zero-view noise. So we search regular videos
        // under 4 minutes, sorted by views within the window — that's where short-form winners show up.
        // Enums verified from the Actor's OpenAPI input schema:
        //   dateFilter:   "hour" | "today" | "week" | "month" | "year"
        //   sortingOrder: "relevance" | "rating" | "date" | "views"
        //   lengthFilter: "under4" | "between420" | "plus20"
        maxResults: resultsPerQuery,
        maxResultsShorts: 0,
        maxResultStreams: 0,
        dateFilter: lookbackDays <= 7 ? "week" : lookbackDays <= 31 ? "month" : "year",
        sortingOrder: "views",
        lengthFilter: "under4",
      };
    case "instagram":
      return {
        username: profile.competitorInstagramProfiles.map((u) => u.replace(/^@/, "")),
        resultsLimit: resultsPerQuery,
        onlyPostsNewerThan: `${lookbackDays} days`,
        skipPinnedPosts: true,
        includeTranscript: false,
        includeDownloadedVideo: false,
        includeSharesCount: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function fetchAllItems(client: ApifyClient, datasetId: string): Promise<any[]> {
  const ds = client.dataset(datasetId);
  const first = await ds.listItems({ clean: true });
  const items: any[] = [...first.items];
  let offset = items.length;
  const total = num(first.total);
  const pageSize = Math.max(first.items.length, 1);
  while (offset < total) {
    const page = await ds.listItems({ clean: true, offset, limit: pageSize });
    if (!page.items.length) break;
    items.push(...page.items);
    offset += page.items.length;
  }
  return items;
}

function runUrl(run: Pick<ActorRun, "id">): string {
  return `https://console.apify.com/actors/runs/${run.id}`;
}

export async function collectVideos(
  profile: Profile,
  opts: { token: string; maxSpendUsd: number; log?: (msg: string) => void },
): Promise<Video[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const client = new ApifyClient({ token: opts.token });

  // Platforms that will actually run
  const platforms = profile.platforms.filter((p) => {
    if (p === "instagram" && profile.competitorInstagramProfiles.length === 0) {
      log("[instagram] skipped: no competitorInstagramProfiles configured");
      return false;
    }
    return true;
  });
  if (platforms.length === 0) {
    log("No platforms to collect from.");
    return [];
  }

  const perPlatformUsd = Math.max(0, opts.maxSpendUsd) / platforms.length;
  const callOptions: ActorCallOptions = {
    maxTotalChargeUsd: Number(perPlatformUsd.toFixed(4)),
    waitSecs: 600,
    log: null,
  };
  log(`Collecting from ${platforms.join(", ")} — budget $${perPlatformUsd.toFixed(2)} per platform`);

  mkdirSync(DATA_DIR, { recursive: true });

  const all: Video[] = [];

  for (const platform of platforms) {
    const actorId = ACTORS[platform];
    const input = buildInput(platform, profile);
    log(`[${platform}] starting ${actorId}`);
    const queries =
      platform === "instagram"
        ? profile.competitorInstagramProfiles.map((u) => `@${u.replace(/^@/, "")}`)
        : platform === "tiktok"
          ? [...profile.keywords, ...profile.hashtags.map((h) => `#${h.replace(/^#/, "")}`)]
          : profile.keywords;
    emit({ type: "actor", platform, status: "start", actorId, queries });
    try {
      const run = await client.actor(actorId).call(input, callOptions);
      const status = run.status;
      const statusMessage = (run as { statusMessage?: string }).statusMessage;
      log(`[${platform}] run ${runUrl(run)} → ${status}${statusMessage ? ` (${statusMessage})` : ""}`);

      if (status !== "SUCCEEDED") {
        // Partial datasets from TIMED-OUT / ABORTED runs may still be useful; still try reading them.
        log(`[${platform}] run did not succeed (status=${status}); attempting to read whatever was scraped`);
      }
      if (!run.defaultDatasetId) {
        log(`[${platform}] no dataset on run; skipping`);
        continue;
      }

      const raw = await fetchAllItems(client, run.defaultDatasetId);
      writeFileSync(path.join(DATA_DIR, `raw-${platform}.json`), JSON.stringify(raw, null, 2));
      log(`[${platform}] fetched ${raw.length} raw items`);

      let kept = 0;
      const batch: Video[] = [];
      for (const item of raw) {
        let v: Video | null = null;
        if (platform === "tiktok") v = normalizeTikTok(item, tiktokQuery(item));
        else if (platform === "youtube") v = normalizeYouTube(item, youtubeQuery(item, profile.keywords));
        else v = normalizeInstagram(item, instagramQuery(item));
        if (v) {
          all.push(v);
          batch.push(v);
          kept++;
        }
      }
      log(`[${platform}] normalized ${kept}/${raw.length}`);
      emit({ type: "actor", platform, status: "done", actorId, runUrl: runUrl(run), raw: raw.length, kept });
      // Stream a sample of what came in (highest views first) so the UI can show videos landing.
      emit({
        type: "videos",
        platform,
        items: batch
          .slice()
          .sort((a, b) => b.views - a.views)
          .slice(0, 40)
          .map((v) => ({ id: v.id, author: v.author, views: v.views, caption: v.caption.replace(/\s+/g, " ").slice(0, 90), url: v.url })),
      });
    } catch (err) {
      const e = err as { message?: string; run?: { status?: string; statusMessage?: string } };
      const detail = e?.run ? ` status=${e.run.status ?? "?"}${e.run.statusMessage ? ` (${e.run.statusMessage})` : ""}` : "";
      log(`[${platform}] FAILED: ${e?.message ?? String(err)}${detail} — continuing with other platforms`);
      emit({ type: "actor", platform, status: "failed", actorId, message: e?.message ?? String(err) });
    }
  }

  // Filters: min views, lookback window (keep when publishedAt unknown), dedupe.
  const cutoff = Date.now() - profile.collection.lookbackDays * 86400e3;
  const seen = new Set<string>();
  const videos: Video[] = [];
  let droppedViews = 0;
  let droppedOld = 0;
  let droppedDup = 0;
  for (const v of all) {
    if (v.views < profile.collection.minViews) {
      droppedViews++;
      continue;
    }
    if (v.publishedAt) {
      const t = Date.parse(v.publishedAt);
      if (!Number.isNaN(t) && t < cutoff) {
        droppedOld++;
        continue;
      }
    }
    const key = `${v.platform}:${v.id}`;
    if (seen.has(key)) {
      droppedDup++;
      continue;
    }
    seen.add(key);
    videos.push(v);
  }

  writeFileSync(path.join(DATA_DIR, "videos.json"), JSON.stringify(videos, null, 2));
  emit({ type: "filter", kept: videos.length, droppedViews, droppedOld, droppedDup });
  log(
    `Kept ${videos.length} videos (dropped ${droppedViews} under ${profile.collection.minViews} views, ${droppedOld} older than ${profile.collection.lookbackDays}d, ${droppedDup} duplicates) → ${path.join(DATA_DIR, "videos.json")}`,
  );
  return videos;
}
