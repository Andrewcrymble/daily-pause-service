/**
 * The Command Centre payload.
 *
 * One object answering the four questions the dashboard exists for: are we
 * growing, what is causing it, what is not working, what should we do next.
 *
 * Everything here is assembled from three sources and each figure is labelled
 * with which kind of thing it is, because a dashboard that shows a measured
 * follower count and a projected one in the same typeface is lying by layout:
 *
 *   live       — read from a platform API just now
 *   historical — from our own stored snapshots
 *   calculated — arithmetic on the two above
 *   estimate   — a projection, with its assumptions stated
 *
 * Nothing is invented. Where a platform does not report a metric the answer is
 * null and the dashboard says so rather than drawing a zero.
 */
import {
  PLATFORMS, readSnapshot, listSnapshots, snapshotRange, totalAcross, delta,
  pctChange, coverage, enough, NEEDS,
} from './analytics.js';
import { readDay, listDays } from './store.js';
import { config } from './config.js';

const DAY = 86_400_000;

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const daysAgo = (n, from = Date.now()) => iso(from - n * DAY);

/** The snapshot on or most recently before a date. */
function snapshotOnOrBefore(date) {
  const dates = listSnapshots().filter((d) => d <= date);
  if (!dates.length) return null;
  return readSnapshot(dates[dates.length - 1]);
}

const MILESTONES = [1000, 2500, 5000, 10000, 25000, 50000, 100000];

function nextMilestone(followers) {
  if (followers === null || followers === undefined) return null;
  const target = MILESTONES.find((m) => m > followers);
  return target ?? null;
}

// ------------------------------------------------------------- follower growth

/**
 * Growth over a window, per platform and in total.
 *
 * `averageDaily` divides by the days actually spanned by the two snapshots, not
 * by the window asked for — a 30-day question answered from 3 days of data
 * gives the 3-day rate, and `spanDays` says so.
 */
export function growth(days = 30) {
  const today = iso(Date.now());
  const start = daysAgo(days);

  // Only snapshots inside the window count. The tempting alternative — reach
  // back to the newest snapshot before the window when there is nothing in it —
  // silently answers a question about the last 30 days using figures from
  // March, and reports no growth because both ends are the same row.
  const inWindow = snapshotRange(start, today);
  if (inWindow.length < 2) {
    return {
      window: days,
      available: false,
      have: inWindow.length,
      reason: inWindow.length === 0
        ? 'No snapshots inside this window'
        : 'Only one snapshot inside this window; growth needs two points',
    };
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];

  const spanDays = Math.max(
    1, Math.round((Date.parse(last.date) - Date.parse(first.date)) / DAY));

  const d = delta(first, last, 'followers');
  const startTotal = totalAcross(first, 'followers');
  const endTotal = totalAcross(last, 'followers');

  const perPlatform = {};
  for (const p of PLATFORMS) {
    const a = first.platforms?.[p]?.followers ?? null;
    const b = last.platforms?.[p]?.followers ?? null;
    perPlatform[p] = {
      start: a, current: b,
      gained: d.platforms[p],
      gainedLifetime: last.platforms?.[p]?.followersGained ?? null,
      lost: last.platforms?.[p]?.followersLost ?? null,
      percent: pctChange(a, b),
      averageDaily: d.platforms[p] === null ? null : d.platforms[p] / spanDays,
    };
  }

  return {
    window: days,
    available: true,
    from: first.date,
    to: last.date,
    spanDays,
    complete: spanDays >= days,
    start: startTotal.value,
    current: endTotal.value,
    net: d.total,
    percent: pctChange(startTotal.value, endTotal.value),
    averageDaily: d.total === null ? null : d.total / spanDays,
    comparablePlatforms: d.comparable,
    platforms: perPlatform,
  };
}

// ----------------------------------------------------------------- overview

/** How many posts our own records say went out in a window. */
function postsPublished(sinceDate) {
  let count = 0;
  for (const date of listDays()) {
    if (date < sinceDate) continue;
    const day = readDay(date);
    if (!day) continue;
    for (const post of day.posts || []) {
      if (post.hold) continue;
      if (post.facebook?.status === 'published' ||
          post.instagram?.status === 'published') count += 1;
    }
  }
  return count;
}

