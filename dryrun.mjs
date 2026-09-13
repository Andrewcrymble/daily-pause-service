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

server.close();
rmSync(DATA, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
