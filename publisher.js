/**
 * The bit that decides what actually happens to a post, and records it.
 * Wraps meta.js so DRY_RUN can exercise everything except the Graph calls.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, cardsDir } from './config.js';
import { updatePost, readDay } from './store.js';
import * as meta from './meta.js';
import * as notify from './notify.js';

const iso = () => new Date().toISOString();

/**
 * Say it once. The flag is written before the send, so a BeepMate outage
 * cannot turn into the same message every thirty seconds for an hour.
 */
async function tell(date, slot, on, text) {
  if (config.notifyDryRun || !notify.configured()) return { skipped: true };
  let already = false;
  updatePost(date, slot, (p) => {
    p.notified = p.notified || {};
    already = Boolean(p.notified[on]);
    if (!already) p.notified[on] = iso();
  });
  if (already) return { skipped: 'already told' };
  return notify.say(text);
}

/**
 * The public address of a card. Instagram fetches this itself, and so will
 * anything that schedules on our behalf, so it has to be a real URL from the
 * internet rather than a path on disk.
 *
 * The square keeps its original name. Every other shape is suffixed, so a day
 * written before shapes existed still resolves.
 */
export function cardUrl(day, slot, format = 'square') {
  const name = format === 'square' ? `${day}-${slot}` : `${day}-${slot}-${format}`;
  return `${config.baseUrl}/cards/${name}.jpg`;
}

export function cardFile(day, slot, format = 'square') {
  return format === 'square' ? `${day}-${slot}.jpg` : `${day}-${slot}-${format}.jpg`;
}

/**
 * Where a slot's reel can be fetched from.
 *
 * Public, for the same reason the cards are: Instagram, TikTok and YouTube all
 * pull the file themselves and none of them carry a bearer token.
 */
export function reelUrl(day, slot) {
  return `${config.baseUrl}/reels/${reelFile(day, slot)}`;
}

export function reelFile(day, slot) {
  return `${day}-${slot}.mp4`;
}

/* ------------------------------------------------------- facebook ------- */

export async function scheduleFacebook(date, slot) {
  const day = readDay(date);
  const post = day.posts.find((p) => p.slot === slot);

  if (post.hold) return { skipped: 'held' };
  if (post.facebook?.status === 'scheduled') return { skipped: 'already scheduled' };

  const when = new Date(post.facebook.dueAt);

  if (config.dryRun) {
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'scheduled', postId: `dry_${date}_${slot}`,
                     verified: true, at: iso() };
    });
    return { postId: `dry_${date}_${slot}`, verified: true, dryRun: true };
  }

  try {
    const buf = readFileSync(join(cardsDir, `${date}-${slot}.jpg`));
    const r = await meta.scheduleFacebookPost({ imageBuffer: buf, caption: post.caption, when });
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'scheduled', postId: r.postId,
                     photoId: r.photoId, verified: r.verified, at: iso() };
    });
    return r;
  } catch (err) {
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'failed', error: err.message, at: iso() };
    });
    throw err;
  }
}

/* ------------------------------------------------------ instagram ------- */

export async function publishInstagram(date, slot, { force = false } = {}) {
  const day = readDay(date);
  const post = day.posts.find((p) => p.slot === slot);
  const ig = post.instagram;

  if (!ig) return { skipped: 'instagram off for this post' };
  if (post.hold) return { skipped: 'held' };
  if (ig.status === 'published') return { skipped: 'already published' };
  if (ig.status === 'cancelled' && !force) return { skipped: 'cancelled' };

  // Claim it before the call, so a tick that overruns cannot double-publish.
  updatePost(date, slot, (p) => { p.instagram.status = 'publishing'; p.instagram.at = iso(); });

  if (config.dryRun) {
    updatePost(date, slot, (p) => {
      p.instagram = { ...p.instagram, status: 'published',
                      mediaId: `dry_${date}_${slot}`, permalink: null, at: iso() };
    });
    return { mediaId: `dry_${date}_${slot}`, dryRun: true };
  }

  try {
    const r = await meta.publishInstagram({
      imageUrl: cardUrl(date, slot), caption: post.caption,
    });
    updatePost(date, slot, (p) => {
      p.instagram = { ...p.instagram, status: 'published', mediaId: r.mediaId,
                      permalink: r.permalink, at: iso() };
    });
    if (config.notifyOnSuccess) {
      await tell(date, slot, 'instagram',
        notify.wentOut({ slot, on: 'instagram', permalink: r.permalink }));
    }
    return r;
  } catch (err) {
    updatePost(date, slot, (p) => {
      p.instagram = { ...p.instagram, status: 'failed', error: err.message,
                      attempts: (p.instagram.attempts ?? 0) + 1, at: iso() };
    });
    throw err;
  }
}

