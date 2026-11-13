# JV-FULL-STUDIO — Lime Social edition

This is an update of the supplied JV-FULL-STUDIO application. It retains the existing Express/Node.js architecture, public frontend, Telegram UID verification authority, browser-bound sessions, Upstash Redis, video preview, Video Lab iframe, Kuronai proxy, native FFmpeg tools, and per-user publishing history.

## Lime Social integration

The backend uses Lime Social's documented API at `https://api.limesocial.io`:

- `GET /v1/me` to verify an API key and list accounts in that key's Lime Social workspace.
- `POST /v1/account/connect` to create a time-limited TikTok connection link (the docs specify Bearer authentication for this endpoint; the other documented API examples use the raw API key in `Authorization`). Lime Social hosts the social authorization flow and redirects to the configured return URL; this is not implemented as a fabricated OAuth code exchange.
- `DELETE /v1/account/remove` to disconnect a TikTok account from the exact workspace/key that owns it.
- `POST /v1/post` to submit a video job.
- `GET /v1/status/{request_id}` to retrieve asynchronous publishing status.

Official documentation: https://doc.limesocial.io/docs/api-reference/me/ , https://doc.limesocial.io/docs/api-reference/account/connect/ , https://doc.limesocial.io/docs/api-reference/account/remove/ , https://doc.limesocial.io/docs/api-reference/post/ , https://doc.limesocial.io/docs/api-reference/status/ .

### Multiple API keys / separate Lime Social workspaces

Set `LIME_API_KEY_1`, `LIME_API_KEY_2`, and so on. The server discovers every non-empty variable matching `LIME_API_KEY_<number>`; there is no hard-coded key count. Keys can belong to different Lime Social accounts/workspaces. Each connected TikTok account is permanently associated with the key/workspace that created its connection link, and publishing/removal uses that same key. Keys are not treated as interchangeable credentials for one workspace. Only use API keys for Lime Social workspaces you own or are explicitly authorized to administer, and only combine workspaces where Lime Social permits this use; adding keys must never be used to evade a plan, account, or rate limit.

The server checks each configured key through `/v1/me`, skips keys in a temporary error/rate-limit cooldown, and prefers the usable workspace with fewer connected TikTok accounts. HTTP 401 keys are cooled down for 24 hours; HTTP 429 keys for one minute and network/5xx failures for 30 seconds. Health state is keyed by a one-way fingerprint, so changing a Render key value creates a fresh health identity. These cooldowns are operational safeguards, not quota circumvention. The provider's own limits remain authoritative.

`LIME_TOTAL_ACCOUNT_CAPACITY` is the administrator-configured aggregate allowance across the workspaces. Lime Social's `/v1/me` response documents plan name and connected accounts but does not return a numeric maximum-account entitlement. Therefore the backend does not infer capacity from the number of keys. The example defaults to `0` (connections disabled) until you set it to the total account allowance actually permitted by the subscriptions and provider terms. Lime Social also enforces each workspace's own plan limit during its hosted connection flow.

### Global connection pool

All JV website users share one Redis-backed connection pool. Redis Lua scripts atomically reserve a slot and enforce one active/reserved TikTok connection per Telegram UID. A reservation expires after ten minutes; a failed callback releases it. A successful callback is confirmed against the `/v1/me` account list before being counted as active. A successful provider removal is required before the active slot is released. Dashboard totals are read from Redis, not browser counters. Available slots subtract both active connections and in-progress reservations so concurrent users cannot overbook the pool.

### Publishing and Only Upload

The `Only Upload` method is the default. It does not call the Video Lab iframe, FFmpeg, WebCodecs, Kuronai, resizing, frame-rate changes, bitrate changes, watermarking, or backend re-encoding. The selected file is uploaded to the JV server's temporary disk and then passed as a file part (`mediaFile`) to Lime Social with its original filename and MIME type. The temporary file is deleted after the request.

Important provider limitation: Lime Social documents direct video file uploads up to 100 MB and processes publishing asynchronously. The provider may perform its own processing/transcoding after receiving the original file. This application does not claim that the final TikTok media bytes remain identical after Lime Social's pipeline. The provider API documentation does not publish a multipart example for nested TikTok `accounts` settings; the implementation uses standard multipart nested field names (`accounts[0][...]`). A live credential test is required to confirm this serialization against the current API deployment.

