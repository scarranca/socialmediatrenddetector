import { z } from "zod";

export type Platform = "tiktok" | "youtube" | "instagram";

/** One normalized short-form video, regardless of source platform. */
export interface Video {
  id: string;
  platform: Platform;
  url: string;
  caption: string;
  hashtags: string[];
  author: string;
  authorFollowers: number | null;
  publishedAt: string | null; // ISO
  durationSec: number | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  sound: { id: string | null; name: string | null; isOriginal: boolean | null } | null;
  /** Which of our search queries / hashtags surfaced this video. */
  matchedQuery: string;
}

/** Video + derived trend signals. */
export interface ScoredVideo extends Video {
  engagementRate: number; // (likes+comments+shares+saves)/views
  viewsPerDay: number; // velocity
  outlierFactor: number | null; // views / authorFollowers — >1 means it escaped the creator's own audience
  ageDays: number | null;
  score: number;
}

export interface ClusterSignal {
  key: string;
  kind: "hashtag" | "sound" | "keyword";
  videoIds: string[];
  totalViews: number;
  medianEngagementRate: number;
  platforms: Platform[];
}

export const TrendSchema = z.object({
  name: z.string().describe("Short memorable trend name, max 6 words"),
  summary: z.string().describe("2-3 sentences: what the content pattern is and why it's getting reach right now"),
  format: z.string().describe("Dominant format, e.g. 'talking-head hot take', 'screen-recording tutorial', 'POV skit', 'listicle with on-screen text'"),
  hookPattern: z.string().describe("The recurring opening-line structure, phrased as a template"),
  evidenceVideoIds: z.array(z.string()).min(1).describe("IDs of the sampled videos that best exemplify this trend"),
  signals: z.object({
    hashtags: z.array(z.string()),
    sounds: z.array(z.string()),
    typicalDurationSec: z.number().nullable(),
  }),
  momentum: z.enum(["emerging", "peaking", "saturated"]),
  fitForProfile: z.number().min(1).max(10).describe("How well this trend suits the user's profile, 1-10"),
  fitReason: z.string(),
});
export type Trend = z.infer<typeof TrendSchema>;

export const TrendReportSchema = z.object({
  overview: z.string().describe("3-5 sentence executive summary of what's working in this industry right now"),
  trends: z.array(TrendSchema).min(3).max(8),
});
export type TrendReport = z.infer<typeof TrendReportSchema>;

export const ScriptSchema = z.object({
  trendName: z.string(),
  title: z.string().describe("Working title for the video"),
  platform: z.enum(["tiktok", "youtube", "instagram", "all"]),
  format: z.string(),
  durationSec: z.number(),
  hook: z.string().describe("Exact words for the first 1-3 seconds"),
  beats: z
    .array(
      z.object({
        t: z.string().describe("Timestamp range, e.g. '0-3s'"),
        say: z.string().describe("Exact spoken line(s)"),
        show: z.string().describe("What's on screen: shot, b-roll, screen recording, on-screen text"),
      }),
    )
    .min(3),
  cta: z.string(),
  caption: z.string().describe("Post caption, ready to paste"),
  hashtags: z.array(z.string()).min(3).max(8),
  soundSuggestion: z.string().nullable(),
  whyThisWorks: z.string().describe("1-2 sentences tying the script back to the trend evidence"),
});
export type Script = z.infer<typeof ScriptSchema>;

export const ScriptBatchSchema = z.object({ scripts: z.array(ScriptSchema).min(1) });
