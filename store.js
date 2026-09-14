/**
 * The record. One JSON file per day, written atomically.
 *
 * Three posts a day does not need a database, and a file you can open in a text
 * editor is worth a great deal when something has gone wrong at six in the
 * morning.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { daysDir, ensureDirs } from './config.js';

const pathFor = (date) => join(daysDir, `${date}.json`);

export function readDay(date) {
  const p = pathFor(date);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Day record for ${date} is unreadable: ${e.message}`);
  }
}

export function writeDay(day) {
  ensureDirs();
  const p = pathFor(day.date);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(day, null, 2));
  renameSync(tmp, p);       // rename is atomic; a crash mid-write cannot truncate
  return day;
}

export function listDays() {
  ensureDirs();
  return readdirSync(daysDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/** Every Instagram job that is due and has not gone yet, oldest first. */
export function dueInstagramJobs(now = Date.now()) {
  const out = [];
  for (const date of listDays()) {
    const day = readDay(date);
    if (!day) continue;
    for (const post of day.posts) {
      const ig = post.instagram;
      if (!ig || ig.status !== 'queued') continue;
      if (Date.parse(ig.dueAt) <= now) out.push({ date, slot: post.slot });
    }
  }
  return out.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
}

/**
 * Every Facebook post that claims to be scheduled and whose slot has passed.
 * These are the ones worth asking Meta about — "scheduled" is Meta's promise,
 * not its receipt.
 */
export function dueFacebookVerifications(now = Date.now(), graceMs = 600_000) {
  const out = [];
  for (const date of listDays().slice(-3)) {
    const day = readDay(date);
    if (!day) continue;
    for (const post of day.posts) {
      const fb = post.facebook;
      if (!fb || fb.status !== 'scheduled' || !fb.postId) continue;
      if (Date.parse(fb.dueAt) + graceMs <= now) out.push({ date, slot: post.slot });
    }
  }
  return out;
}

/**
 * Update one post in place and persist. Re-reads first so a concurrent write
 * from an HTTP request is not clobbered by the scheduler tick.
 */
export function updatePost(date, slot, mutate) {
  const day = readDay(date);
  if (!day) throw new Error(`No record for ${date}`);
  const post = day.posts.find((p) => p.slot === slot);
  if (!post) throw new Error(`No ${slot} post on ${date}`);
  mutate(post);
  day.updatedAt = new Date().toISOString();
  writeDay(day);
  return post;
}
