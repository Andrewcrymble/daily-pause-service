/**
 * The unified analytics store.
 *
 * Six platforms, three different ways of being asked. Facebook and Instagram
 * answer to the Graph API, which this service already holds a token for.
 * Pinterest, TikTok, Threads and YouTube answer to Metricool, which is only
 * reachable over MCP — so the nightly collector task gathers those and posts
 * them here. Our own publishing records supply what neither can: what was said,
 * when, on what theme, and whether it carried a voice.
 *
 * Everything lands in one shape so the platforms can be compared at all.
 *
 * Two rules, and the whole thing is worthless without them:
 *
 *   1. **A metric a platform does not provide is null, never zero.** Pinterest
 *      reports no watch time; writing 0 would make it the worst video platform
 *      on the board rather than one that does not do video. Zero is a
 *      measurement. Null is the absence of one.
 *
 *   2. **Snapshots are append-only history, not a cache.** Meta's insights
 *      window is limited and Metricool's depends on the plan, so a figure not
 *      captured on the day is gone. This file exists so that in a year there is
 *      a year of data rather than whatever the APIs still remember.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync,
         mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';

export const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube',
                          'pinterest', 'threads'];

/**
 * The normalised row. Every platform fills what it can and leaves the rest
 * null. The comments say who can actually answer, because "engagement is
 * blank" and "this platform does not report engagement" are different problems
 * and only one of them is worth chasing.
 */
export const METRICS = [
  'followers',          // all six
  'following',          // pinterest, tiktok
  'posts',              // all six, from our own records where the API is quiet
  'impressions',        // facebook, pinterest, youtube
  'reach',              // facebook, instagram, tiktok
  'views',              // tiktok, youtube, instagram (video)
  'engagement',         // all six — but each platform means its own thing by it
  'likes',
  'comments',
  'shares',             // not instagram at account level
  'saves',              // instagram, pinterest
  'clicks',             // facebook, pinterest
  'profileViews',       // instagram, tiktok
  'videoViews',         // tiktok, youtube, instagram
  'watchTime',          // youtube, tiktok
  'followersGained',    // tiktok, pinterest, threads — others are derived
  'followersLost',      // tiktok only, in practice
];

const analyticsDir = resolve(config.dataDir, 'analytics');
const snapshotsDir = resolve(analyticsDir, 'snapshots');

export function ensureAnalyticsDirs() {
  for (const d of [analyticsDir, snapshotsDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

const snapPath = (date) => join(snapshotsDir, `${date}.json`);

/** An empty row: every metric present and explicitly unknown. */
export function blankRow() {
  const row = {};
  for (const m of METRICS) row[m] = null;
  return row;
}

/**
 * Coerce one platform's reported numbers into the normalised row.
 *
 * Anything absent, non-numeric or not finite becomes null rather than 0. A
 * string "4.0" from Metricool becomes 4; an empty string does not become 0.
 */
export function normaliseRow(input = {}) {
  const row = blankRow();
  for (const m of METRICS) {
    const v = input[m];
    if (v === null || v === undefined || v === '') continue;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (Number.isFinite(n)) row[m] = n;
  }
  return row;
}

/**
 * Write one day's snapshot.
 *
 * `platforms` is { facebook: {...}, tiktok: {...} } — any subset. A platform
 * left out of the payload keeps whatever was already stored for that day, so a
 * collector that reaches Metricool but not Meta does not blank the Meta half.
 */
export function writeSnapshot(date, platforms = {}, meta = {}) {
  ensureAnalyticsDirs();
  const existing = readSnapshot(date) || { date, platforms: {}, sources: {} };

  for (const [name, values] of Object.entries(platforms)) {
    if (!PLATFORMS.includes(name)) continue;
    existing.platforms[name] = normaliseRow(values);
    existing.sources[name] = {
      source: values.source || meta.source || 'unknown',
      at: new Date().toISOString(),
    };
  }
  existing.date = date;
  existing.updatedAt = new Date().toISOString();

  const p = snapPath(date);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2));
  renameSync(tmp, p);
  return existing;
}

export function readSnapshot(date) {
  const p = snapPath(date);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function listSnapshots() {
  ensureAnalyticsDirs();
  return readdirSync(snapshotsDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/** Every snapshot in a window, oldest first. */
export function snapshotRange(fromDate, toDate) {
  return listSnapshots()
    .filter((d) => d >= fromDate && d <= toDate)
    .map(readSnapshot)
    .filter(Boolean);
}

// ---------------------------------------------------------------- derived ---

/**
 * Sum a metric across platforms for one snapshot.
 *
 * Returns { value, from, missing } rather than a bare number: a total of 1,205
 * means something different when it is the sum of six platforms and when it is
 * one platform with five unknowns, and the dashboard has to be able to say so.
 */
export function totalAcross(snapshot, metric) {
  const from = [];
  const missing = [];
  let value = null;
  for (const p of PLATFORMS) {
    const v = snapshot?.platforms?.[p]?.[metric];
    if (v === null || v === undefined) { missing.push(p); continue; }
    value = (value ?? 0) + v;
    from.push(p);
  }
  return { value, from, missing };
}

/**
 * Change in a metric between two snapshots, per platform and in total.
 *
 * A platform missing from either end is reported as null, not as a change of
 * zero — "we did not measure" is not "it did not move".
 */
export function delta(earlier, later, metric) {
  const out = { platforms: {}, total: null, comparable: [] };
  let total = null;
  for (const p of PLATFORMS) {
    const a = earlier?.platforms?.[p]?.[metric];
    const b = later?.platforms?.[p]?.[metric];
    if (a === null || a === undefined || b === null || b === undefined) {
      out.platforms[p] = null;
      continue;
    }
    const d = b - a;
    out.platforms[p] = d;
    out.comparable.push(p);
    total = (total ?? 0) + d;
  }
  out.total = total;
  return out;
}

/** Percentage change, or null when the base is zero or either end is unknown. */
export function pctChange(from, to) {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (from === 0) return null;          // not "infinite growth"; undefined
  return ((to - from) / Math.abs(from)) * 100;
}

/**
 * How much history exists, which is the question every analysis here has to ask
 * before it opens its mouth.
 */
export function coverage() {
  const dates = listSnapshots();
  const perPlatform = {};
  for (const p of PLATFORMS) perPlatform[p] = 0;
  for (const d of dates) {
    const snap = readSnapshot(d);
    for (const p of PLATFORMS) {
      if (snap?.platforms?.[p]?.followers !== null &&
          snap?.platforms?.[p]?.followers !== undefined) perPlatform[p] += 1;
    }
  }
  return {
    days: dates.length,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    perPlatform,
  };
}

/**
 * Whether there is enough history for a given kind of claim.
 *
 * These thresholds are judgement, not statistics, and they are deliberately
 * conservative: the failure this guards against is a confident recommendation
 * drawn from four days of noise, which is worse than no recommendation because
 * it looks like evidence.
 */
export const NEEDS = {
  growth: 7,          // "are we growing" needs a week
  comparison: 14,     // comparing platforms needs two
  timing: 28,         // best time of day needs four weeks of slots
  themes: 30,         // theme performance needs a month of varied posts
  forecast: 30,       // any projection needs a month
  experiment: 14,     // a test needs a fortnight either side
};

export function enough(kind) {
  const need = NEEDS[kind];
  const have = coverage().days;
  return { ok: have >= need, have, need, short: Math.max(0, need - have) };
}
