/**
 * Stats assembly, with a cache in front of it.
 *
 * Meta's insights endpoints are slow and rate-limited, and the dashboard polls.
 * Everything here is therefore served from a short-lived cache; `refresh`
 * bypasses it. A failed refresh keeps the last good answer rather than blanking
 * the page, because a page of dashes reads as "nothing happened" when what it
 * actually means is "Meta was busy".
 */
import { config } from './config.js';
import { readDay, listDays } from './store.js';
import * as meta from './meta.js';

const TTL_MS = 10 * 60_000;
const cache = new Map();     // key -> { at, value }

async function cached(key, fn, { refresh = false } = {}) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) {
    return { ...hit.value, cachedAt: new Date(hit.at).toISOString(), stale: false };
  }
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return { ...value, cachedAt: new Date().toISOString(), stale: false };
  } catch (err) {
    if (hit) {
      return { ...hit.value, cachedAt: new Date(hit.at).toISOString(),
               stale: true, refreshError: err.message };
    }
    throw err;
  }
}

/** The last `days` days of records, newest first, with their post ids. */
function recentPosts(days = 30) {
  const wanted = listDays().slice(-days).reverse();
  const rows = [];
  for (const date of wanted) {
    const day = readDay(date);
    if (!day) continue;
    for (const post of day.posts) {
      rows.push({
        date,
        slot: post.slot,
        topic: post.topic ?? null,
        caption: post.caption,
        cardUrl: post.card?.url ?? null,
        facebookPostId: post.facebook?.postId ?? null,
        facebookStatus: post.facebook?.status ?? null,
        instagramMediaId: post.instagram?.mediaId ?? null,
        instagramStatus: post.instagram?.status ?? null,
      });
    }
  }
  return rows;
}

/** Dry run has nothing real to ask Meta about, so it answers with the shape. */
function emptyStats(rows) {
  return {
    dryRun: true,
    audience: { facebook: null, instagram: null },
    trend: { facebook: null, instagram: null, error: null },
    posts: rows.map((r) => ({ ...r, facebook: null, instagram: null })),
    scopes: { missing: [], checked: false },
  };
}

export async function overview({ days = 30, refresh = false } = {}) {
  const rows = recentPosts(days);
  if (config.dryRun || !config.pageToken) return emptyStats(rows);

  return cached(`overview:${days}`, async () => {
    // Which tier the answer can reach depends on the token, so establish that
    // first — it turns "reach is blank" into "reach needs read_insights".
    let missing = [];
    let checked = false;
    try {
      const t = await meta.inspectToken();
      missing = meta.missingInsightScopes(t.scopes);
      checked = true;
    } catch { /* the status endpoint reports token trouble properly */ }

    const [audience, trend, fbStats, igStats] = await Promise.all([
      meta.audience(),
      meta.dailyReach({ days }),
      meta.facebookPostStats(rows.map((r) => r.facebookPostId)),
      meta.instagramMediaStats(rows.map((r) => r.instagramMediaId)),
    ]);

    return {
      dryRun: false,
      audience,
      trend,
      scopes: { missing, checked },
      posts: rows.map((r) => ({
        ...r,
        facebook: r.facebookPostId ? fbStats[r.facebookPostId] ?? null : null,
        instagram: r.instagramMediaId ? igStats[r.instagramMediaId] ?? null : null,
      })),
    };
  }, { refresh });
}

export function clearCache() { cache.clear(); }
