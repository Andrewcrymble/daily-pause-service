# The Daily Pause — posting service

Takes a day of three posts, schedules the Facebook ones, holds the Instagram ones and
publishes each at its slot. No dependencies, no build step, no database — Node 20+ and a
folder.

## Why it exists

Facebook and Instagram do not work the same way, and that asymmetry is the whole design:

| | Facebook | Instagram |
|---|---|---|
| Scheduling | native, up to 6 months out | **none** — the API publishes on the call |
| So this service | hands it to Meta and forgets it | holds it and fires at the slot |
| Image | uploaded as bytes | fetched by Instagram from a **public URL** |
| Cancel before it goes | yes, in Business Suite | only before it fires |

That last row matters. A Facebook post sits in Business Suite where Andrew can read, edit or
delete it — that is the brief's "cancel to stop". An Instagram post is live the instant it
fires. `IG_DELAY_MINUTES` exists for that: set it and Instagram trails Facebook, so the
Facebook queue proof-reads for both.

## Running it

```bash
cp .env.example .env      # fill it in
npm start                 # or: node --env-file=.env src/index.js
npm test                  # end-to-end dry run, no Graph calls
```

Deploy anywhere that gives a long-running process, a public https URL and a persistent disk
for `DATA_DIR` — Railway, Fly, a VPS. **Not a serverless platform**: the scheduler has to
keep running between slots, and the cards have to stay on disk.

## The token

Get a Page token that never expires, per the handover's steps 1–8, with these scopes:

```
pages_show_list  pages_read_engagement  pages_read_user_content
pages_manage_posts  instagram_basic  instagram_content_publish
```

The last two are new — without them Facebook works and Instagram fails.

`GET /api/status` checks the token every time it is called and tells you if it is not a Page
token, is not permanent, is missing scopes, belongs to another page, or has no Instagram
account connected. Check it after any token change.

Meta's **data-access permission lapses 90 days** after it is granted, separately from the
token's own expiry. `/api/status` reports that date too. Diary it.

## Endpoints

Everything except the cards needs `Authorization: Bearer $SERVICE_TOKEN`.

| | |
|---|---|
| `POST /api/days` | accept a day, schedule Facebook, queue Instagram |
| `GET /api/days` | dates held |
| `GET /api/days/:date` | the full record for a day |
| `POST /api/days/:date/:slot/cancel` | stop the Instagram post; tells you the Facebook post id to delete in Business Suite |
| `POST /api/days/:date/:slot/publish-now` | fire the Instagram post immediately |
| `GET /api/status` | token, Instagram link, config problems, recent activity |
| `GET /cards/:file` | **public** — this is what Instagram fetches |
| `GET /healthz` | liveness |

### Posting a day

```jsonc
POST /api/days
{
  "date": "2026-09-14",
  "posts": [
    { "slot": "0800",
      "topic": "kindness",
      "caption": "Someone did something for you once…",
      "imageBase64": "data:image/jpeg;base64,…",   // JPEG — Instagram is fussy
      "hold": false                                 // true = write it, send nothing
    }
    // 1300, 2100
  ]
}
```

Slots are `0800`, `1300`, `2100`, and they are wall-clock times in `TIMEZONE`. Eight in the
morning in Belfast in July and in January — the instant is recomputed from the zone each
time, so the clocks changing does not move the posts.

Re-posting the same date replaces the record and the cards. Posts already published are left
alone.

`"instagram": false` on a post keeps it Facebook-only.

## What it refuses to do

- **Publish a stale post.** Anything more than 90 minutes past its slot is marked `missed`.
  Sending the quiet hour over breakfast because the service was down all night is worse than
  missing it. A missed slot costs nothing.
- **Publish twice.** The record is claimed before the Graph call, so a tick that overruns a
  container poll cannot double-send.
- **Believe Meta.** Every Facebook post is read back from `scheduled_posts` before it is
  called scheduled. A `photoId` with no `postId` is treated as a failure, because a photo
  without a post is invisible in Business Suite.
- **Delete anything on Meta's side.** Cancelling stops the Instagram post and hands you the
  Facebook post id to delete yourself.

## The record

One JSON file per day in `DATA_DIR/days/`, written atomically, openable in a text editor —
which is worth a lot at six in the morning when something has gone wrong. Cards sit beside
it in `DATA_DIR/cards/`.

## Where the posts come from

This service does not write anything. The morning session writes the three posts, verifies
any scripture against a real source that same session, renders the cards, and POSTs the day
here. Anything it was unsure of arrives with `hold: true` — stored, visible, and sent
nowhere.
