/**
 * The clock. Ticks, finds Instagram jobs that are due, publishes them.
 *
 * Facebook needs nothing here — those posts are scheduled on Meta's side the
 * moment the day is accepted, and Meta fires them.
 */
import { config } from './config.js';
import { dueInstagramJobs, updatePost, readDay } from './store.js';
import { publishInstagram } from './publisher.js';

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;

// A post more than this far past its time is stale — publishing "the quiet
// hour" over breakfast because the service was down all night is worse than
// missing it. A missed slot costs nothing.
const TOO_LATE_MS = 90 * 60_000;

let timer = null;
let running = false;
export const log = [];

function note(entry) {
  log.unshift({ at: new Date().toISOString(), ...entry });
  log.length = Math.min(log.length, 200);
  console.log(`[daily-pause] ${JSON.stringify(entry)}`);
}

export async function tick(now = Date.now()) {
  if (running) return;                    // never overlap; a container poll can run 2 minutes
  running = true;
  try {
    for (const { date, slot } of dueInstagramJobs(now)) {
      const post = readDay(date).posts.find((p) => p.slot === slot);
      const ig = post.instagram;

      if (now - Date.parse(ig.dueAt) > TOO_LATE_MS) {
        updatePost(date, slot, (p) => { p.instagram.status = 'missed'; });
        note({ event: 'missed', date, slot, reason: 'too far past its slot' });
        continue;
      }
      if ((ig.attempts ?? 0) >= MAX_ATTEMPTS) {
        updatePost(date, slot, (p) => { p.instagram.status = 'failed_final'; });
        note({ event: 'gave_up', date, slot, attempts: ig.attempts });
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
