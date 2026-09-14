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
    };
    out.slots.push(row);

    if (post.hold) continue;

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
