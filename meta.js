/**
 * Everything that talks to Meta.
 *
 * Two hard-won rules live here:
 *   1. A photo uploaded to /{page-id}/photos with published=false is a PHOTO,
 *      not a post. It returns an id, looks fine, and appears nowhere in
 *      Business Suite. The post has to be created on /feed with attached_media.
 *   2. A success response is not evidence. Every write is read back.
 */
import { config } from './config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GraphError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

async function graph(path, { method = 'GET', body, token, query } = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token ?? config.pageToken);

  const r = await fetch(url, { method, body });
  const text = await r.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GraphError(`Graph returned non-JSON (${r.status})`, text.slice(0, 400));
  }
  if (json.error) {
    const e = json.error;
    // The Graph API rejects a whole request when any single field is unknown,
    // rather than ignoring the bad one, so the message is usually the fastest
    // route to the real cause.
    throw new GraphError(
      `Graph ${e.type ?? 'error'} ${e.code ?? ''}: ${e.message}`.trim(),
      e.error_user_msg ?? null
    );
  }
  return json;
}

/* ------------------------------------------------------------------ token -- */

export async function inspectToken(token = config.pageToken) {
  if (!token) return { ok: false, reason: 'no token set' };
  const { data = {} } = await graph('debug_token', {
    token, query: { input_token: token },
  });
  return {
    ok: data.type === 'PAGE' && data.is_valid !== false,
    type: data.type ?? null,
    profileId: data.profile_id ?? null,
    // 0 means it never expires. Anything else means step 6 of the token dance
    // was skipped and this will die quietly, usually within the hour.
    expiresAt: data.expires_at ?? null,
    neverExpires: data.expires_at === 0,
    dataAccessExpiresAt: data.data_access_expires_at ?? null,
    scopes: data.scopes ?? [],
  };
}

const NEEDED_SCOPES = [
  'pages_show_list', 'pages_read_engagement',
  'pages_manage_posts', 'instagram_basic', 'instagram_content_publish',
];

export function missingScopes(scopes = []) {
  return NEEDED_SCOPES.filter((s) => !scopes.includes(s));
}

/** The Instagram account connected to the Page, if any. */
export async function linkedInstagram(pageId = config.pageId) {
  const r = await graph(pageId, { query: { fields: 'instagram_business_account' } });
  return r.instagram_business_account?.id ?? null;
}

/* --------------------------------------------------------------- facebook -- */

/**
 * Schedule a photo post on the Page. `when` is a Date.
 * Returns { postId, photoId, verified }.
 */
export async function scheduleFacebookPost({ imageBuffer, caption, when, pageId = config.pageId }) {
  const seconds = Math.floor(when.getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (seconds < now + 600) {
    throw new GraphError('Facebook needs at least 10 minutes notice', { seconds, now });
  }

  const form = new FormData();
  form.set('published', 'false');
  form.set('source', new Blob([imageBuffer], { type: 'image/jpeg' }), 'card.jpg');
  const photo = await graph(`${pageId}/photos`, { method: 'POST', body: form });
  if (!photo.id) throw new GraphError('Photo upload returned no id');

  const post = await graph(`${pageId}/feed`, {
    method: 'POST',
    body: new URLSearchParams({
      message: caption,
      published: 'false',
      scheduled_publish_time: String(seconds),
      'attached_media[0]': JSON.stringify({ media_fbid: photo.id }),
    }),
  });
  if (!post.id) {
    throw new GraphError('Feed call returned no post id — that would be an invisible photo',
      { photoId: photo.id });
  }

  let verified = false;
  try {
    const list = await graph(`${pageId}/scheduled_posts`, {
      query: { fields: 'id', limit: '100' },
    });
    verified = (list.data ?? []).some((p) => p.id === post.id);
  } catch { /* verification is best effort */ }

  return { postId: post.id, photoId: photo.id, verified };
}

export async function cancelFacebookPost(postId) {
  await graph(postId, { method: 'DELETE' });
  return true;
}

/* -------------------------------------------------------------- instagram -- */

const CONTAINER_POLL_MS = 3000;
const CONTAINER_MAX_WAIT_MS = 120_000;

/**
 * Publish one image to Instagram, now. There is no scheduling in this API —
 * the container is created and published, and it is live.
 * `imageUrl` must be a public https URL; Instagram fetches it itself.
 */
export async function publishInstagram({ imageUrl, caption, igUserId = config.igUserId }) {
  if (!igUserId) throw new GraphError('No Instagram user id configured');

  // Instagram's error when it cannot fetch the file is uselessly vague, so
  // establish reachability here where the message is readable.
  const head = await fetch(imageUrl, { method: 'HEAD' });
  if (!head.ok) {
    throw new GraphError(`Card is not publicly reachable (${head.status})`, imageUrl);
  }

  const container = await graph(`${igUserId}/media`, {
    method: 'POST',
    body: new URLSearchParams({ image_url: imageUrl, caption }),
  });
  if (!container.id) throw new GraphError('Container creation returned no id');

  // Publishing a container that is still IN_PROGRESS fails, so wait for it.
  const deadline = Date.now() + CONTAINER_MAX_WAIT_MS;
  let status = 'IN_PROGRESS';
  while (Date.now() < deadline) {
    const s = await graph(container.id, { query: { fields: 'status_code,status' } });
    status = s.status_code;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new GraphError(`Container ${status}`, s.status ?? null);
    }
    await sleep(CONTAINER_POLL_MS);
  }
  if (status !== 'FINISHED') {
    throw new GraphError('Container never finished processing', { containerId: container.id });
  }

  const published = await graph(`${igUserId}/media_publish`, {
    method: 'POST', body: new URLSearchParams({ creation_id: container.id }),
  });
  if (!published.id) throw new GraphError('media_publish returned no id');

  let permalink = null;
  try {
    const media = await graph(published.id, { query: { fields: 'permalink' } });
    permalink = media.permalink ?? null;
  } catch { /* best effort */ }

  return { mediaId: published.id, permalink };
}

export async function instagramQuota(igUserId = config.igUserId) {
  const r = await graph(`${igUserId}/content_publishing_limit`, {
    query: { fields: 'config,quota_usage' },
  });
  const row = r.data?.[0];
  if (!row) return null;
  const total = row.config?.quota_total ?? 100;
  return { used: row.quota_usage ?? 0, total, remaining: total - (row.quota_usage ?? 0) };
}