export function overview() {
  const today = iso(Date.now());
  const last = snapshotOnOrBefore(today);
  const cov = coverage();

  if (!last) {
    return { available: false, coverage: cov,
             reason: 'No snapshots stored yet — the nightly collector has not run' };
  }

  const week = growth(7);
  const month = growth(30);
  const yesterday = growth(1);

  const totals = {};
  for (const m of ['followers', 'reach', 'impressions', 'engagement',
                   'videoViews', 'likes', 'comments', 'shares']) {
    totals[m] = totalAcross(last, m);
  }

  // Best and fastest are deliberately different questions, and both are
  // meaningless across fewer platforms than are actually connected — so each
  // carries the list it was judged on.
  const byFollowers = PLATFORMS
    .map((p) => ({ platform: p, value: last.platforms?.[p]?.followers ?? null }))
    .filter((r) => r.value !== null)
    .sort((a, b) => b.value - a.value);

  const byGrowth = month.available
    ? PLATFORMS
        .map((p) => ({ platform: p, value: month.platforms[p]?.gained ?? null,
                       percent: month.platforms[p]?.percent ?? null }))
        .filter((r) => r.value !== null)
        .sort((a, b) => b.value - a.value)
    : [];

  return {
    available: true,
    asOf: last.date,
    coverage: cov,
    totals,
    followers: {
      total: totals.followers.value,
      today: yesterday.available ? yesterday.net : null,
      week: week.available ? week.net : null,
      month: month.available ? month.net : null,
      monthPercent: month.available ? month.percent : null,
      windowsComplete: {
        today: yesterday.available && yesterday.complete,
        week: week.available && week.complete,
        month: month.available && month.complete,
      },
    },
    posts: {
      today: postsPublished(today),
      week: postsPublished(daysAgo(7)),
    },
    biggestPlatform: byFollowers[0] ?? null,
    fastestGrowing: byGrowth[0] ?? null,
    ranking: { byFollowers, byGrowth },
  };
}

// --------------------------------------------------------------- scorecards

/**
 * The most recent snapshot that actually carries this platform, with its age.
 *
 * Reading only the newest snapshot was wrong: a platform the collector could
 * not reach last night showed as NO DATA even though a perfectly good figure
 * from the night before was sitting in the store. The fix is not to pretend
 * yesterday's number is today's — it is to show it *and say how old it is*.
 */
function lastKnown(platform) {
  const dates = listSnapshots();
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    const snap = readSnapshot(dates[i]);
    const row = snap?.platforms?.[platform];
    if (row && row.followers !== null && row.followers !== undefined) {
      return {
        row,
        date: dates[i],
        ageDays: Math.round((Date.parse(iso(Date.now())) - Date.parse(dates[i])) / DAY),
      };
    }
  }
  return null;
}

/**
 * One card per platform. `status` is a judgement and is named as one — it is
 * not a platform metric and the dashboard labels it accordingly.
 */
export function scorecards() {
  const month = growth(30);
  const out = [];

  for (const p of PLATFORMS) {
    const known = lastKnown(p);
    const row = known?.row ?? null;
    const g = month.available ? month.platforms[p] : null;
    const connected = Boolean(row) && row.followers !== null;

    let status = 'NO DATA';
    let because = 'Nothing has been collected for this platform yet';

    if (connected) {
      const g30 = g?.gained ?? null;
      if (!month.available || month.spanDays < 7) {
        status = 'TOO EARLY';
        because = `Only ${month.available ? month.spanDays : 0} day(s) of history; ` +
                  'a verdict needs at least 7';
      } else if (g30 === null) {
        status = 'TOO EARLY';
        because = 'Follower history is incomplete for this window';
      } else if (g30 > 0) {
        status = 'GROWING';
        because = `${g30} followers in ${month.spanDays} days`;
      } else if (g30 === 0) {
        status = 'FLAT';
        because = `No net change in ${month.spanDays} days`;
      } else {
        status = 'DECLINING';
        because = `${g30} followers in ${month.spanDays} days`;
      }
    }

    out.push({
      platform: p,
      connected,
      // Never presented as current when it is not. The dashboard shows the age
      // beside the figure rather than quietly passing it off as today's.
      asOf: known?.date ?? null,
      ageDays: known?.ageDays ?? null,
      stale: known ? known.ageDays > 1 : false,
      followers: row?.followers ?? null,
      gained: g?.gained ?? null,
      percent: g?.percent ?? null,
      reach: row?.reach ?? null,
      impressions: row?.impressions ?? null,
      engagement: row?.engagement ?? null,
      videoViews: row?.videoViews ?? null,
      profileViews: row?.profileViews ?? null,
      milestone: (() => {
        const f = row?.followers ?? null;
        const target = nextMilestone(f);
        if (target === null || f === null) return null;
        const rate = g?.averageDaily ?? null;
        return {
          target,
          remaining: target - f,
          averageDaily: rate,
          // An estimate, and labelled one. A rate of zero or less gives no
          // date at all rather than a date in the year 3000.
          estimatedDays: rate && rate > 0 ? Math.ceil((target - f) / rate) : null,
        };
      })(),
      status,
      because,
    });
  }
  return out;
}

