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

const ENDPOINT = (id) => `https://api.runpod.ai/v2/${id}/runsync`;

// Cold start plus generation, with room to spare. RunPod queues rather than
// refusing when every worker is busy, so the wait can legitimately be long.
const TIMEOUT_MS = 180_000;

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

  let body;
  try {
    const r = await fetch(ENDPOINT(config.runpodEndpointId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.runpodApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: { text: line, format, ...overrides } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await r.text();
    if (!r.ok) return { error: `RunPod answered ${r.status}: ${raw.slice(0, 300)}` };
    body = JSON.parse(raw);
  } catch (err) {
    return { error: `The voice endpoint did not answer: ${err.message}` };
  }

  // RunPod wraps the handler's return value, and reports its own failures at
  // the top level. Both shapes have to be unpicked before anything is trusted.
  if (body.status && body.status !== 'COMPLETED') {
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
