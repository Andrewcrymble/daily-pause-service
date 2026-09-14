/**
 * Telling Andrew what happened, over BeepMate (WhatsApp).
 *
 * One message per post per platform, sent when the outcome is actually known —
 * for Facebook that means after the post has been read back from Meta, not when
 * it was handed over. A message saying "it's up" that turns out to be wrong is
 * worse than no message.
 *
 * Nothing in here is allowed to break posting. Every send is wrapped, timed
 * out, and swallowed: a messaging service being down must never stop a card
 * going out, and must never fail a scheduler tick.
 */
import { config } from './config.js';

const ENDPOINT = 'https://beepmate.io/send';
const TIMEOUT_MS = 15_000;

export function configured() {
  return Boolean(config.beepmateKey && config.beepmateId);
}

/**
 * Send one message. Returns { sent } or { skipped } or { error } — never throws.
 * The key is never logged; only whether it worked.
 */
export async function say(text) {
  if (!configured()) return { skipped: 'BeepMate is not configured' };

  const url = new URL(ENDPOINT);
  url.searchParams.set('key', config.beepmateKey);
  url.searchParams.set('id', config.beepmateId);
  url.searchParams.set('msg', text);

  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await r.text()).slice(0, 200);
    if (!r.ok) return { error: `BeepMate answered ${r.status}: ${body}` };
    return { sent: true, response: body };
  } catch (err) {
    return { error: `BeepMate did not answer: ${err.message}` };
  }
}

const SLOT_NAME = {
  '0800': 'The morning question',
  '1300': 'The midday thought',
  '2100': 'The quiet hour',
};

const label = (slot) => SLOT_NAME[slot] || slot;
const platform = (p) => (p === 'instagram' ? 'Instagram' : 'Facebook');

/** "It went out." With the link, because the first thing you want is to look at it. */
export function wentOut({ slot, on, permalink, late }) {
  const lines = [
    `The Daily Pause — ${label(slot)} is on ${platform(on)}` + (late ? ' (late)' : ''),
  ];
  if (permalink) lines.push(permalink);
  else lines.push('No link came back from Meta, but it is published.');
  return lines.join('\n');
}

/** "It did not." With the reason, because the next question is always why. */
export function didNot({ slot, on, reason, date }) {
  return [
    `The Daily Pause — ${label(slot)} did NOT go out on ${platform(on)}`,
    reason || 'No reason given.',
    '',
    'Put it up: ' + (config.baseUrl || '') + '/  → Today → Put on Facebook now',
    date ? `(${date}, ${slot})` : '',
  ].filter(Boolean).join('\n');
}
