# JV PostZen + JV Video Lab

This project keeps the two supplied websites as separate HTML documents. The PostZen publisher is the main page; the supplied Video Lab page is retained separately and used as the processing engine.

## Page structure

- `public/index.html` — JV PostZen website: existing JV bot verification, TikTok account connection, caption, video selection, publishing mode, method settings and live workflow progress.
- `public/video-lab.html` — supplied JV Video Lab HTML and its processing methods. PostZen loads this page in a hidden same-origin iframe for processing. The two HTML documents are not merged.
- `public/app.js` — PostZen UI, method selection, processing bridge and publishing workflow.
- `server.js` — verification, PostZen API, Upstash storage, Kuronai proxy and native FFmpeg endpoint.

## Publishing workflow

1. Verify the Telegram UID with the existing JV bot verification service.
2. Connect a TikTok account through PostZen.
3. Open **⚙ Processing method** and select Enhanced, HD, Local, FFmpeg or Only Upload.
4. Choose a video, enter the caption and choose draft, publish or schedule.
5. PostZen sends the video to the selected Video Lab method.
6. The processed MP4 is returned to PostZen and uploaded to PostZen media storage.
7. PostZen submits the TikTok post request. The same live progress area reports processing, browser-to-server upload, PostZen media transfer and post submission.

## Processing methods

- **Enhanced** — Video Lab's enhanced server flow, proxied through `/api/process/jarvis?enhanced=1`. The Kuronai access ID is only read from the server environment variable `KURONAI_TG_ID`; it is not shipped in browser JavaScript. The current enhanced upload limit is 60 MB.
- **Local** — Video Lab's browser MP4 patcher. The source video is processed in the browser; the processed Blob is then sent to PostZen for publishing. The supplied patcher supports MP4 with AVC/H.264 or HEVC/H.265 video.
- **HD** — uses the existing Kuronai HQ server upload route (`/upload/`) and deliberately omits `encode_video`, matching the supplied Kuronai extension HQ mode. The access ID remains server-side.
- **FFmpeg** — native server-side FFmpeg stream-copy remux through `/api/process/ffmpeg`. It uses `-c copy`, does not re-encode, and does not download FFmpeg WebAssembly or a browser worker. It accepts MP4, MOV and M4V containers subject to codec/container compatibility. During the FFmpeg compute stage the progress bar uses an indeterminate animation because this endpoint returns a binary response rather than exact per-frame progress; transfer progress is measured.

`public/video-lab.html` also keeps its FPS Studio UI, which now calls the same native FFmpeg endpoint for timestamp scaling. This is timestamp scaling, not AI frame interpolation or motion-compensated frame generation.

## Server environment

Copy `.env.example` to `.env` for local development, or configure the same values in Render Environment Variables:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN` — use a rotated token; never commit it.
- `POSTZEN_API_KEY` — PostZen Read & Write key.
- `APP_URL` — deployed HTTPS origin.
- `SESSION_SECRET` — random secret of at least 32 characters.
- `JV_VERIFY_API_BASE=https://google-colabe-bot.onrender.com`
- `KURONAI_API_BASE=https://api.kuronaiapp.com`
- `KURONAI_TG_ID` — your Kuronai access ID, server-side only.
- `MAX_VIDEO_SIZE_MB=500`
- `NODE_ENV=production`

Render deployment:

- Build command: `npm install`
- Start command: `npm start`
- Node.js 20+
- `apt.txt` requests the native `ffmpeg` package for the Render runtime. On another host, install FFmpeg and ensure it is on `PATH`, or set `FFMPEG_PATH`.

Never put API keys, Redis tokens, session secrets or the Kuronai access ID in `public/` or commit `.env`.

## Caption watermark

The backend appends this text to the user's caption:

`#jvpersonaltest • Upload Method - @jv_60fps`

The hashtag is caption text. `@jv_60fps` is plain caption text unless PostZen's TikTok integration supports structured mention metadata; this project does not claim that the mention is clickable.

## Validation and limitations

- `npm run check` validates the server, PostZen browser script and inline scripts in both HTML pages.
- The native FFmpeg command was smoke-tested locally with an MP4 sample.
- Live Kuronai, PostZen, Upstash, Telegram verification and Render deployment were not tested in this environment; configure the real credentials and test a draft first.
- PostZen history stores the submission response. It is not a guarantee that TikTok has completed delivery.
- Browser-local patching requires a supported MP4 and enough memory in the browser.
