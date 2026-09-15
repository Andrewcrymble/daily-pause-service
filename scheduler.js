/**
 * The clock. Two jobs on every tick: publish the Instagram posts that are due,
 * and check that the Facebook posts that were due actually went out.
 *
 * The second one was added on 14 September 2026, after a Facebook post failed
 * at its slot and nothing here noticed. Meta publishes an API-scheduled post
 * using the credentials that created it; the Page token had been replaced in
 * between, so the post died quietly in Business Suite while this service went
 * on believing it was scheduled. Trusting "scheduled" is trusting a promise.
 */
import { config } from './config.js';
import { dueInstagramJobs, dueFacebookVerifications, updatePost, readDay } from './store.js';
import { publishInstagram, verifyFacebook } from './publisher.js';
import { prune } from './prune.js';
import * as notify from './notify.js';

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;

// A post more than this far past its time is stale — publishing "the quiet
// hour" over breakfast because the service was down all night is worse than
// missing it. A missed slot costs nothing.
const TOO_LATE_MS = 90 * 60_000;

let timer = null;
let running = false;
export const log = [];

// Housekeeping runs once a day, not on every tick. It is last in the tick on
// purpose: publishing a post is the job, and sweeping the volume must never
// delay or break it.
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
let lastPrune = 0;

/** Tell Andrew a post did not go out. Once, and never at the cost of a tick. */
async function warn(date, slot, on, reason) {
  try {
    let already = false;
    updatePost(date, slot, (p) => {
      p.notified = p.notified || {};
      already = Boolean(p.notified[on]);
      if (!already) p.notified[on] = new Date().toISOString();
    });
    if (already) return;
    const r = await notify.say(notify.didNot({ date, slot, on, reason }));
    if (r.error) note({ event: 'notify_failed', date, slot, error: r.error });
  } catch (err) {
    note({ event: 'notify_failed', date, slot, error: err.message });
  }
}

function note(entry) {
  log.unshift({ at: new Date().toISOString(), ...entry });
  log.length = Math.min(log.length, 200);
  console.log(`[daily-pause] ${JSON.stringify(entry)}`);
}

export async function tick(now = Date.now()) {
  if (running) return;                    // never overlap; a container poll can run 2 minutes
  running = true;
  try {
    // Did the Facebook posts that were due actually publish?
    for (const { date, slot } of dueFacebookVerifications(now)) {
      try {
        const state = await verifyFacebook(date, slot, now);
        if (state && !state.published && !state.scheduled) {
          note({ event: 'facebook_did_not_publish', date, slot,
                 reason: state.missing ? 'Meta no longer has the post' : state.error });
        } else if (state && state.published) {
          note({ event: 'facebook_confirmed', date, slot });
        }
      } catch (err) {
        note({ event: 'verify_error', date, slot, error: err.message });
      }
    }

    for (const { date, slot } of dueInstagramJobs(now)) {
      const post = readDay(date).posts.find((p) => p.slot === slot);
      const ig = post.instagram;

      if (now - Date.parse(ig.dueAt) > TOO_LATE_MS) {
        updatePost(date, slot, (p) => { p.instagram.status = 'missed'; });
        note({ event: 'missed', date, slot, reason: 'too far past its slot' });
        await warn(date, slot, 'instagram',
          'It was more than 90 minutes past its slot, so it was deliberately not sent.');
        continue;
      }
      if ((ig.attempts ?? 0) >= MAX_ATTEMPTS) {
        updatePost(date, slot, (p) => { p.instagram.status = 'failed_final'; });
        note({ event: 'gave_up', date, slot, attempts: ig.attempts });
        await warn(date, slot, 'instagram',
          `Tried ${ig.attempts} times and gave up. Last error: ${ig.error || 'unknown'}`);
        continue;
      }
      if (ig.status === 'failed' && now - Date.parse(ig.at) < RETRY_AFTER_MS) continue;

      try {
        const r = await publishInstagram(date, slot);
        note({ event: r.skipped ? 'skipped' : 'published', date, slot, ...r });
      } catch (err) {
        note({ event: 'failed', date, slot, error: err.message });
      }
    }

    // Last, and only once a day. prune() never throws, so this cannot take the
    // tick with it; the worst it can do is report an error into the log.
    if (now - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = now;
      const r = prune({ now });
      if (r.error) note({ event: 'prune_error', error: r.error });
      else if (r.cards.removed || r.reels.removed) {
        note({ event: 'pruned', cards: r.cards.removed, reels: r.reels.removed,
               bytes: r.bytes });
      }
    }
  } finally {
    running = false;
  }
}

export function start() {
  if (timer) return;
  // Anything that fell due while the service was down is picked up on this
  // first tick, subject to the staleness rule above.
  tick().catch((e) => note({ event: 'tick_error', error: e.message }));
  timer = setInterval(
    () => tick().catch((e) => note({ event: 'tick_error', error: e.message })),
    config.tickMs
  );
  timer.unref?.();
}

export function stop() { if (timer) { clearInterval(timer); timer = null; } }
