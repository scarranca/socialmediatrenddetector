import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeInstagram, normalizeTikTok, normalizeYouTube, num, numOrNull, parseDurationSec } from "../src/collect.ts";

test("num / numOrNull coerce loosely-typed Actor output", () => {
  assert.equal(num("1,234"), 1234);
  assert.equal(num("12.5K"), 12_500);
  assert.equal(num("3M"), 3_000_000);
  assert.equal(num(undefined), 0);
  assert.equal(num(Number.NaN), 0);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull("abc"), null);
});

test("parseDurationSec understands seconds, m:ss and h:mm:ss", () => {
  assert.equal(parseDurationSec(15), 15);
  assert.equal(parseDurationSec("45"), 45);
  assert.equal(parseDurationSec("0:45"), 45);
  assert.equal(parseDurationSec("00:03:17"), 197);
  assert.equal(parseDurationSec(""), null);
  assert.equal(parseDurationSec("n/a"), null);
});

test("normalizeTikTok maps the Actor item and decodes double-escaped emoji", () => {
  const v = normalizeTikTok(
    {
      id: "7543693751290481942",
      text: "Decilo. \\ud83c\\udf99 #Fintech #pymes",
      createTimeISO: "2025-08-28T17:44:35.000Z",
      webVideoUrl: "https://www.tiktok.com/@someone/video/7543693751290481942",
      authorMeta: { name: "someone", fans: 51200 },
      musicMeta: { musicId: "752", musicName: "original sound", musicOriginal: true },
      videoMeta: { duration: 15 },
      diggCount: 23400, shareCount: 145, playCount: 145900, collectCount: 1637, commentCount: 46,
      hashtags: [{ name: "Fintech" }, { name: "pymes" }],
    },
    "fintech mexico",
  );
  assert.ok(v);
  assert.equal(v.platform, "tiktok");
  assert.equal(v.views, 145_900);
  assert.equal(v.saves, 1637);
  assert.equal(v.authorFollowers, 51_200);
  assert.deepEqual(v.hashtags, ["fintech", "pymes"]);
  assert.ok(v.caption.includes("🎙"), "literal \\ud83c\\udf99 becomes a real emoji");
  assert.equal(v.sound?.isOriginal, true);
  assert.equal(v.matchedQuery, "fintech mexico");
});

test("normalizers reject error items and items without an id", () => {
  assert.equal(normalizeTikTok({ error: "NOT_FOUND" }, "q"), null);
  assert.equal(normalizeYouTube({ input: "q", error: "NO_VIDEOS", note: "No videos found on the page." }, "q"), null);
  assert.equal(normalizeInstagram({}, "q"), null);
  assert.equal(normalizeTikTok(null, "q"), null);
});

test("normalizeYouTube parses duration strings and falls back to hashtags in the text", () => {
  const v = normalizeYouTube(
    { id: "abc123", title: "Factura en 20s #CFDI", url: "https://www.youtube.com/watch?v=abc123", viewCount: "22,332", likes: 410, commentsCount: 12, duration: "00:00:20", date: "2026-01-02T00:00:00.000Z", channelName: "Canal", numberOfSubscribers: "1.2K" },
    "facturacion electronica",
  );
  assert.ok(v);
  assert.equal(v.durationSec, 20);
  assert.equal(v.views, 22_332);
  assert.equal(v.authorFollowers, 1_200);
  assert.deepEqual(v.hashtags, ["cfdi"]);
  assert.equal(v.shares, 0);
});

test("normalizeInstagram reads reel fields", () => {
  const v = normalizeInstagram(
    { id: "99", shortCode: "Cxyz", caption: "hola #reels", ownerUsername: "brand", timestamp: "2026-01-05T10:00:00.000Z", videoDuration: 31.4, videoPlayCount: 8800, likesCount: 300, commentsCount: 9, musicInfo: { audio_id: "a1", song_name: "Song", uses_original_audio: false } },
    "@brand",
  );
  assert.ok(v);
  assert.equal(v.views, 8800);
  assert.equal(v.durationSec, 31);
  assert.equal(v.url, "https://www.instagram.com/reel/Cxyz/");
  assert.equal(v.sound?.name, "Song");
});
