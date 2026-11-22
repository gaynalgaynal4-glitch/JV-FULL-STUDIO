# JV Full Studio — Voholabs edition

JV Telegram verification and the existing video-processing methods are retained. TikTok channel connection, listing, disconnection, media upload and publishing use the Voholabs Studio public API. No Lime Social API is used by the active dashboard workflow.

## Render environment variables

Required for the existing JV login/session system:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `APP_URL` — this Render service's public HTTPS URL
- `SESSION_SECRET` — random secret, at least 32 characters
- `JV_VERIFY_API_BASE` — existing JV verification server (defaults to the existing endpoint)

Voholabs:
- `VOHOLABS_API_KEY` — key from Voholabs Studio → Settings → Connect Agent → API Key
- `VOHOLABS_OWNER_TG_UID` — numeric Telegram UID of the JV user who owns this Voholabs workspace; only this UID can connect, view, disconnect or publish to its channels
- `VOHOLABS_API_URL` — `https://studio.voholabs.com/api/public/v1`

Optional existing processing settings:
- `KURONAI_API_BASE`
- `KURONAI_TG_ID`
- `MAX_VIDEO_SIZE_MB`

Keep API keys and Redis credentials in Render environment variables. Do not put them in `public/` files or commit a `.env` file. Rotate any credentials that were ever included in an uploaded archive.

## Voholabs workspace model

This integration uses the one Voholabs workspace belonging to `VOHOLABS_API_KEY`. All verified JV users will see channels connected to that workspace. It does not create a separate Voholabs workspace per Telegram UID. If each JV user must authorize and publish from their own independent Voholabs account, use a Voholabs OAuth app and per-user OAuth tokens (`pos_` tokens); a personal Connect Agent API key is not a substitute for that multi-tenant OAuth flow.

## TikTok behavior

Connect TikTok opens Voholabs' hosted authorization flow. After approving the channel, return to JV Studio and refresh the dashboard. The dashboard lists TikTok channels returned by `GET /integrations`. Disconnect removes the selected channel from the Voholabs workspace. Publishing uploads an MP4 to Voholabs and then creates a post for the selected channel.

- `Publish now`: Voholabs `POST /posts` with TikTok `DIRECT_POST` settings.
- `Schedule`: Voholabs `POST /posts` with `type: schedule` and TikTok `DIRECT_POST` settings.
- `Upload for manual posting`: Voholabs `UPLOAD` method, which sends the video to the TikTok inbox to finish in the TikTok app; it is not a saved draft in the JV app.

TikTok privacy choices depend on what TikTok permits for the connected account. Voholabs' TikTok documentation says video captions can be up to 2,000 characters and supports MP4 videos.

## Checks

Run `npm run check` for server, frontend and inline-script syntax checks. These are static checks; a live connection, upload and publish must still be tested against the configured Voholabs workspace and connected TikTok channel.
