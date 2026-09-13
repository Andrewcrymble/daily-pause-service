/**
 * The bit that decides what actually happens to a post, and records it.
 * Wraps meta.js so DRY_RUN can exercise everything except the Graph calls.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, cardsDir } from './config.js';
import { updatePost, readDay } from './store.js';
import * as meta from './meta.js';

const iso = () => new Date().toISOString();

export function cardUrl(day, slot) {
  return `${config.baseUrl}/cards/${day}-${slot}.jpg`;
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
    return r;
  } catch (err) {
    updatePost(date, slot, (p) => {
      p.instagram = { ...p.instagram, status: 'failed', error: err.message,
                      attempts: (p.instagram.attempts ?? 0) + 1, at: iso() };
    });
    throw err;
  }
}
