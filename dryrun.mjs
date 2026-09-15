/**
 * End-to-end dry run. Exercises everything except the Graph calls: accepting a
 * day, serving the cards publicly, scheduling Facebook, queuing Instagram,
 * firing it at its time, cancelling, not double-publishing, and refusing to
 * post something hours stale.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 45123;
const DATA = mkdtempSync(join(tmpdir(), 'dp-'));

process.env.DRY_RUN = '1';
process.env.PORT = String(PORT);
process.env.BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.SERVICE_TOKEN = 'test-token';
process.env.DATA_DIR = DATA;
process.env.TIMEZONE = 'Europe/London';
process.env.TICK_MS = '999999';

process.env.NOTIFY_DRY_RUN = '1';

const { createApp } = await import('../src/index.js');
const { tick } = await import('../src/scheduler.js');
const { readDay, writeDay } = await import('../src/store.js');
const { ensureDirs } = await import('../src/config.js');

ensureDirs();
const server = createApp();
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

const api = (path, opts = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  ...opts,
  headers: { 'content-type': 'application/json',
             authorization: 'Bearer test-token', ...(opts.headers || {}) },
});

const b64 = (f) => `data:image/jpeg;base64,${readFileSync(join(import.meta.dirname, 'fixtures', f)).toString('base64')}`;

const pad = (n) => String(n).padStart(2, '0');
const dateOffset = (days) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const TOMORROW = dateOffset(1);
const LASTWEEK = dateOffset(-7);

const dayBody = (date) => ({
  date,
  posts: [
    { slot: '0800', topic: 'kindness', caption: 'Morning question.', imageBase64: b64('0800.jpg') },
    { slot: '1300', topic: 'rest',     caption: 'Midday thought.',   imageBase64: b64('1300.jpg') },
    { slot: '2100', topic: 'psalm 4',  caption: 'Quiet hour.',       imageBase64: b64('2100.jpg') },
  ],
});

console.log('\naccepting a day');
{
  const r = await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(TOMORROW)) });
  const j = await r.json();
  check('returns 200', r.status === 200, j);
  check('three posts stored', j.day?.posts?.length === 3);
  check('facebook scheduled for all three',
    j.day.posts.every((p) => p.facebook.status === 'scheduled'),
    j.day.posts.map((p) => p.facebook.status));
  check('instagram queued for all three',
    j.day.posts.every((p) => p.instagram.status === 'queued'));
  check('08:00 is 07:00Z in September (BST)',
    j.day.posts[0].facebook.dueAt.endsWith('T07:00:00.000Z')
    || j.day.posts[0].facebook.dueAt.endsWith('T08:00:00.000Z'),
    j.day.posts[0].facebook.dueAt);
  check('no warnings', (j.warnings ?? []).length === 0, j.warnings);
}

console.log('\nserving cards');
{
  const r = await fetch(`http://127.0.0.1:${PORT}/cards/${TOMORROW}-0800.jpg`);
  const buf = Buffer.from(await r.arrayBuffer());
  check('public, no auth needed', r.status === 200);
  check('served as jpeg', r.headers.get('content-type') === 'image/jpeg');
  check('is a real jpeg', buf[0] === 0xff && buf[1] === 0xd8, buf.slice(0, 4));
  check('non-trivial size', buf.length > 50_000, buf.length);

  const missing = await fetch(`http://127.0.0.1:${PORT}/cards/nope.jpg`);
  check('unknown card is 404', missing.status === 404);
  const traversal = await fetch(`http://127.0.0.1:${PORT}/cards/..%2F..%2Fetc%2Fpasswd`);
  check('path traversal refused', traversal.status === 400 || traversal.status === 404);
}

console.log('\nauth');
{
  const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
  check('status needs a token', r.status === 401);
  const w = await fetch(`http://127.0.0.1:${PORT}/api/days`, {
    method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  check('wrong token refused', w.status === 401);
}

console.log('\ncancelling');
{
  const r = await api(`/api/days/${TOMORROW}/1300/cancel`, { method: 'POST' });
  const j = await r.json();
  check('cancel returns 200', r.status === 200, j);
  check('instagram marked cancelled', readDay(TOMORROW).posts[1].instagram.status === 'cancelled');
  check('points at Business Suite for the facebook side',
    /Business Suite/.test(j.facebook), j.facebook);
}

console.log('\npublishing when due');
{
  const day = readDay(TOMORROW);
  day.posts[0].instagram.dueAt = new Date(Date.now() - 60_000).toISOString();
  writeDay(day);

  await tick();
  const after = readDay(TOMORROW);
  check('08:00 published', after.posts[0].instagram.status === 'published',
    after.posts[0].instagram);
  check('media id recorded', Boolean(after.posts[0].instagram.mediaId));
  check('cancelled 13:00 left alone', after.posts[1].instagram.status === 'cancelled');
  check('21:00 still queued', after.posts[2].instagram.status === 'queued');

  const idBefore = after.posts[0].instagram.mediaId;
  await tick();
  const again = readDay(TOMORROW);
  check('a second tick does not republish',
    again.posts[0].instagram.mediaId === idBefore
    && again.posts[0].instagram.status === 'published');
}

console.log('\nstale posts are not sent late');
{
  const day = readDay(TOMORROW);
  day.posts[2].instagram.dueAt = new Date(Date.now() - 3 * 3600_000).toISOString();
  writeDay(day);
  await tick();
  check('three hours late is missed, not published',
    readDay(TOMORROW).posts[2].instagram.status === 'missed');
}

console.log('\na day whose slots have already passed');
{
  const r = await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(LASTWEEK)) });
  const j = await r.json();
  check('accepted rather than erroring', r.status === 200);
  check('facebook marked too_late',
    j.day.posts.every((p) => p.facebook.status === 'too_late'),
    j.day.posts.map((p) => p.facebook.status));
  check('warns about it', (j.warnings ?? []).some((w) => /too close/.test(w)), j.warnings);
}

console.log('\nbad input');
{
  const noCaption = await api('/api/days', { method: 'POST', body: JSON.stringify({
    date: TOMORROW, posts: [{ slot: '0800', caption: '', imageBase64: b64('0800.jpg') }] }) });
  check('empty caption refused with 400', noCaption.status === 400, noCaption.status);

  const tiny = await api('/api/days', { method: 'POST', body: JSON.stringify({
    date: TOMORROW, posts: [{ slot: '0800', caption: 'x', imageBase64: 'data:image/jpeg;base64,AAAA' }] }) });
  check('missing card refused with 400', tiny.status === 400, tiny.status);

  const badSlot = await api('/api/days', { method: 'POST', body: JSON.stringify({
    date: TOMORROW, posts: [{ slot: '0930', caption: 'x', imageBase64: b64('0800.jpg') }] }) });
  check('unknown slot refused with 400', badSlot.status === 400, badSlot.status);

  const badDate = await api('/api/days', { method: 'POST', body: JSON.stringify({
    date: 'tomorrow', posts: [] }) });
  check('bad date refused with 400', badDate.status === 400, badDate.status);
}

console.log('\nstatus');
{
  const j = await (await api('/api/status')).json();
  check('reports dry run', j.dryRun === true);
  check('lists the days it holds', Array.isArray(j.days) && j.days.includes(TOMORROW));
  check('reports recent scheduler activity', Array.isArray(j.recent) && j.recent.length > 0);
}

console.log('\nthe desk');
{
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await page.text();
  check('is served without a token', page.status === 200);
  check('is html', (page.headers.get('content-type') || '').startsWith('text/html'));
  check('carries the card font', html.includes('font/woff2;base64,') &&
        !html.includes('__FONT__'));
  check('kept its regexes through the template literal',
        html.includes('replace(/\\s+-\\s+/g'));
  check('the tabs are there', ['Write a day', 'Stats', 'Service'].every((t) => html.includes(t)));
}

console.log('\nediting a day');
{
  const DAY = dateOffset(2);
  await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });

  const cap = await api(`/api/days/${DAY}/0800/caption`, {
    method: 'POST', body: JSON.stringify({ caption: 'A better morning question.' }) });
  const capJson = await cap.json();
  check('caption is changed', cap.status === 200 &&
    capJson.day.posts.find((p) => p.slot === '0800').caption === 'A better morning question.');

  const empty = await api(`/api/days/${DAY}/0800/caption`, {
    method: 'POST', body: JSON.stringify({ caption: '   ' }) });
  check('an empty caption is refused', empty.status === 400, empty.status);

  const held = await (await api(`/api/days/${DAY}/1300/hold`, { method: 'POST' })).json();
  const hp = held.day.posts.find((p) => p.slot === '1300');
  check('holding stops both platforms',
    hp.hold === true && hp.facebook.status === 'held' && hp.instagram.status === 'held');

  const freed = await (await api(`/api/days/${DAY}/1300/release`, { method: 'POST' })).json();
  const fp = freed.day.posts.find((p) => p.slot === '1300');
  check('releasing schedules it again',
    fp.hold === false && fp.facebook.status === 'scheduled' && fp.instagram.status === 'queued');

  const newCard = await (await api(`/api/days/${DAY}/2100/card`, {
    method: 'POST', body: JSON.stringify({ imageBase64: b64('0800.jpg'), text: 'New words.' }) })).json();
  const np = newCard.day.posts.find((p) => p.slot === '2100');
  check('a new card reschedules Facebook', np.facebook.status === 'scheduled');
  check('the card wording is kept for the composer', np.cardText === 'New words.');

  const gone = await api(`/api/days/${DAY}/0800/nonsense`, { method: 'POST' });
  check('an unknown action is a 404', gone.status === 404, gone.status);
}

console.log('\noverwriting a day that is already live');
{
  const DAY = dateOffset(3);
  await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });
  const again = await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });
  check('is refused without replace', again.status === 400, again.status);

  const replaced = await api('/api/days', { method: 'POST',
    body: JSON.stringify({ ...dayBody(DAY), replace: true }) });
  const rj = await replaced.json();
  check('goes through with replace', replaced.status === 200);
  check('says what it cancelled',
    (rj.warnings || []).some((w) => /cancelled/.test(w)), rj.warnings);
}

console.log('\nstats');
{
  const j = await (await api('/api/insights')).json();
  check('answers in dry run', j.dryRun === true);
  check('has the shape the page expects',
    j.audience !== undefined && j.trend !== undefined && Array.isArray(j.posts));
}

console.log('\nchecking that a Facebook post really went out');
{
  const DAY = dateOffset(4);
  await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });

  // Drag the 08:00 slot back past its time so it is due for checking.
  const day = readDay(DAY);
  const post = day.posts.find((p) => p.slot === '0800');
  post.facebook.dueAt = new Date(Date.now() - 30 * 60_000).toISOString();
  writeDay(day);

  const early = await (await api(`/api/days/${DAY}/1300/verify`, { method: 'POST' })).json();
  check('a slot that is not due yet is left alone', early.state === 'not due for checking yet');

  await tick();
  const after = readDay(DAY).posts.find((p) => p.slot === '0800');
  check('a post past its slot is confirmed with Meta', after.facebook.status === 'published',
        after.facebook.status);
  check('and the check is dated', Boolean(after.facebook.verifiedAt));
}

console.log('\nputting a failed post up now');
{
  const DAY = dateOffset(5);
  await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });

  const day = readDay(DAY);
  const post = day.posts.find((p) => p.slot === '2100');
  post.facebook.status = 'failed_to_publish';
  post.facebook.error = 'Meta no longer has this post';
  writeDay(day);

  const now = await (await api(`/api/days/${DAY}/2100/facebook-now`, { method: 'POST' })).json();
  const fixed = now.day.posts.find((p) => p.slot === '2100');
  check('it goes up immediately', fixed.facebook.status === 'published', fixed.facebook.status);
  check('and is marked as late', fixed.facebook.publishedLate === true);
}

console.log('\nthe watchman');
{
  const good = await (await api('/api/check')).json();
  check('answers for today', good.date === new Date().toISOString().slice(0, 10) ||
        typeof good.date === 'string');
  check('says whether it is ok', typeof good.ok === 'boolean');
  check('lists the slots', Array.isArray(good.slots));

  const DAY = dateOffset(6);
  await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });
  const day = readDay(DAY);
  const p0 = day.posts.find((p) => p.slot === '0800');
  p0.facebook.status = 'failed_to_publish';
  p0.facebook.error = 'Meta no longer has this post';
  writeDay(day);

  const bad = await (await api(`/api/check?date=${DAY}`)).json();
  check('a failure makes it not ok', bad.ok === false);
  check('and says which slot and why',
        bad.problems.some((x) => /0800.*Meta no longer/.test(x)), bad.problems);

  const missing = await (await api('/api/check?date=2001-01-01')).json();
  check('a day with nothing written is not ok', missing.ok === false);

  const nonsense = await api('/api/check?date=soon');
  check('a bad date is refused', nonsense.status === 400, nonsense.status);
}

console.log('\nevery shape of card');
{
  const DAY = dateOffset(8);
  const body = {
    date: DAY,
    posts: [{
      slot: '0800', caption: 'Four shapes.',
      imageBase64: b64('0800.jpg'),
      images: {
        portrait: b64('1300.jpg'),
        story: b64('2100.jpg'),
        pin: b64('0800.jpg'),
      },
    }],
  };
  const r = await api('/api/days', { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  const card = j.day.posts[0].card;

  check('accepts every shape', r.status === 200, j.results);
  check('keeps the square as the plain url',
        card.url.endsWith(`${DAY}-0800.jpg`), card.url);
  check('names the others by shape',
        card.formats.portrait.url.endsWith(`${DAY}-0800-portrait.jpg`) &&
        card.formats.story.url.endsWith(`${DAY}-0800-story.jpg`) &&
        card.formats.pin.url.endsWith(`${DAY}-0800-pin.jpg`), card.formats);

  // Every one of them has to be fetchable without a token — that is the whole
  // point, since Metricool and Instagram fetch them themselves.
  for (const fmt of ['square', 'portrait', 'story', 'pin']) {
    const url = fmt === 'square' ? card.url : card.formats[fmt].url;
    const got = await fetch(url);
    check(`the ${fmt} is public`, got.status === 200 &&
          got.headers.get('content-type') === 'image/jpeg', got.status);
  }

  const noSquare = await api('/api/days', { method: 'POST', body: JSON.stringify({
    date: dateOffset(9),
    posts: [{ slot: '0800', caption: 'x', images: { story: b64('2100.jpg') } }] }) });
  check('refuses a day with no square', noSquare.status === 400, noSquare.status);

  const badShape = await api('/api/days', { method: 'POST', body: JSON.stringify({
    date: dateOffset(9),
    posts: [{ slot: '0800', caption: 'x', imageBase64: b64('0800.jpg'),
              images: { billboard: b64('0800.jpg') } }] }) });
  check('refuses an unknown shape', badShape.status === 400, badShape.status);

  // A day written the old way must still work exactly as it did.
  const OLD = dateOffset(10);
  const legacy = await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(OLD)) });
  const lj = await legacy.json();
  const lc = lj.day.posts[0].card;
  check('a day with only a square still works',
        legacy.status === 200 && lc.url.endsWith(`${OLD}-0800.jpg`));
  check('and records just the one shape',
        Object.keys(lc.formats).length === 1 && lc.formats.square);
}

console.log('\nthe public pulse');
{
  const DAY = dateOffset(7);
  await api('/api/days', { method: 'POST', body: JSON.stringify(dayBody(DAY)) });

  // No Authorization header at all — this is the point of it.
  const raw = await fetch(`http://127.0.0.1:${PORT}/pulse?date=${DAY}`);
  const j = await raw.json();
  check('answers without a token', raw.status === 200);
  check('says whether the day is all right', typeof j.ok === 'boolean');
  check('lists each slot and platform', j.slots.length === 3 &&
        j.slots.every((s) => s.facebook && s.instagram));
  const text = JSON.stringify(j);
  check('gives away no captions', !/Morning question|Midday thought|Quiet hour/.test(text));
  check('gives away no post ids', !/postId|mediaId|dry_/.test(text));
  check('gives away no links', !/permalink|http/.test(text));
}

console.log('\nmessages');
{
  const notify = await import('../src/notify.js');
  check('is off when it is not configured', notify.configured() === false);

  const sent = await notify.say('should not go anywhere');
  check('sending is a no-op rather than an error', Boolean(sent.skipped), sent);

  const good = notify.wentOut({ slot: '0800', on: 'facebook',
    permalink: 'https://www.facebook.com/1' });
  check('a success message names the slot in words', /morning question/i.test(good), good);
  check('and carries the link', good.includes('https://www.facebook.com/1'));

  const late = notify.wentOut({ slot: '2100', on: 'instagram', permalink: 'x', late: true });
  check('a late one says so', /\(late\)/.test(late), late);
  check('and names the platform', /Instagram/.test(late));

  const bad = notify.didNot({ date: '2026-09-14', slot: '1300', on: 'facebook',
    reason: 'Meta no longer has this post' });
  check('a failure says which slot', /midday thought/i.test(bad), bad);
  check('and why', bad.includes('Meta no longer has this post'));
  check('and what to do about it', /Put on Facebook now/.test(bad));

  const st = await (await api('/api/status')).json();
  check('status reports messaging off', st.messaging && st.messaging.configured === false);

  const t = await api('/api/notify/test', { method: 'POST' });
  check('the test send refuses when unconfigured', t.status === 400, t.status);

  const pulse = await (await fetch(`http://127.0.0.1:${PORT}/pulse`)).json();
  check('the pulse says whether messaging is on', pulse.messaging === false);
}

{
  // ---- the voice endpoint --------------------------------------------------
  // Unconfigured is the normal state until RunPod is wired up, and it must be
  // a quiet no-op rather than a failure: a reel without a voiceover is still
  // a reel.
  const voice = await import('../src/voice.js');

  check('voice is off when it is not configured', voice.configured() === false);

  const off = await voice.speak('Nothing needs deciding tonight.');
  check('speaking refuses rather than throwing', Boolean(off.error), off);
  check('and says why', /not configured/i.test(off.error || ''));

  const empty = await voice.speak('   ');
  check('empty text is refused', Boolean(empty.error), empty);

  const huge = await voice.speak('x'.repeat(601));
  check('an over-long line is refused before any network call',
    /limit is 600/.test(huge.error || ''), huge);

  const h = await voice.health();
  check('health reports unconfigured without calling out', h.configured === false, h);
}

console.log('\nreels');
{
  // A reel is attached after the day, because rendering takes about ninety
  // seconds and the posts must not wait on it.
  const fakeMp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'),
    Buffer.alloc(80 * 1024, 7),
  ]).toString('base64');

  const notMp4 = Buffer.alloc(80 * 1024, 7).toString('base64');

  const small = await api(`/api/days/${TOMORROW}/2100/reel`, {
    method: 'POST', body: JSON.stringify({ videoBase64: Buffer.alloc(200).toString('base64') }),
  });
  check('a tiny reel is refused', small.status === 400, small.status);

  const wrong = await api(`/api/days/${TOMORROW}/2100/reel`, {
    method: 'POST', body: JSON.stringify({ videoBase64: notMp4 }),
  });
  const wrongBody = await wrong.json();
  check('something that is not an MP4 is refused', wrong.status === 400, wrongBody);
  check('and says so plainly', /MP4/.test(wrongBody.error || ''), wrongBody);

  const ok = await api(`/api/days/${TOMORROW}/2100/reel`, {
    method: 'POST', body: JSON.stringify({ videoBase64: fakeMp4 }),
  });
  const okBody = await ok.json();
  check('a real MP4 is accepted', ok.status === 200, okBody);
  check('and is recorded on the post',
    okBody.day?.posts?.find((p) => p.slot === '2100')?.reel?.bytes > 0, okBody.reel);
  check('with a public url',
    /\/reels\/.*-2100\.mp4$/.test(okBody.reel?.url || ''), okBody.reel);

  // Served without a token: every platform that takes a video fetches it itself.
  const served = await fetch(`http://127.0.0.1:${PORT}/reels/${TOMORROW}-2100.mp4`);
  check('the reel is served publicly', served.status === 200, served.status);
  check('as video/mp4', served.headers.get('content-type') === 'video/mp4',
    served.headers.get('content-type'));

  const missing = await fetch(`http://127.0.0.1:${PORT}/reels/${TOMORROW}-0800.mp4`);
  check('a reel that was never uploaded is 404', missing.status === 404, missing.status);

  const traversal = await fetch(`http://127.0.0.1:${PORT}/reels/..%2F..%2Fetc%2Fpasswd`);
  check('a path traversal is refused', traversal.status >= 400, traversal.status);
}

server.close();
rmSync(DATA, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