/* --------------------------------------------- verifying and repairing --- */

// How long after a slot to wait before asking Meta whether the post really
// went out. Meta's own publish is not instant, and neither is its read-back.
const VERIFY_AFTER_MS = 10 * 60_000;

/**
 * For one post: ask Meta whether the Facebook post actually published, and
 * record the answer. Returns null when it is not yet time to ask.
 *
 * This exists because "scheduled" is a promise, not a fact. A post scheduled
 * under a token that is later replaced fails silently at its slot.
 */
export async function verifyFacebook(date, slot, now = Date.now()) {
  const day = readDay(date);
  const post = day?.posts.find((p) => p.slot === slot);
  if (!post) return null;

  const fb = post.facebook;
  if (!fb || fb.status !== 'scheduled' || !fb.postId) return null;
  if (now - Date.parse(fb.dueAt) < VERIFY_AFTER_MS) return null;

  if (config.dryRun) {
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'published', verifiedAt: iso() };
    });
    return { published: true, dryRun: true };
  }

  const state = await meta.postState(fb.postId);
  if (state.published && config.notifyOnSuccess) {
    await tell(date, slot, 'facebook',
      notify.wentOut({ slot, on: 'facebook', permalink: state.permalink }));
  } else if (!state.published && !state.scheduled) {
    await tell(date, slot, 'facebook', notify.didNot({
      date, slot, on: 'facebook',
      reason: state.missing
        ? 'Meta no longer has this post — it cannot publish it.'
        : (state.error || 'Meta did not publish it at its slot.'),
    }));
  }
  updatePost(date, slot, (p) => {
    if (state.published) {
      p.facebook = { ...p.facebook, status: 'published', permalink: state.permalink,
                     verifiedAt: iso() };
    } else if (state.scheduled) {
      // Meta still has it queued. Late, but not lost.
      p.facebook = { ...p.facebook, verifiedAt: iso() };
    } else {
      p.facebook = { ...p.facebook, status: 'failed_to_publish', verifiedAt: iso(),
                     error: state.missing
                       ? 'Meta no longer has this post — it cannot publish'
                       : (state.error || 'Meta did not publish it') };
    }
  });
  return state;
}

/**
 * Put a post on Facebook now, rather than at a slot. The repair for a slot
 * that failed, was missed, or was written too close to its time.
 */
export async function publishFacebookNow(date, slot) {
  const day = readDay(date);
  const post = day.posts.find((p) => p.slot === slot);
  if (!post) throw new Error(`No ${slot} post on ${date}`);
  if (post.facebook?.status === 'published') return { skipped: 'already published' };

  // If Meta still holds a broken scheduled post for this slot, take it away
  // first, or the page ends up with two.
  if (post.facebook?.postId && !config.dryRun) {
    try { await meta.cancelFacebookPost(post.facebook.postId); } catch { /* already gone */ }
  }

  if (config.dryRun) {
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'published', postId: `dry_now_${date}_${slot}`,
                     verified: true, publishedLate: true, at: iso() };
    });
    return { postId: `dry_now_${date}_${slot}`, dryRun: true };
  }

  try {
    const buf = readFileSync(join(cardsDir, `${date}-${slot}.jpg`));
    const r = await meta.publishFacebookNow({ imageBuffer: buf, caption: post.caption });
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'published', postId: r.postId,
                     photoId: r.photoId, permalink: r.permalink, verified: true,
                     publishedLate: true, at: iso() };
      // It was told about the failure; let it be told about the fix.
      if (p.notified) delete p.notified.facebook;
    });
    if (config.notifyOnSuccess) {
      await tell(date, slot, 'facebook',
        notify.wentOut({ slot, on: 'facebook', permalink: r.permalink, late: true }));
    }
    return r;
  } catch (err) {
    updatePost(date, slot, (p) => {
      p.facebook = { ...p.facebook, status: 'failed', error: err.message, at: iso() };
    });
    throw err;
  }
}
