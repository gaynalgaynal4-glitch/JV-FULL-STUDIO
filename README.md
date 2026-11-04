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


## Video methods and TikTok publishing

The website uses the supplied JV Video Lab processing page as its processing engine and adds PostZen publishing.

### Required environment variables

Set all existing variables from `.env.example`, plus:

- `KURONAI_API_BASE=https://api.kuronaiapp.com`
- `KURONAI_TG_ID=<your Kuronai server access ID>`

Keep `KURONAI_TG_ID` only in Render Environment Variables or the server-side `.env`. Do not put it in frontend JavaScript or commit `.env`.

Kuronai processing is proxied through the Node backend. The current proxy enforces a 60 MB input limit because the supplied server encoder's enhanced path uses that limit. Local processing stays in the browser. The FFmpeg method uploads the video to this Node server for native FFmpeg processing; it does not send the source to Kuronai.

### Methods

- Enhanced: sends the video to your configured Kuronai `/uploaden/` endpoint, streams server progress, downloads the processed result through the backend, then submits it to PostZen.
- Local: uses the supplied browser MP4 patcher and local H.264 enhancer, then submits the result to PostZen.
- FFmpeg: uses the server-installed native FFmpeg executable to remux the MP4 with stream copy (`-c copy`), then submits the result to PostZen. No FFmpeg WebAssembly, browser worker, or browser-side FFmpeg core is downloaded. Render’s Node native runtime already includes the `ffmpeg` executable at build time and runtime; on another host, install FFmpeg and ensure it is on `PATH` (or set `FFMPEG_PATH`). The stream-copy method accepts MP4, MOV, and M4V containers; incompatible codecs can still be rejected by the MP4 muxer.

### Copyright checks

The two rights checkboxes are user confirmations only. They do not perform audio fingerprinting, video matching, or a legal copyright clearance scan. Do not treat them as a guarantee that TikTok will accept the video.

### Caption metadata

The backend appends `#jvpersonaltest • Upload Method - @jv_60fps` to the caption. `#jvpersonaltest` is a hashtag string. `@jv_60fps` is plain caption text unless PostZen's TikTok integration exposes and supports structured mention metadata. The uploaded `inject.js` patches TikTok's private web-composer request format and does not establish that PostZen accepts that metadata.

### Deploy

1. Install dependencies with `npm install`.
2. Set all `.env.example` values in Render Environment Variables.
3. Set `APP_URL` to the deployed HTTPS origin.
4. Deploy with `npm start`.
5. Verify through the existing JV bot, connect TikTok, choose a processing method, select a video, complete the rights checklist, and submit.

The app must be served over HTTPS. Do not open `public/index.html` as a local file.


## Video processing methods

The publishing page includes three selectable methods in the ⚙ Methods settings:

- **Enhanced**: sends the video through the Node.js server proxy to your Kuronai `/uploaden/` endpoint. The Kuronai Telegram access ID stays in the server environment and is never sent to browser JavaScript. Kuronai's current upload limit is 60 MB.
- **Local**: applies the bundled browser MP4 patcher locally; the source video is not sent to Kuronai for processing.
- **FFmpeg**: uploads the selected video to the Node server, where native FFmpeg performs a stream-copy remux (`-c copy`) before the processed file is submitted to PostZen. FPS Studio also uses the same native server executable for timestamp scaling. The FFmpeg route accepts MP4, MOV, and M4V files and does not re-encode streams.

The page previews the selected video before processing. Publishing requires the user to confirm they have rights to the audio and visual content. These are confirmations, **not an automated copyright-detection service**.

The server appends `#jvpersonaltest • Upload Method - @jv_60fps` to the caption when creating the PostZen post. This is plain caption text; it does not guarantee a clickable TikTok mention.

### Required Render environment variables

Set `KURONAI_TG_ID` to your Kuronai access ID in Render → Environment. Do not put it in `public/`, frontend JavaScript, or Git. Keep `KURONAI_API_BASE=https://api.kuronaiapp.com`.
