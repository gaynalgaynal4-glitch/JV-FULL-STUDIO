# JV Studio PostZen — Existing JV Bot + Upstash

This version intentionally reuses the authentication flow from the user's existing `jv_video_lab_local_core.zip` HTML project. It does NOT use Telegram Login Widget, Gmail, Firebase Auth, Supabase Auth, or a newly created bot.

## Existing bot authentication preserved

The original HTML uses:
- Verification service: `https://google-colabe-bot.onrender.com`
- Endpoint: `GET /verify/{telegram_uid}/{browser_token}`
- Browser UID storage key: `jv_video_lab_telegram_uid_v1`
- Browser token storage key: `jv_video_lab_browser_token_v1`
- A 24-byte cryptographically random browser token encoded as 48 lowercase hex characters.
- The verification server's `allowed === true` result as the authority.
- Existing error reasons such as `not_member`, `blocked`, and `session_taken`.

This project keeps those exact storage keys and token format. The Node server calls the same verification endpoint itself before allowing API access; the browser cannot simply claim an arbitrary UID and gain access. A short-lived signed backend session is issued after successful verification, but the JV verification server is checked again on protected API calls.

## Render environment variables

Set these in Render → Web Service → Environment:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN` — rotate the previously exposed token first.
- `POSTZEN_API_KEY` — PostZen Read & Write key.
- `APP_URL` — exact Render HTTPS URL, e.g. `https://your-service.onrender.com`
- `SESSION_SECRET` — long random value, at least 32 characters.
- `JV_VERIFY_API_BASE=https://google-colabe-bot.onrender.com`
- `MAX_VIDEO_SIZE_MB=500`
- `NODE_ENV=production`

Never put these secrets in the `public/` directory or GitHub.

## Deploy

- Build command: `npm install`
- Start command: `npm start`
- Node.js 20+
- One Render Web Service serves both website and backend.

## Functionality

- UID verification against the existing JV bot service
- One PostZen profile per verified Telegram UID
- TikTok OAuth connect, state tied to the initiating UID
- Connected account listing scoped to that PostZen profile
- Video presign + streamed PUT upload to PostZen media storage
- Draft, publish now, and schedule
- Upstash user records and per-user post history

## Limitations / testing

- The app has been syntax-checked only. It has not been live-tested with the user's Upstash instance, existing JV verification service, or PostZen API key.
- Existing verification server availability and its current endpoint contract are required.
- PostZen Free currently allows 2 connected social accounts total per API account; verify your plan.
- The video upload limit defaults to 500 MB; the actual Render service and request limits may be lower.
- History stores the PostZen submission result, not a guaranteed final TikTok delivery state. Webhooks/status polling would be needed for final status synchronization.
- This version supports one TikTok video per post, not photo posts or other platforms.
