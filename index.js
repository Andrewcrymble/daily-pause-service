/**
 * The Daily Pause posting service.
 *
 * Takes a day of three posts from the morning session, stores the cards and
 * serves them publicly (Instagram fetches them itself), schedules the Facebook
 * posts on Meta straight away, and holds the Instagram ones until their slot.
 *
 * No dependencies. Node 20+.
 */
import { createServer } from 'node:http';
import { writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { config, cardsDir, ensureDirs, configProblems } from './config.js';
import { zonedToUtc, todayIn, isDateString } from './time.js';
import { readDay, writeDay, listDays } from './store.js';
import { scheduleFacebook, publishInstagram, cardUrl } from './publisher.js';
import * as meta from './meta.js';
import { start as startScheduler, log as schedulerLog } from './scheduler.js';

const MAX_BODY = 25 * 1024 * 1024;

/** Bad input from the caller, not a fault in here — answers 400, not 500. */
class BadRequest extends Error {}
const bad = (msg) => { throw new BadRequest(msg); };
const iso = () => new Date().toISOString();

/* ------------------------------------------------------------- plumbing -- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body)
    ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': Buffer.isBuffer(body) ? 'image/jpeg' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function authorised(req) {
  if (!config.serviceToken) return false;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(config.serviceToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error(`Body is not JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ accepting -- */

function decodeCard(imageBase64) {
  const m = /^data:(image\/[a-z+]+);base64,/.exec(imageBase64 || '');
  const type = m ? m[1] : null;
  const raw = String(imageBase64 || '').replace(/^data:image\/[a-z+]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  return { buf, type };
}

async function acceptDay(body) {
  const { date, posts } = body;
  if (!isDateString(date)) bad('date must be yyyy-mm-dd');
  if (!Array.isArray(posts) || !posts.length) bad('posts must be a non-empty array');

  ensureDirs();
  const warnings = [];

  const record = {
    date,
    createdAt: readDay(date)?.createdAt ?? iso(),
    updatedAt: iso(),
    timezone: config.timezone,
    posts: [],
  };

  for (const p of posts) {
    const slot = String(p.slot || '');
    if (!config.slots[slot]) bad(`Unknown slot ${slot}`);
    if (!p.caption || !String(p.caption).trim()) bad(`${slot}: caption is required`);

    const { buf, type } = decodeCard(p.imageBase64);
    if (buf.length < 1024) bad(`${slot}: card image is missing or implausibly small`);
    if (type && type !== 'image/jpeg') {
      // Instagram is fussy about what it will fetch. Take it, but say so.
      warnings.push(`${slot}: card is ${type}; Instagram wants JPEG`);
    }
    writeFileSync(join(cardsDir, `${date}-${slot}.jpg`), buf);

    const [hh, mm] = config.slots[slot];
    const at = zonedToUtc(date, hh, mm, config.timezone);
    const igAt = new Date(at.getTime() + config.igDelayMinutes * 60_000);

    record.posts.push({
      slot,
      topic: p.topic ?? null,
      caption: String(p.caption),
      hold: Boolean(p.hold),
      holdReason: p.holdReason ?? null,
      card: { file: `${date}-${slot}.jpg`, bytes: buf.length, url: cardUrl(date, slot) },
      facebook: { dueAt: at.toISOString(), status: p.hold ? 'held' : 'pending' },
      instagram: p.instagram === false ? null
        : { dueAt: igAt.toISOString(), status: p.hold ? 'held' : 'queued', attempts: 0 },
    });
  }

  record.posts.sort((a, b) => a.slot.localeCompare(b.slot));
  writeDay(record);

  // Facebook is scheduled immediately — Meta holds it, and Andrew can read,
  // edit or cancel it in Business Suite before it goes.
  const results = {};
  for (const post of record.posts) {
    if (post.hold) { results[post.slot] = { facebook: 'held' }; continue; }
    if (Date.parse(post.facebook.dueAt) < Date.now() + 600_000) {
      // Under Facebook's ten-minute minimum. Not an error for the whole day.
      const day = readDay(date);
      day.posts.find((x) => x.slot === post.slot).facebook.status = 'too_late';
      writeDay(day);
      results[post.slot] = { facebook: 'too_late' };
      warnings.push(`${post.slot}: too close to its slot for Facebook to schedule`);
      continue;
    }
    try {
      results[post.slot] = { facebook: await scheduleFacebook(date, post.slot) };
    } catch (err) {
      results[post.slot] = { facebook: 'failed', error: err.message };
      warnings.push(`${post.slot}: Facebook scheduling failed — ${err.message}`);
    }
  }

  return { date, results, warnings, day: readDay(date) };
}

/* --------------------------------------------------------------- status -- */

async function status() {
  const out = {
    ok: true,
    now: iso(),
    today: todayIn(config.timezone),
    timezone: config.timezone,
    dryRun: config.dryRun,
    baseUrl: config.baseUrl || null,
    igDelayMinutes: config.igDelayMinutes,
    problems: configProblems(),
    days: listDays().slice(-7),
    recent: schedulerLog.slice(0, 20),
  };

  if (!config.dryRun && config.pageToken) {
    try {
      const t = await meta.inspectToken();
      out.token = {
        type: t.type, neverExpires: t.neverExpires,
        expiresAt: t.expiresAt ? new Date(t.expiresAt * 1000).toISOString() : null,
        // Meta's data-access permission lapses 90 days after it is granted,
        // separately from the token's own expiry. This is the one that bites.
        dataAccessExpiresAt: t.dataAccessExpiresAt
          ? new Date(t.dataAccessExpiresAt * 1000).toISOString() : null,
        missingScopes: meta.missingScopes(t.scopes),
        pageMatches: String(t.profileId) === String(config.pageId),
      };
      if (!t.neverExpires) out.problems.push('Page token expires — it is not a permanent one');
      if (out.token.missingScopes.length) {
        out.problems.push(`Token is missing scopes: ${out.token.missingScopes.join(', ')}`);
      }
    } catch (e) {
      out.token = { error: e.message };
      out.problems.push(`Token check failed: ${e.message}`);
    }

    try {
      const igId = await meta.linkedInstagram();
      out.instagram = { linkedAccountId: igId, configured: config.igUserId || null,
                        matches: igId && igId === config.igUserId };
      if (!igId) out.problems.push('No Instagram account is connected to the Page');
    } catch (e) {
      out.instagram = { error: e.message };
    }
  }

  out.ok = out.problems.length === 0;
  return out;
}

/* --------------------------------------------------------------- routes -- */

async function route(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, { ok: true, at: iso() });
  }

  // Public: Instagram fetches these itself, unauthenticated.
  if (req.method === 'GET' && seg[0] === 'cards' && seg.length === 2) {
    const name = normalize(seg[1]).replace(/^(\.\.[/\\])+/, '');
    if (!/^[\w.-]+\.jpg$/.test(name)) return send(res, 400, { error: 'bad card name' });
    const path = join(cardsDir, name);
    if (!existsSync(path)) return send(res, 404, { error: 'no such card' });
    const buf = readFileSync(path);
    return send(res, 200, buf, {
      'content-length': String(statSync(path).size),
      'cache-control': 'public, max-age=86400, immutable',
    });
  }

  if (!authorised(req)) return send(res, 401, { error: 'unauthorised' });

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, await status());
  }

  if (req.method === 'POST' && url.pathname === '/api/days') {
    const body = await readBody(req);
    return send(res, 200, await acceptDay(body));
  }

  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'days') {
    if (seg.length === 2) return send(res, 200, { days: listDays() });
    const day = readDay(seg[2]);
    return day ? send(res, 200, day) : send(res, 404, { error: 'no record for that date' });
  }

  if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'days' && seg.length === 5) {
    const [, , date, slot, action] = seg;
    const day = readDay(date);
    if (!day) return send(res, 404, { error: 'no record for that date' });
    const post = day.posts.find((p) => p.slot === slot);
    if (!post) return send(res, 404, { error: 'no such slot' });

    if (action === 'cancel') {
      const out = { instagram: 'cancelled', facebook: null };
      if (post.instagram && post.instagram.status !== 'published') {
        post.instagram.status = 'cancelled';
      } else if (post.instagram?.status === 'published') {
        out.instagram = 'already published — cannot be unsent';
      }
      // Deleting the Facebook post is deliberately left to Andrew in Business
      // Suite. This service does not delete things on Meta's side.
      out.facebook = post.facebook?.postId
        ? `delete post ${post.facebook.postId} in Business Suite`
        : 'nothing scheduled';
      writeDay(day);
      return send(res, 200, out);
    }

    if (action === 'publish-now') {
      try {
        return send(res, 200, await publishInstagram(date, slot, { force: true }));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    return send(res, 404, { error: 'unknown action' });
  }

  return send(res, 404, { error: 'not found' });
}

/* ----------------------------------------------------------------- boot -- */

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof BadRequest || /Body is not JSON|Body too large/.test(err.message)) {
        if (!res.headersSent) send(res, 400, { error: err.message });
        return;
      }
      console.error('[daily-pause]', err);
      if (!res.headersSent) send(res, 500, { error: err.message });
    }
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  ensureDirs();
  const problems = configProblems();
  if (problems.length) {
    console.warn('[daily-pause] configuration problems:');
    for (const p of problems) console.warn(`  - ${p}`);
  }
  startScheduler();
  createApp().listen(config.port, () => {
    console.log(`[daily-pause] listening on :${config.port}` +
                (config.dryRun ? ' (DRY RUN — no Graph calls)' : ''));
  });
}
