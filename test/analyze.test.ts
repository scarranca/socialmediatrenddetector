import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClusters, median, scoreVideos, selectEvidence, summarizeStats } from "../src/analyze.ts";
import type { Video } from "../src/types.ts";

const NOW = new Date("2026-01-31T00:00:00Z");

function video(over: Partial<Video> & { id: string }): Video {
  return {
    platform: "tiktok",
    url: `https://example.com/${over.id}`,
    caption: "",
    hashtags: [],
    author: "creator",
    authorFollowers: 10_000,
    publishedAt: "2026-01-21T00:00:00Z", // 10 days before NOW
    durationSec: 30,
    views: 10_000,
    likes: 500,
    comments: 50,
    shares: 25,
    saves: 25,
    sound: null,
    matchedQuery: "q",
    ...over,
  };
}

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test("scoreVideos derives engagement, velocity and outlier factor", () => {
  const [v] = scoreVideos([video({ id: "a" })], NOW);
  assert.ok(v);
  assert.equal(v.engagementRate, 600 / 10_000);
  assert.equal(v.ageDays, 10);
  assert.equal(v.viewsPerDay, 1_000);
  assert.equal(v.outlierFactor, 1);
});

test("scoreVideos ranks a breakout from a small account above a big account's average post", () => {
  const scored = scoreVideos(
    [
      video({ id: "big-avg", authorFollowers: 900_000, views: 40_000, likes: 800 }),
      video({ id: "breakout", authorFollowers: 2_000, views: 1_200_000, likes: 150_000, publishedAt: "2026-01-28T00:00:00Z" }),
      video({ id: "filler", authorFollowers: 50_000, views: 6_000, likes: 100 }),
    ],
    NOW,
  );
  assert.equal(scored[0]?.id, "breakout");
  assert.ok(scored.every((s) => s.score >= 0 && s.score <= 100));
});

test("scoreVideos tolerates missing followers and publish dates", () => {
  const [v] = scoreVideos([video({ id: "x", authorFollowers: null, publishedAt: null })], NOW);
  assert.ok(v);
  assert.equal(v.outlierFactor, null);
  assert.equal(v.ageDays, null);
  assert.ok(Number.isFinite(v.score));
});

test("buildClusters groups by hashtag and drops generic tags", () => {
  const scored = scoreVideos(
    [
      video({ id: "1", hashtags: ["fintech", "fyp"] }),
      video({ id: "2", hashtags: ["FinTech", "parati"] }),
      video({ id: "3", hashtags: ["solo"] }),
    ],
    NOW,
  );
  const clusters = buildClusters(scored);
  const fintech = clusters.find((c) => c.kind === "hashtag" && c.key === "fintech");
  assert.ok(fintech, "case-insensitive hashtag cluster exists");
  assert.equal(fintech.videoIds.length, 2);
  assert.ok(!clusters.some((c) => c.kind === "hashtag" && ["fyp", "parati", "solo"].includes(c.key)));
});

test("buildClusters ignores original sounds but groups reused ones", () => {
  const reused = { id: "s1", name: "Suspense Drama", isOriginal: false };
  const scored = scoreVideos(
    [
      video({ id: "1", sound: reused }),
      video({ id: "2", sound: reused }),
      video({ id: "3", sound: { id: "o1", name: "original sound", isOriginal: true } }),
      video({ id: "4", sound: { id: "o1", name: "original sound", isOriginal: true } }),
    ],
    NOW,
  );
  const sounds = buildClusters(scored).filter((c) => c.kind === "sound");
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0]?.videoIds.length, 2);
});

test("selectEvidence respects the limit and never duplicates", () => {
  const vids = Array.from({ length: 50 }, (_, i) => video({ id: `v${i}`, views: 5_000 + i * 1_000, hashtags: [i % 2 ? "a" : "b"] }));
  const scored = scoreVideos(vids, NOW);
  const evidence = selectEvidence(scored, buildClusters(scored), 20);
  assert.ok(evidence.length <= 20);
  assert.equal(new Set(evidence.map((v) => v.id)).size, evidence.length);
});

test("summarizeStats counts platforms and hashtags", () => {
  const scored = scoreVideos([video({ id: "1", hashtags: ["cfdi", "x"] }), video({ id: "2", platform: "youtube", hashtags: ["cfdi"] })], NOW);
  const stats = summarizeStats(scored);
  assert.equal(stats.count, 2);
  assert.deepEqual(stats.byPlatform, { tiktok: 1, youtube: 1 });
  assert.equal(stats.topHashtags[0]?.tag, "cfdi");
  assert.ok(!stats.topHashtags.some((h) => h.tag === "x"), "single-character tags are treated as noise");
});