// ----------------------------------------------------------- data health

/**
 * Whether each source is actually feeding us, and when it last did.
 *
 * The rule this enforces: never show stale information as current. A platform
 * whose last snapshot is two days old is reported as stale with its age, not
 * quietly rendered as today's number.
 */
export function dataHealth() {
  const dates = listSnapshots();
  const today = iso(Date.now());
  const out = { asOf: today, sources: [] };

  for (const p of PLATFORMS) {
    let lastDate = null;
    let source = null;
    for (let i = dates.length - 1; i >= 0; i -= 1) {
      const snap = readSnapshot(dates[i]);
      const v = snap?.platforms?.[p];
      if (v && v.followers !== null && v.followers !== undefined) {
        lastDate = dates[i];
        source = snap.sources?.[p]?.source ?? null;
        break;
      }
    }
    const ageDays = lastDate
      ? Math.round((Date.parse(today) - Date.parse(lastDate)) / DAY) : null;

    out.sources.push({
      platform: p,
      source,
      lastSnapshot: lastDate,
      ageDays,
      state: lastDate === null ? 'NO DATA'
           : ageDays <= 1 ? 'CONNECTED'
           : ageDays <= 3 ? 'STALE'
           : 'WARNING',
      note: lastDate === null
        ? 'Never collected'
        : ageDays <= 1 ? null
        : `Last figure is ${ageDays} days old and is not being shown as current`,
    });
  }

  out.coverage = coverage();
  out.readiness = Object.fromEntries(
    Object.keys(NEEDS).map((k) => [k, enough(k)]));
  return out;
}

// ------------------------------------------------------------------ forecast

/**
 * A conservative projection of followers.
 *
 * Ordinary least squares on the daily totals, which assumes the recent trend
 * continues unchanged — the least exciting assumption available, and
 * deliberately so. Social growth is not linear, but a linear fit under-promises
 * where an exponential one would flatter, and a dashboard that flatters is
 * worse than useless. The range is the fit plus or minus the residual spread,
 * not a confidence interval in any formal sense, and it is labelled as a rough
 * band rather than dressed up as statistics.
 *
 * Refuses entirely below 30 days.
 */
export function forecast() {
  const gate = enough('forecast');
  if (!gate.ok) {
    return { available: false, ...gate,
             reason: `More data required — ${gate.short} more days of history needed` };
  }

  const points = listSnapshots().map((d, i) => {
    const t = totalAcross(readSnapshot(d), 'followers');
    return t.value === null ? null : { x: i, y: t.value, date: d };
  }).filter(Boolean);

  if (points.length < NEEDS.forecast) {
    return { available: false, reason: 'More data required' };
  }

  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;

  const residuals = points.map((p) => p.y - (slope * p.x + intercept));
  const spread = Math.sqrt(
    residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2));

  const current = points[points.length - 1].y;
  const project = (ahead) => {
    const centre = Math.round(slope * (n - 1 + ahead) + intercept);
    const band = Math.round(spread * Math.sqrt(1 + ahead / n));
    return {
      expected: Math.max(0, centre),
      low: Math.max(0, centre - band),
      high: Math.max(0, centre + band),
    };
  };

  return {
    available: true,
    kind: 'estimate',
    method: 'Least-squares fit on daily follower totals; assumes the current ' +
            'trend continues unchanged',
    basedOnDays: n,
    current,
    dailyRate: slope,
    horizons: { 30: project(30), 90: project(90), 180: project(180) },
  };
}

// --------------------------------------------------------------- everything

export function commandCentre() {
  return {
    generatedAt: new Date().toISOString(),
    timezone: config.timezone,
    overview: overview(),
    growth: {
      7: growth(7), 30: growth(30), 90: growth(90),
      180: growth(180), 365: growth(365),
    },
    scorecards: scorecards(),
    forecast: forecast(),
    dataHealth: dataHealth(),
  };
}
