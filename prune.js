/**
 * Housekeeping for the volume.
 *
 * Nothing used to remove anything. A reel a day is about 1.3 MB and four cards
 * a slot about 400 kB, so the volume grew by roughly half a gigabyte a year and
 * would have gone on doing so until a morning when a card could not be written
 * and three posts did not go out. That is a silly way to lose a page.
 *
 * What is kept, and why the three answers differ:
 *
 * - **Day records** are kept for ever. They are a few kilobytes of JSON each and
 *   they are the page's memory — the 06:00 task reads the last fortnight so it
 *   does not repeat itself, and the record of what was said in March is worth
 *   more than the space it costs.
 * - **Cards** are kept for ninety days. Every platform that wants one fetches it
 *   at publish time and keeps its own copy; after that the file here is only
 *   useful for looking back at.
 * - **Reels** are kept for thirty. They are by far the largest thing here and
 *   the same logic applies — once YouTube and Instagram have taken their copy,
 *   this one is a convenience.
 *
 * Nothing is deleted that today's or tomorrow's record still points at, whatever
 * the retention says, because a card that vanishes before its slot is a failed
 * post rather than a tidy volume.
 */
import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, cardsDir, reelsDir, ensureDirs } from './config.js';
import { listDays, readDay } from './store.js';

const DAY_MS = 86_400_000;

/**
 * Every card and reel filename any day record still refers to.
 *
 * Read from the records rather than inferred from the date in the filename:
 * the record is the truth about what a post needs, and a file nobody points at
 * is exactly what this is for.
 */
export function referenced(dates = listDays()) {
  const keep = new Set();
  for (const date of dates) {
    let day;
    try {
      day = readDay(date);
    } catch {
      // An unreadable record is not licence to delete what it might have named.
      // Keep everything dated that day and let the error surface elsewhere.
      keep.add(`${date}:unreadable`);
      continue;
    }
    if (!day) continue;
    for (const post of day.posts || []) {
      if (post.card?.file) keep.add(post.card.file);
      for (const f of Object.values(post.card?.formats || {})) {
        if (f?.file) keep.add(f.file);
      }
      if (post.reel?.file) keep.add(post.reel.file);
    }
  }
  return keep;
}

function sweep(dir, keepDays, now, protectedNames, dryRun) {
  if (!existsSync(dir)) return { removed: [], bytes: 0, kept: 0 };
  const cutoff = now - keepDays * DAY_MS;
  const removed = [];
  let bytes = 0;
  let kept = 0;

  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    // A file still named by a recent record stays regardless of its age. The
    // dates in the filenames are not consulted — only what the records say.
    if (protectedNames.has(name) || st.mtimeMs > cutoff) {
      kept += 1;
      continue;
    }
    if (!dryRun) {
      try {
        unlinkSync(path);
      } catch (e) {
        continue;                       // a file we cannot remove is not an outage
      }
    }
    removed.push(name);
    bytes += st.size;
  }
  return { removed, bytes, kept };
}

/**
 * Remove cards and reels past their retention.
 *
 * Returns what it did — or, with { dryRun: true }, what it would do. Never
 * throws: housekeeping that can take the service down is worse than a full
 * disk, which at least announces itself.
 */
export function prune({ now = Date.now(), dryRun = false } = {}) {
  ensureDirs();
  const at = new Date(now).toISOString();
  try {
    // Recent records are the ones whose files must survive: a card for
    // tomorrow has no age to protect it, and neither does one uploaded today
    // for a day held months ahead.
    const recent = listDays().filter((d) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return Number.isFinite(t) && t > now - 14 * DAY_MS;
    });
    const keep = referenced(recent);

    const cards = sweep(cardsDir, config.keepCardDays, now, keep, dryRun);
    const reels = sweep(reelsDir, config.keepReelDays, now, keep, dryRun);

    return {
      at,
      dryRun,
      cards: { removed: cards.removed.length, kept: cards.kept, bytes: cards.bytes },
      reels: { removed: reels.removed.length, kept: reels.kept, bytes: reels.bytes },
      bytes: cards.bytes + reels.bytes,
      files: [...cards.removed, ...reels.removed],
    };
  } catch (e) {
    return { at, dryRun, error: e.message };
  }
}

/** What the volume currently holds. Cheap enough to put in /api/status. */
export function usage() {
  ensureDirs();
  const count = (dir) => {
    if (!existsSync(dir)) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const name of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, name));
        if (!st.isFile()) continue;
        files += 1;
        bytes += st.size;
      } catch { /* a file that vanished mid-count is not worth failing over */ }
    }
    return { files, bytes };
  };
  const cards = count(cardsDir);
  const reels = count(reelsDir);
  return {
    cards,
    reels,
    bytes: cards.bytes + reels.bytes,
    keepCardDays: config.keepCardDays,
    keepReelDays: config.keepReelDays,
  };
}
