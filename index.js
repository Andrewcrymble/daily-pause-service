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
import { writeFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { config, cardsDir, reelsDir, ensureDirs, configProblems } from './config.js';
import { prune, usage } from './prune.js';
import { zonedToUtc, todayIn, isDateString } from './time.js';
import { readDay, writeDay, listDays, updatePost, deleteDay } from './store.js';
import { scheduleFacebook, publishInstagram, publishFacebookNow, verifyFacebook,
         cardUrl, cardFile, reelUrl, reelFile } from './publisher.js';
import { check as dayCheck, pulse as dayPulse } from './check.js';
import * as notify from './notify.js';
import * as voice from './voice.js';
import { overview as statsOverview } from './insights.js';
import * as meta from './meta.js';
import { start as startScheduler, log as schedulerLog } from './scheduler.js';
import { DASHBOARD_HTML } from './dashboard.js';

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

// The shapes a card can be drawn in. The square is the one Facebook and
// Instagram are posted from directly; the rest exist so one idea can be a feed
// post, a story and a pin without being written twice.
const CARD_FORMATS = ['square', 'portrait', 'story', 'pin'];

/**
 * Write every shape supplied for one slot and describe them.
 * `imageBase64` is the square and is required; `images` carries the rest.
 */
function writeCards(date, slot, imageBase64, images = {}) {
  const warnings = [];
  const formats = {};

  const all = { square: imageBase64, ...images };
  for (const [format, data] of Object.entries(all)) {
    if (data === undefined || data === null || data === '') continue;
    if (!CARD_FORMATS.includes(format)) bad(`${slot}: unknown card shape ${format}`);

    const { buf, type } = decodeCard(data);
    if (buf.length < 1024) {
      bad(`${slot}: the ${format} card is missing or implausibly small`);
    }
    if (type && type !== 'image/jpeg') {
      warnings.push(`${slot}: the ${format} card is ${type}; Instagram wants JPEG`);
    }
    const file = cardFile(date, slot, format);
    writeFileSync(join(cardsDir, file), buf);
    formats[format] = { file, bytes: buf.length, url: cardUrl(date, slot, format) };
  }

  if (!formats.square) bad(`${slot}: the square card is required`);
  return { formats, warnings };
}

function decodeCard(imageBase64) {
  const m = /^data:(image\/[a-z+]+);base64,/.exec(imageBase64 || '');
  const type = m ? m[1] : null;
  const raw = String(imageBase64 || '').replace(/^data:image\/[a-z+]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  return { buf, type };
}

// A reel arrives after the day does, because rendering one takes a minute and a
// half and the posts must not wait on it. Uploading is therefore its own step
// rather than part of accepting the day.
const MIN_REEL_BYTES = 50 * 1024;

function writeReel(date, slot, videoBase64) {
  const raw = String(videoBase64 || '').replace(/^data:video\/[a-z0-9-]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');

  if (buf.length < MIN_REEL_BYTES) {
    bad(`${slot}: the reel is missing or implausibly small`);
  }
  // 'ftyp' at offset 4 is the MP4 signature. Worth checking, because a file
  // that is not an MP4 fails silently and late — the platform accepts the URL
  // and rejects it hours afterwards, at the slot, with nobody watching.
  if (buf.subarray(4, 8).toString('latin1') !== 'ftyp') {
    bad(`${slot}: that does not look like an MP4`);
  }

  const file = reelFile(date, slot);
  writeFileSync(join(reelsDir, file), buf);
  return { file, bytes: buf.length, url: reelUrl(date, slot) };
}

async function acceptDay(body) {
  const { date, posts } = body;
  if (!isDateString(date)) bad('date must be yyyy-mm-dd');
  if (!Array.isArray(posts) || !posts.length) bad('posts must be a non-empty array');

  ensureDirs();
  const warnings = [];

  // Writing over a day that is already live on Meta would leave orphaned
  // scheduled posts behind and publish the same card twice. Refuse unless the
  // caller says so explicitly, and then undo the Meta side first.
  const existing = readDay(date);
  if (existing) {
    const live = existing.posts.filter(
      (p) => p.facebook?.status === 'scheduled' || p.instagram?.status === 'published'
    );
    if (live.length && !body.replace) {
      bad(`${date} is already live on Meta (${live.map((p) => p.slot).join(', ')}). ` +
          'Send replace: true to cancel and rewrite it, or edit the slots individually.');
    }
    for (const p of live) {
      if (p.instagram?.status === 'published') {
        warnings.push(`${p.slot}: already on Instagram — that post cannot be unsent`);
      }
      if (p.facebook?.status === 'scheduled' && p.facebook.postId) {
        if (config.dryRun) {
          warnings.push(`${p.slot}: previous Facebook post cancelled (dry run)`);
        } else {
          try {
            await meta.cancelFacebookPost(p.facebook.postId);
            warnings.push(`${p.slot}: previous Facebook post cancelled`);
          } catch (err) {
            warnings.push(`${p.slot}: could not cancel the previous Facebook post — ${err.message}`);
          }
        }
      }
    }
  }

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

    const written = writeCards(date, slot, p.imageBase64, p.images);
    warnings.push(...written.warnings);

    const [hh, mm] = config.slots[slot];
    const at = zonedToUtc(date, hh, mm, config.timezone);
    const igAt = new Date(at.getTime() + config.igDelayMinutes * 60_000);

    record.posts.push({
      slot,
      topic: p.topic ?? null,
      caption: String(p.caption),
      // The words ON the card, kept so the composer can reopen a day and edit
      // it rather than retyping from the picture.
      cardText: p.text ?? null,
      cardReference: p.reference ?? null,
      hold: Boolean(p.hold),
      holdReason: p.holdReason ?? null,
      // `url` stays the square so everything written before shapes existed
      // still reads correctly; `formats` is where the rest live.
      card: {
        file: written.formats.square.file,
        bytes: written.formats.square.bytes,
        url: written.formats.square.url,
        formats: written.formats,
      },
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
    messaging: {
      configured: notify.configured(),
      onSuccess: config.notifyOnSuccess,
      to: config.beepmateId ? String(config.beepmateId).slice(-4).padStart(8, '·') : null,
    },
    // The endpoint id is not a secret — it is half of a public URL. The key is,
    // and is never reported.
    voice: {
      configured: voice.configured(),
      endpoint: config.runpodEndpointId || null,
    },
    // What the volume is holding, and what it is set to keep. Nothing used to
    // report this, so nothing would have noticed it filling.
    volume: usage(),
    problems: configProblems(),
    days: listDays().slice(-7),
    slots: Object.keys(config.slots),
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
        // Absent insight scopes are not a problem — they just cap what the
        // stats page can show — so they are reported, not added to `problems`.
        missingInsightScopes: meta.missingInsightScopes(t.scopes),
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

  // The dashboard shell is public; every figure on it is fetched with the
  // bearer token the viewer types in, so nothing is exposed by serving this.
  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, DASHBOARD_HTML,
      { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  }

  // Public, deliberately. Statuses and counts, nothing else — so that a
  // scheduled task can raise the alarm without being handed a token.
  if (req.method === 'GET' && url.pathname === '/pulse') {
    const date = url.searchParams.get('date') || undefined;
    if (date && !isDateString(date)) bad('date must be yyyy-mm-dd');
    return send(res, 200, await dayPulse({ date }), { 'cache-control': 'no-store' });
  }

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

  // Reels, served the same way and for the same reason.
  if (req.method === 'GET' && seg[0] === 'reels' && seg.length === 2) {
    const name = normalize(seg[1]).replace(/^(\.\.[/\\])+/, '');
    if (!/^[\w.-]+\.mp4$/.test(name)) return send(res, 400, { error: 'bad reel name' });
    const path = join(reelsDir, name);
    if (!existsSync(path)) return send(res, 404, { error: 'no such reel' });
    const buf = readFileSync(path);
    return send(res, 200, buf, {
      'content-type': 'video/mp4',
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

  // Remove a day record, and optionally the files it named.
  //
  // This exists for the debris of testing — a held day written to rehearse the
  // pipeline, a date entered wrong — not for erasing history. A day with a post
  // that actually published is refused: the record of what the page said is the
  // one thing here that cannot be rebuilt.
  if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'days' && seg.length === 3) {
    const date = seg[2];
    if (!isDateString(date)) bad('date must be yyyy-mm-dd');
    const day = readDay(date);
    if (!day) return send(res, 404, { error: 'no record for that date' });

    const published = (day.posts || []).filter((p) =>
      p.facebook?.status === 'published' || p.instagram?.status === 'published');
    if (published.length && url.searchParams.get('force') !== '1') {
      return send(res, 409, {
        error: `${date} has ${published.length} published post(s); refusing to delete`,
        slots: published.map((p) => p.slot),
        hint: 'add ?force=1 only if you are certain',
      });
    }

    // Take the filenames from the record before removing it, or nothing is
    // left to say which files were this day's.
    const files = [];
    for (const post of day.posts || []) {
      if (post.card?.file) files.push(join(cardsDir, post.card.file));
      for (const f of Object.values(post.card?.formats || {})) {
        if (f?.file) files.push(join(cardsDir, f.file));
      }
      if (post.reel?.file) files.push(join(reelsDir, post.reel.file));
    }
    let removedFiles = 0;
    if (url.searchParams.get('keepFiles') !== '1') {
      for (const path of new Set(files)) {
        try {
          if (existsSync(path)) { unlinkSync(path); removedFiles += 1; }
        } catch { /* a file we cannot remove does not fail the delete */ }
      }
    }
    deleteDay(date);
    return send(res, 200, { deleted: date, posts: (day.posts || []).length, removedFiles });
  }

  // Housekeeping on demand. The scheduler does this daily; this is for seeing
  // what it would do, and for not waiting until tomorrow.
  if (req.method === 'POST' && url.pathname === '/api/prune') {
    const dryRun = url.searchParams.get('dryRun') === '1';
    return send(res, 200, prune({ dryRun }));
  }

  // The watchman. One object, no secrets, safe to paste anywhere: is today
  // all right? A scheduled task reads this after each slot and only speaks up
  // when ok is false.
  if (req.method === 'GET' && url.pathname === '/api/check') {
    const date = url.searchParams.get('date') || undefined;
    if (date && !isDateString(date)) bad('date must be yyyy-mm-dd');
    return send(res, 200, await dayCheck({ date }));
  }

  // Send yourself a message, to prove the wiring before relying on it.
  // Speak one short line and report what came back. Deliberately does not
  // return the audio — this answers "is the voice reachable", and a megabyte
  // of base64 in a diagnostic reply helps nobody.
  if (req.method === 'POST' && url.pathname === '/api/voice/test') {
    if (!voice.configured()) {
      return send(res, 400, { error: 'RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are not both set' });
    }
    const body = await readBody(req).catch(() => ({}));
    const line = String(body.text || 'Nothing needs deciding tonight.');

    const started = Date.now();
    const r = await voice.speak(line);
    if (r.error) return send(res, 502, { error: r.error, waited: Date.now() - started });

    return send(res, 200, {
      ok: true,
      spoke: line,
      seconds: r.seconds,
      bytes: r.audio.length,
      format: r.format,
      sampleRate: r.sampleRate,
      // model_load of 0 means the worker was already warm.
      timing: r.timing,
      settings: r.settings,
      waited: Date.now() - started,
    });
  }

  // Speak a line and hand back the audio.
  //
  // This exists so that nothing else has to hold the RunPod key. The reel
  // renderer already carries SERVICE_TOKEN; without this it would need the
  // RunPod credentials too, which would put the same secret in a second place
  // and make rotating it a two-job task instead of one.
  if (req.method === 'POST' && url.pathname === '/api/voice/speak') {
    if (!voice.configured()) {
      return send(res, 400, { error: 'RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are not both set' });
    }
    const body = await readBody(req);
    const line = String(body.text ?? '').trim();
    if (!line) return send(res, 400, { error: 'no text to speak' });

    // flac is roughly half the bytes of wav and every renderer reads it. The
    // caller chooses, because the default should be the obvious one.
    const format = body.format === 'flac' ? 'flac' : 'wav';
    const r = await voice.speak(line, { format });
    if (r.error) return send(res, 502, { error: r.error });

    return send(res, 200, {
      audio_b64: r.audio.toString('base64'),
      format: r.format,
      seconds: r.seconds,
      sampleRate: r.sampleRate,
      timing: r.timing,
      settings: r.settings,
    });
  }

  // Is the endpoint reachable at all? Cheaper than /api/voice/test because it
  // does not wake a worker.
  if (req.method === 'GET' && url.pathname === '/api/voice/health') {
    return send(res, 200, await voice.health());
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/test') {
    if (!notify.configured()) {
      return send(res, 400, { error: 'BEEPMATE_KEY and BEEPMATE_ID are not both set' });
    }
    const r = await notify.say(
      'The Daily Pause — this is a test. Messages are wired up correctly.');
    return send(res, r.error ? 502 : 200, r);
  }

  if (req.method === 'GET' && url.pathname === '/api/insights') {
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days')) || 30));
    const refresh = url.searchParams.get('refresh') === '1';
    return send(res, 200, await statsOverview({ days, refresh }));
  }

  if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'days' && seg.length === 5) {
    const [, , date, slot, action] = seg;
    const day = readDay(date);
    if (!day) return send(res, 404, { error: 'no record for that date' });
    const post = day.posts.find((p) => p.slot === slot);
    if (!post) return send(res, 404, { error: 'no such slot' });

    // --- edit the caption -------------------------------------------------
    // The caption is the words under the card, not the words on it. Instagram
    // reads it at publish time, so only Facebook needs telling.
    if (action === 'caption') {
      const body = await readBody(req);
      const caption = String(body.caption ?? '').trim();
      if (!caption) bad('caption cannot be empty');

      const out = { caption, facebook: 'not scheduled', instagram: 'will use the new caption' };
      if (post.facebook?.status === 'published') {
        return send(res, 409, { error: 'that post has already gone out on Facebook' });
      }
      if (post.facebook?.postId && post.facebook.status === 'scheduled' && !config.dryRun) {
        try {
          await meta.updatePostMessage(post.facebook.postId, caption);
          out.facebook = 'updated on Meta';
        } catch (err) {
          return send(res, 502, { error: `Facebook refused the edit: ${err.message}` });
        }
      } else if (config.dryRun) out.facebook = 'dry run';

      if (post.instagram?.status === 'published') out.instagram = 'already published — unchanged';
      updatePost(date, slot, (p) => { p.caption = caption; });
      return send(res, 200, { ...out, day: readDay(date) });
    }

    // --- attach the reel --------------------------------------------------
    // Separate from accepting the day on purpose: rendering a reel takes about
    // ninety seconds, and Facebook and Instagram must already be scheduled by
    // then. A reel that never arrives costs the video platforms, nothing else.
    if (action === 'reel') {
      const body = await readBody(req);
      const written = writeReel(date, slot, body.videoBase64);
      updatePost(date, slot, (p) => { p.reel = { ...written, at: iso() }; });
      return send(res, 200, { reel: written, day: readDay(date) });
    }

    // --- replace the card image ------------------------------------------
    // Meta will not swap the photo on a scheduled post, so this cancels and
    // rebuilds rather than editing.
    if (action === 'card') {
      const body = await readBody(req);

      if (post.instagram?.status === 'published') {
        return send(res, 409, { error: 'that post is already on Instagram' });
      }
      if (post.facebook?.status === 'published') {
        return send(res, 409, { error: 'that post has already gone out on Facebook' });
      }

      const written = writeCards(date, slot, body.imageBase64, body.images);
      const warnings = [...written.warnings];
      updatePost(date, slot, (p) => {
        p.card = {
          file: written.formats.square.file,
          bytes: written.formats.square.bytes,
          url: written.formats.square.url,
          // Shapes not resupplied keep whatever was there.
          formats: { ...(p.card?.formats ?? {}), ...written.formats },
        };
        if (body.text !== undefined) p.cardText = String(body.text);
        if (body.reference !== undefined) p.cardReference = body.reference || null;
      });

      let facebook = 'not scheduled';
      if (post.facebook?.postId && post.facebook.status === 'scheduled') {
        if (!config.dryRun) {
          try { await meta.cancelFacebookPost(post.facebook.postId); }
          catch (err) { warnings.push(`could not cancel the old Facebook post — ${err.message}`); }
        }
        updatePost(date, slot, (p) => {
          p.facebook = { dueAt: p.facebook.dueAt, status: 'pending' };
        });
        try {
          await scheduleFacebook(date, slot);
          facebook = 'rescheduled with the new card';
        } catch (err) {
          facebook = `failed: ${err.message}`;
          warnings.push(`Facebook rescheduling failed — ${err.message}`);
        }
      }
      return send(res, 200, { facebook, warnings, day: readDay(date) });
    }

    // --- hold and release -------------------------------------------------
    if (action === 'hold' || action === 'release') {
      const body = await readBody(req).catch(() => ({}));
      const hold = action === 'hold';
      const out = { hold, facebook: 'unchanged' };

      if (hold) {
        if (post.facebook?.postId && post.facebook.status === 'scheduled') {
          if (!config.dryRun) {
            try { await meta.cancelFacebookPost(post.facebook.postId); }
            catch (err) { return send(res, 502, { error: `could not hold it on Meta: ${err.message}` }); }
          }
          out.facebook = 'cancelled on Meta';
        }
        updatePost(date, slot, (p) => {
          p.hold = true;
          p.holdReason = body.reason ?? null;
          if (p.facebook) p.facebook = { dueAt: p.facebook.dueAt, status: 'held' };
          if (p.instagram && p.instagram.status !== 'published') p.instagram.status = 'held';
        });
      } else {
        updatePost(date, slot, (p) => {
          p.hold = false;
          p.holdReason = null;
          if (p.facebook) p.facebook = { dueAt: p.facebook.dueAt, status: 'pending' };
          if (p.instagram && p.instagram.status !== 'published') p.instagram.status = 'queued';
        });
        try {
          await scheduleFacebook(date, slot);
          out.facebook = 'scheduled';
        } catch (err) {
          out.facebook = `could not schedule: ${err.message}`;
        }
      }
      return send(res, 200, { ...out, day: readDay(date) });
    }

    // --- put it on Facebook now ------------------------------------------
    // The repair for a slot Meta failed to publish, or one written too close
    // to its time to schedule.
    if (action === 'facebook-now') {
      try {
        return send(res, 200, { facebook: await publishFacebookNow(date, slot),
                                day: readDay(date) });
      } catch (err) {
        return send(res, 502, { error: err.message, day: readDay(date) });
      }
    }

    // --- ask Meta whether it really published it --------------------------
    if (action === 'verify') {
      try {
        const state = await verifyFacebook(date, slot, Date.now());
        return send(res, 200, { state: state ?? 'not due for checking yet',
                                day: readDay(date) });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    // --- (re)schedule Facebook for a slot that failed or was cancelled ----
    if (action === 'reschedule') {
      try {
        const r = await scheduleFacebook(date, slot);
        return send(res, 200, { facebook: r, day: readDay(date) });
      } catch (err) {
        return send(res, 502, { error: err.message, day: readDay(date) });
      }
    }

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
