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
  // establish reachability here where the message is readable. GET, not HEAD:
  // the /cards/ route answers GET only, and GET is what Instagram does.
  const head = await fetch(imageUrl, { method: 'GET' });
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

/* ---------------------------------------------------------------- stats -- */

/**
 * Two tiers of figures live below.
 *
 * Tier one — likes, comments, shares, follower counts — needs only the scopes
 * the posting side already has. Tier two — reach, impressions, saves, and the
 * daily trend — needs `read_insights` on the Page and `instagram_manage_insights`
 * on the account. The token may well not carry those, so every tier-two call is
 * allowed to fail on its own without taking the rest of the response with it.
 */
export const INSIGHT_SCOPES = ['read_insights', 'instagram_manage_insights'];

export function missingInsightScopes(scopes = []) {
  return INSIGHT_SCOPES.filter((s) => !scopes.includes(s));
}

/** Runs a call and returns null rather than throwing. For tier two only. */
async function soft(fn) {
  try { return await fn(); } catch (e) { return { __error: e.message }; }
}

const isErr = (v) => !v || typeof v !== 'object' || '__error' in v;

export async function audience({ pageId = config.pageId, igUserId = config.igUserId } = {}) {
  const out = { facebook: null, instagram: null };

  const page = await soft(() => graph(pageId, { query: { fields: 'followers_count,fan_count,name' } }));
  if (!isErr(page)) {
    out.facebook = {
      name: page.name ?? null,
      followers: page.followers_count ?? page.fan_count ?? null,
    };
  } else out.facebook = { error: page?.__error ?? 'unavailable' };

  if (igUserId) {
    const ig = await soft(() => graph(igUserId, {
      query: { fields: 'followers_count,media_count,username' },
    }));
    if (!isErr(ig)) {
      out.instagram = {
        username: ig.username ?? null,
        followers: ig.followers_count ?? null,
        posts: ig.media_count ?? null,
      };
    } else out.instagram = { error: ig?.__error ?? 'unavailable' };
  }

  return out;
}

/**
 * Engagement for a batch of Facebook posts, keyed by post id.
 * `ids` batching keeps this to one round trip however many posts there are.
 */
export async function facebookPostStats(postIds = []) {
  const ids = postIds.filter(Boolean);
  if (!ids.length) return {};

  const basic = await soft(() => graph('', {
    query: {
      ids: ids.join(','),
      fields: 'permalink_url,created_time,shares,' +
              'reactions.summary(total_count).limit(0),' +
              'comments.summary(total_count).limit(0)',
    },
  }));

  const out = {};
  for (const id of ids) {
    const row = !isErr(basic) ? basic[id] : null;
    out[id] = {
      permalink: row?.permalink_url ?? null,
      postedAt: row?.created_time ?? null,
      likes: row?.reactions?.summary?.total_count ?? null,
      comments: row?.comments?.summary?.total_count ?? null,
      shares: row?.shares?.count ?? 0,
      reach: null,
      clicks: null,
    };
  }

  // Tier two. One call per post — Graph will not batch insights through `ids`.
  await Promise.all(ids.map(async (id) => {
    const ins = await soft(() => graph(`${id}/insights`, {
      query: { metric: 'post_impressions_unique,post_clicks' },
    }));
    if (isErr(ins)) return;
    for (const m of ins.data ?? []) {
      const v = m.values?.[0]?.value ?? null;
      if (m.name === 'post_impressions_unique') out[id].reach = v;
      if (m.name === 'post_clicks') out[id].clicks = v;
    }
  }));

  return out;
}

/** Engagement for a batch of Instagram media, keyed by media id. */
export async function instagramMediaStats(mediaIds = []) {
  const ids = mediaIds.filter(Boolean);
  if (!ids.length) return {};

  const basic = await soft(() => graph('', {
    query: { ids: ids.join(','), fields: 'permalink,timestamp,like_count,comments_count' },
  }));

  const out = {};
  for (const id of ids) {
    const row = !isErr(basic) ? basic[id] : null;
    out[id] = {
      permalink: row?.permalink ?? null,
      postedAt: row?.timestamp ?? null,
      likes: row?.like_count ?? null,
      comments: row?.comments_count ?? null,
      reach: null,
      saves: null,
    };
  }

  await Promise.all(ids.map(async (id) => {
    const ins = await soft(() => graph(`${id}/insights`, {
      query: { metric: 'reach,saved' },
    }));
    if (isErr(ins)) return;
    for (const m of ins.data ?? []) {
      const v = m.values?.[0]?.value ?? null;
      if (m.name === 'reach') out[id].reach = v;
      if (m.name === 'saved') out[id].saves = v;
    }
  }));

  return out;
}

