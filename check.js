/**
 * One question, one answer: is today all right?
 *
 * Written to be read by something that is not a person — a scheduled task that
 * fires after each slot and only says anything when `ok` is false. The whole
 * point is that a failure reaches Andrew's phone rather than waiting to be
 * noticed.
 *
 * Nothing in here is a secret, so the answer can be pasted into a chat.
 */
import { config } from './config.js';
import { todayIn } from './time.js';
import { readDay } from './store.js';
import * as meta from './meta.js';
import * as notify from './notify.js';
import * as voice from './voice.js';

const iso = () => new Date().toISOString();

/** A slot whose time has passed by this much should have gone out by now. */
const OVERDUE_MS = 15 * 60_000;

const LIVE = new Set(['published']);
const PENDING = new Set(['scheduled', 'queued', 'pending', 'publishing']);

export async function check({ date, now = Date.now() } = {}) {
  const day = date || todayIn(config.timezone);
  const record = readDay(day);

  const out = {
    ok: true,
    date: day,
    checkedAt: iso(),
    timezone: config.timezone,
    problems: [],
    slots: [],
    // Worth knowing on every check: if this is off, silence means nothing.
    messaging: notify.configured(),
    // Likewise the voice. A reel without a voiceover is still a reel, so this
    // never makes the day "not ok" — but it should be visible before somebody
    // wonders why the reels went quiet.
    voice: voice.configured(),
  };

  if (!record) {
    out.ok = false;
    out.problems.push(`Nothing is written for ${day}`);
    return withToken(out);
  }

  for (const post of record.posts) {
    const fb = post.facebook ?? {};
    const ig = post.instagram;
    const due = Date.parse(fb.dueAt ?? 0);
    const overdue = due && now - due > OVERDUE_MS;

    const row = {
      slot: post.slot,
      held: Boolean(post.hold),
      facebook: fb.status ?? 'none',
      instagram: ig ? ig.status : 'off',
      dueAt: fb.dueAt ?? null,
      permalink: fb.permalink ?? null,
      instagramPermalink: ig?.permalink ?? null,
      // Absent when no reel was uploaded — normal for the daytime slots.
      // False means the voice failed and the reel went out silent.
      reelHasAudio: post.reel ? (post.reel.hasAudio ?? null) : null,
    };
    out.slots.push(row);

    if (post.hold) continue;

    // Not a failure — the post still goes — but the one fault that is
    // invisible from the outside, so it is named rather than left to a report.
    if (post.reel && post.reel.hasAudio === false) {
      out.problems.push(`${post.slot}: the reel has no audio — the voice failed`);
    }

    if (['failed', 'failed_to_publish', 'too_late'].includes(fb.status)) {
      out.ok = false;
      out.problems.push(`${post.slot} did not go out on Facebook — ${fb.error || fb.status}`);
    } else if (overdue && PENDING.has(fb.status)) {
      out.ok = false;
      out.problems.push(
        `${post.slot} was due on Facebook at ${fb.dueAt} and is still ${fb.status}`);
    } else if (overdue && !LIVE.has(fb.status)) {
      out.ok = false;
      out.problems.push(`${post.slot} is past its Facebook slot and is ${fb.status}`);
    }

    if (ig) {
      const igDue = Date.parse(ig.dueAt ?? 0);
      const igOverdue = igDue && now - igDue > OVERDUE_MS;
      if (['failed', 'failed_final', 'missed'].includes(ig.status)) {
        out.ok = false;
        out.problems.push(`${post.slot} did not go out on Instagram — ${ig.error || ig.status}`);
      } else if (igOverdue && PENDING.has(ig.status)) {
        out.ok = false;
        out.problems.push(
          `${post.slot} was due on Instagram at ${ig.dueAt} and is still ${ig.status}`);
      }
    }
  }

  return withToken(out);
}

/**
 * The token is checked here too, because a token that has quietly expired is
 * the thing most likely to break tomorrow rather than today, and this is the
 * only routine that runs every day whether or not anyone is looking.
 */
async function withToken(out) {
  if (config.dryRun || !config.pageToken) {
    out.token = { dryRun: true };
    return out;
  }
  try {
    const t = await meta.inspectToken();
    const daysLeft = t.dataAccessExpiresAt
      ? Math.round((t.dataAccessExpiresAt * 1000 - Date.now()) / 86_400_000) : null;
    out.token = {
      type: t.type,
      permanent: t.neverExpires,
      pageMatches: String(t.profileId) === String(config.pageId),
      missingScopes: meta.missingScopes(t.scopes),
      dataAccessExpiresAt: t.dataAccessExpiresAt
        ? new Date(t.dataAccessExpiresAt * 1000).toISOString().slice(0, 10) : null,
      dataAccessDaysLeft: daysLeft,
    };
    if (!t.neverExpires) { out.ok = false; out.problems.push('The Page token is not permanent'); }
    if (!out.token.pageMatches) { out.ok = false; out.problems.push('The token is for a different Page'); }
    if (out.token.missingScopes.length) {
      out.ok = false;
      out.problems.push(`The token is missing scopes: ${out.token.missingScopes.join(', ')}`);
    }
    // Fourteen days is enough notice to renew without hurrying.
    if (daysLeft !== null && daysLeft <= 14) {
      out.ok = false;
      out.problems.push(
        `Meta data access expires in ${daysLeft} days (${out.token.dataAccessExpiresAt})`);
    }
  } catch (err) {
    out.ok = false;
    out.token = { error: err.message };
    out.problems.push(`The token could not be checked: ${err.message}`);
  }
  return out;
}

/**
 * The same verdict, stripped of everything that is nobody else's business.
 *
 * Public on purpose. The authenticated check needs a token, which means the
 * thing best placed to raise the alarm — a scheduled task, or whoever is
 * helping at the time — cannot ask the question. This can be asked by anyone,
 * and gives away nothing the Page does not already show: no captions, no post
 * ids, no links, no token, no dates beyond the day itself.
 */
export async function pulse(opts) {
  const full = await check(opts);
  return {
    ok: full.ok,
    date: full.date,
    checkedAt: full.checkedAt,
    // Counts and statuses only.
    slots: full.slots.map((s) => ({
      slot: s.slot, facebook: s.facebook, instagram: s.instagram, held: s.held,
      // null when no reel was uploaded for that slot, which is normal for the
      // two daytime slots. False means a reel exists and has no audio — the
      // voice failed and three video platforms are about to get silence.
      reelHasAudio: s.reelHasAudio ?? null,
    })),
    // Hoisted so a watchman does not have to walk the slots to find it.
    silentReel: full.slots.some((s) => s.reelHasAudio === false),
    trouble: full.problems.length,
    messaging: full.messaging,
    voice: full.voice,
    tokenOk: full.token
      ? (full.token.dryRun ? null
         : Boolean(full.token.permanent && full.token.pageMatches &&
                   !(full.token.missingScopes || []).length))
      : null,
    dataAccessDaysLeft: full.token?.dataAccessDaysLeft ?? null,
  };
}
