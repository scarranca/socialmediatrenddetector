import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const REAL_DATA_DIR = path.join(ROOT, "data");
export const SAMPLE_DATA_DIR = path.join(ROOT, "data", "sample");
// `--sample` runs are kept apart so a dry run can never overwrite the results (or report) of a real run.
const IS_SAMPLE_RUN = process.argv.includes("--sample");
export const DATA_DIR = IS_SAMPLE_RUN ? SAMPLE_DATA_DIR : REAL_DATA_DIR;
export const OUTPUT_DIR = IS_SAMPLE_RUN ? path.join(ROOT, "output", "sample") : path.join(ROOT, "output");

export const ProfileSchema = z.object({
  name: z.string(),
  handle: z.string(),
  industry: z.string(),
  language: z.string().default("en"),
  platforms: z.array(z.enum(["tiktok", "youtube", "instagram"])).min(1),
  keywords: z.array(z.string()).min(1),
  hashtags: z.array(z.string()).default([]),
  competitorInstagramProfiles: z.array(z.string()).default([]),
  audience: z.string(),
  positioning: z.string(),
  tone: z.string(),
  offer: z.string(),
  avoid: z.array(z.string()).default([]),
  formats: z.array(z.string()).default([]),
  targetDurationSeconds: z.tuple([z.number(), z.number()]).default([20, 45]),
  collection: z
    .object({
      resultsPerQuery: z.number().int().min(1).max(200).default(20),
      lookbackDays: z.number().int().min(1).max(365).default(30),
      minViews: z.number().int().min(0).default(1000),
    })
    .default({ resultsPerQuery: 20, lookbackDays: 30, minViews: 1000 }),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Your own `config/profile.json` (gitignored) wins; otherwise fall back to the committed example. */
function defaultProfilePath(): string {
  const own = path.join(ROOT, "config", "profile.json");
  return existsSync(own) ? own : path.join(ROOT, "config", "profile.example.json");
}

export function loadProfile(file?: string): Profile {
  const raw = JSON.parse(readFileSync(file ? path.resolve(file) : defaultProfilePath(), "utf8"));
  delete raw.$comment;
  return ProfileSchema.parse(raw);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in (loaded via \`node --env-file=.env\`).`);
  }
  return v;
}

// Blank values in .env (e.g. `APIFY_MAX_SPEND_USD=`) count as unset.
const spendEnv = process.env.APIFY_MAX_SPEND_USD?.trim();
export const APIFY_MAX_SPEND_USD = spendEnv && Number.isFinite(Number(spendEnv)) ? Number(spendEnv) : 1.5;