/**
 * Daily reach for the last `days` days on both platforms.
 * Tier two throughout — returns nulls, not an error, when the scope is absent.
 */
export async function dailyReach({ days = 30, pageId = config.pageId,
                                   igUserId = config.igUserId } = {}) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86_400;
  const series = { facebook: null, instagram: null, error: null };

  const fb = await soft(() => graph(`${pageId}/insights`, {
    query: { metric: 'page_impressions_unique', period: 'day', since, until },
  }));
  if (!isErr(fb)) {
    const row = (fb.data ?? [])[0];
    series.facebook = (row?.values ?? []).map((v) => ({
      date: String(v.end_time).slice(0, 10), value: v.value ?? 0,
    }));
  } else series.error = fb?.__error ?? null;

  if (igUserId) {
    const ig = await soft(() => graph(`${igUserId}/insights`, {
      query: { metric: 'reach', period: 'day', since, until },
    }));
    if (!isErr(ig)) {
      const row = (ig.data ?? [])[0];
      series.instagram = (row?.values ?? []).map((v) => ({
        date: String(v.end_time).slice(0, 10), value: v.value ?? 0,
      }));
    } else if (!series.error) series.error = ig?.__error ?? null;
  }

  return series;
}

/* ------------------------------------------------------- editing a post -- */

/**
 * Change the message on a post that is scheduled but not yet published.
 * Meta allows the text to be edited in place; the image cannot be swapped,
 * which is why a card change means delete-and-recreate.
 */
export async function updatePostMessage(postId, message) {
  const r = await graph(postId, {
    method: 'POST', body: new URLSearchParams({ message }),
  });
  if (r.success === false) throw new GraphError('Edit was refused', r);
  return true;
}

/* ------------------------------------------------- did it actually go out -- */

/**
 * Read a post back from Meta and say whether it is really on the Page.
 *
 * Scheduling a post is not the same as publishing one. Meta publishes an
 * API-scheduled post using the credentials that created it, and if those stop
 * working in between — a regenerated Page token, a revoked app — the post fails
 * at its slot with no signal of any kind to the thing that scheduled it. It
 * simply never appears. This is the only way to find out.
 *
 * Returns { published, scheduled, missing, permalink, at, error }.
 */
export async function postState(postId) {
  try {
    const r = await graph(postId, {
      query: { fields: 'is_published,created_time,scheduled_publish_time,permalink_url' },
    });
    const scheduled = Boolean(r.scheduled_publish_time);
    return {
      published: r.is_published === true && !scheduled,
      scheduled,
      missing: false,
      permalink: r.permalink_url ?? null,
      at: r.created_time ?? null,
      error: null,
    };
  } catch (err) {
    // Meta answers "does not exist" for a post that has been deleted, and for
    // one whose object has broken. Both mean it is not going out.
    const missing = /does not exist|cannot be loaded|Unsupported get request/i
      .test(err.message);
    return { published: false, scheduled: false, missing,
             permalink: null, at: null, error: err.message };
  }
}

/** Publish a photo to the Page right now, rather than scheduling it. */
export async function publishFacebookNow({ imageBuffer, caption, pageId = config.pageId }) {
  const form = new FormData();
  form.set('caption', caption);
  form.set('source', new Blob([imageBuffer], { type: 'image/jpeg' }), 'card.jpg');
  const r = await graph(`${pageId}/photos`, { method: 'POST', body: form });
  if (!r.post_id && !r.id) throw new GraphError('Photo post returned no id', r);

  const postId = r.post_id ?? null;
  let permalink = null;
  if (postId) {
    try {
      const p = await graph(postId, { query: { fields: 'permalink_url' } });
      permalink = p.permalink_url ?? null;
    } catch { /* best effort */ }
  }
  return { postId, photoId: r.id ?? null, permalink };
}