The Lime Social TikTok options implemented are privacy level, disable comments, disable duet, disable stitch, and post mode. Immediate publishing and scheduling are supported by the documented endpoint. Lime Social documents `MEDIA_UPLOAD` as an upload-for-manual-posting mode; it is deliberately labelled that way in the UI and is not misrepresented as a TikTok saved draft. The API does not document a separate saved-draft operation for TikTok.

### Publishing status

Publishing is asynchronous. The initial `/api/posts` response means Lime Social accepted a job, not that TikTok delivery is complete. Publishing history stores the request ID and key slot. Use **Check status** in history to query Lime Social's status endpoint. The status route verifies that the request ID exists in the current Telegram UID's own history before contacting the provider.

## Environment variables

Configure these in Render. Do not commit real credentials.

- `LIME_API_KEY_1` ... `LIME_API_KEY_15` — optional individually; set each configured Lime Social API key in its matching variable. Additional numbered keys are detected automatically.
- `LIME_TOTAL_ACCOUNT_CAPACITY` — aggregate account allowance across all configured Lime Social workspaces, confirmed against the subscriptions/terms (example: `25`).
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — persistent Redis.
- `APP_URL` — public HTTPS Render origin, no trailing slash.
- `SESSION_SECRET` — random secret of at least 32 characters.
- `JV_VERIFY_API_BASE` — existing JV Telegram UID verification service base URL.
- `KURONAI_API_BASE` and `KURONAI_TG_ID` — retain only if the existing Kuronai processing methods are used.
- `MAX_VIDEO_SIZE_MB` — existing server upload ceiling; Lime Social direct file publishing is separately limited to 100 MB by its published API docs.
- `PORT` and `NODE_ENV` — standard Render/Node settings.

`.env.example` contains placeholders only. The ZIP intentionally excludes `.env`.

## Render deployment

1. Rotate any credentials that were present in the previously uploaded archive before deploying. Configure fresh Redis credentials, a fresh session secret, and fresh Lime Social API keys in Render.
2. Upload/deploy the updated project to the existing Render service (or create a new service if you want a rollback-safe staging deployment).
3. Set Build Command to `npm install` and Start Command to `npm start`.
4. Use Node.js 20 or later. The existing `apt.txt` retains FFmpeg for the unrelated legacy FFmpeg tool.
5. Set `APP_URL` to the exact deployed HTTPS origin. Set the existing `JV_VERIFY_API_BASE` to the current JV verification service.
6. Configure Upstash Redis and at least one valid Lime Social API key. Set `LIME_TOTAL_ACCOUNT_CAPACITY` only after confirming the combined permitted account allowance.
7. Deploy, verify `/api/health`, sign in using the existing Telegram UID process, then test one TikTok connection and one low-risk test post.

## Redis migration and legacy PostZen data

No destructive migration is performed. Existing Telegram user records remain under the existing `jvpostzen:user:<uid>` keys, and existing history remains under `jvpostzen:user:<uid>:history`. Old `postzenProfileId` values, if present, are retained as inert historical fields and are never sent to Lime Social. Old PostZen tokens are never treated as Lime Social keys. New Lime Social connection ownership is stored separately under `jv:limesocial:*` keys.

Do not delete the old Redis namespace during deployment. After verifying the new integration and exporting any history you need, obsolete PostZen fields/keys can be cleaned manually in a separate maintenance operation. No automatic cleanup is required for the new service to run.

## Security notes

- Telegram UID verification remains the access-control authority.
- Browser sessions remain signed server-side; API keys and provider credentials are never returned to frontend routes.
- OAuth-like authorization state is a cryptographically random 256-bit state value stored in Redis with a ten-minute TTL. The callback is accepted only when the state matches a pending reservation.
- Account ownership is checked against Redis ownership and the key-specific `/v1/me` response before publish or disconnect.
- Connect, disconnect, and publish endpoints have Redis-backed per-user rate limits.
- Provider key health/cooldown records contain key slot numbers and status metadata, never key values. Each stored connection also carries a one-way SHA-256 key fingerprint so moving or replacing a Render variable cannot silently point an old account at a different Lime Social workspace.

## Validation and limitations

Run `npm run check` for JavaScript and inline-script syntax checks, and `npm test` for 17 static migration/security invariants. These static checks do not replace live Redis concurrency tests or live Lime Social API tests. The included project test suite does not make live calls to Lime Social, Upstash, the JV verification service, or TikTok. Live publishing, actual plan entitlements, provider-side video handling, and the multipart nested-field serialization must be verified with valid credentials. The API documentation currently does not expose a numeric connected-account entitlement in `/v1/me`; the administrator must configure the aggregate limit accurately.
