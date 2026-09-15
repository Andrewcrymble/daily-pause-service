import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const bool = (v, d = false) =>
  v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v));
const int = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: int(process.env.PORT, 3000),

  // Public origin this service is reachable at. Instagram fetches the card
  // from here itself, so it must be a real https URL from the internet —
  // not localhost, not a private address.
  baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),

  pageId: process.env.FB_PAGE_ID || '',
  pageToken: process.env.FB_PAGE_TOKEN || '',
  igUserId: process.env.IG_USER_ID || '',

  // Shared secret for the write endpoints. The card URLs stay public because
  // Instagram has to fetch them unauthenticated.
  serviceToken: process.env.SERVICE_TOKEN || '',

  timezone: process.env.TIMEZONE || 'Europe/London',

  // Minutes Instagram trails Facebook. Facebook posts are scheduled and can be
  // cancelled in Business Suite; Instagram publishes live and cannot. A delay
  // here turns the Facebook queue into a proof-read for both.
  igDelayMinutes: int(process.env.IG_DELAY_MINUTES, 0),

  slots: { '0800': [8, 0], '1300': [13, 0], '2100': [21, 0] },

  dataDir: resolve(process.env.DATA_DIR || './data'),
  tickMs: int(process.env.TICK_MS, 30_000),

  // BeepMate — a WhatsApp message when a post goes out, and when one does not.
  // Optional: with these unset the service simply says nothing.
  beepmateKey: process.env.BEEPMATE_KEY || '',
  beepmateId: process.env.BEEPMATE_ID || '',
  // Turn this off to be told only about failures.
  notifyOnSuccess: bool(process.env.NOTIFY_ON_SUCCESS, true),

  // RunPod serverless — Andrew's voice for the reels. Optional: with these
  // unset the reel is simply made without a voiceover, which is how it has
  // always been made.
  runpodEndpointId: process.env.RUNPOD_ENDPOINT_ID || '',
  runpodApiKey: process.env.RUNPOD_API_KEY || '',

  // No Graph calls. Everything else runs for real.
  dryRun: bool(process.env.DRY_RUN),

  // No messages either. Set with DRY_RUN in tests.
  notifyDryRun: bool(process.env.NOTIFY_DRY_RUN),
};

export const cardsDir = resolve(config.dataDir, 'cards');
export const daysDir = resolve(config.dataDir, 'days');
// Reels live beside the cards and are served the same way — publicly, because
// every platform that takes a video fetches it itself.
export const reelsDir = resolve(config.dataDir, 'reels');

export function ensureDirs() {
  for (const d of [config.dataDir, cardsDir, daysDir, reelsDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function configProblems() {
  const out = [];
  if (!config.baseUrl) out.push('BASE_URL is not set — Instagram cannot fetch the cards');
  else if (!/^https:\/\//.test(config.baseUrl) && !config.dryRun)
    out.push('BASE_URL must be https — Instagram will not fetch over http');
  if (!config.serviceToken) out.push('SERVICE_TOKEN is not set — the write endpoints are unprotected');
  if (!config.dryRun) {
    if (!config.pageId) out.push('FB_PAGE_ID is not set');
    if (!config.pageToken) out.push('FB_PAGE_TOKEN is not set');
    if (!config.igUserId) out.push('IG_USER_ID is not set — Instagram publishing is off');
  }
  return out;
}
