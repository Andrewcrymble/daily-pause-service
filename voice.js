/**
 * Andrew's voice, from the RunPod worker.
 *
 * The endpoint sleeps between calls, so the first request of the day pays a
 * cold start of thirty to sixty seconds while the weights load. That is fine
 * for a job that runs before six in the morning and nowhere near fine for a
 * web request, which is why nothing here is called from a route.
 *
 * Like notify.js, this never throws. A reel without a voiceover is a reel;
 * a scheduler tick that dies because a GPU was busy is an outage.
 */
import { config } from './config.js';

const RUNSYNC = (id) => `https://api.runpod.ai/v2/${id}/runsync`;
const STATUS = (id, job) => `https://api.runpod.ai/v2/${id}/status/${job}`;

// Cold start plus generation, with room to spare. RunPod queues rather than
// refusing when every worker is busy, so the wait can legitimately be long.
const TIMEOUT_MS = 240_000;

// How long one HTTP call is given. `/runsync` gives up waiting after about
// ninety seconds and answers with the job still IN_QUEUE — that is not a
// failure, it is RunPod handing back the ticket so the caller can poll.
const CALL_MS = 120_000;
const POLL_MS = 3_000;

const DONE = new Set(['COMPLETED']);
const LOST = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT']);

// A Daily Pause line. Longer than this and something upstream is wrong.
const MAX_CHARS = 600;

export function configured() {
  return Boolean(config.runpodEndpointId && config.runpodApiKey);
}

/**
 * Speak one line.
 *
 * Returns { audio: Buffer, seconds, sampleRate, timing } on success, or
 * { error } — never both, never a throw.
 */
export async function speak(text, { format = 'wav', ...overrides } = {}) {
  // The caller's mistake is reported as the caller's mistake, before anything
  // about this end of the wire. A 601-character line is wrong whether or not
  // RunPod is configured, and saying "not configured" would send whoever is
  // debugging it to the wrong place entirely.
  const line = String(text || '').trim();
  if (!line) return { error: 'No text to speak' };
  if (line.length > MAX_CHARS) {
    return { error: `Text is ${line.length} characters; the limit is ${MAX_CHARS}` };
  }

  if (!configured()) return { error: 'The voice endpoint is not configured' };

  const auth = { Authorization: `Bearer ${config.runpodApiKey}` };
  const deadline = Date.now() + TIMEOUT_MS;

  let body;
  try {
    const r = await fetch(RUNSYNC(config.runpodEndpointId), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text: line, format, ...overrides } }),
      signal: AbortSignal.timeout(CALL_MS),
    });
    const raw = await r.text();
    if (!r.ok) return { error: `RunPod answered ${r.status}: ${raw.slice(0, 300)}` };
    body = JSON.parse(raw);
  } catch (err) {
    return { error: `The voice endpoint did not answer: ${err.message}` };
  }

  // A job that is still queued or running is not a failed job. `/runsync`
  // stops waiting after about ninety seconds and hands back the id; on a cold
  // morning the worker is asleep and this is the normal path, not the
  // exception. Poll until it finishes or the budget runs out.
  while (body.status && !DONE.has(body.status) && !LOST.has(body.status)) {
    if (!body.id) {
      return { error: `RunPod job ${body.status} with no id to follow` };
    }
    if (Date.now() > deadline) {
      return { error: `RunPod job ${body.status} after ${Math.round(TIMEOUT_MS / 1000)}s ` +
                      `— it may still finish; job ${body.id}` };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const r = await fetch(STATUS(config.runpodEndpointId, body.id), {
        headers: auth,
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await r.text();
      if (!r.ok) return { error: `RunPod status answered ${r.status}: ${raw.slice(0, 200)}` };
      body = JSON.parse(raw);
    } catch (err) {
      return { error: `Lost track of RunPod job ${body.id}: ${err.message}` };
    }
  }

  if (body.status && LOST.has(body.status)) {
    return { error: `RunPod job ${body.status}: ${body.error || 'no reason given'}` };
  }
  const out = body.output;
  if (!out) return { error: 'RunPod returned no output' };
  if (out.error) return { error: out.error };
  if (!out.audio_b64) return { error: 'RunPod returned no audio' };

  const audio = Buffer.from(out.audio_b64, 'base64');
  if (!audio.length) return { error: 'RunPod returned empty audio' };

  return {
    audio,
    format: out.format || format,
    seconds: out.seconds,
    sampleRate: out.sample_rate,
    timing: out.timing,
    settings: out.settings,
  };
}

/**
 * Is the endpoint alive? Asked by /api/check, so it has to be cheap and it
 * has to be honest: a cold start is not a fault, but no answer at all is.
 *
 * Deliberately does not generate anything — waking a worker to prove it can
 * wake costs more than the check is worth.
 */
export async function health() {
  if (!configured()) return { configured: false };
  try {
    const r = await fetch(
      `https://api.runpod.ai/v2/${config.runpodEndpointId}/health`,
      {
        headers: { Authorization: `Bearer ${config.runpodApiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!r.ok) return { configured: true, ok: false, error: `health returned ${r.status}` };
    const j = await r.json();
    return {
      configured: true,
      ok: true,
      // Zero ready workers is the resting state, not a problem.
      workers: j.workers,
      jobs: j.jobs,
    };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}
