# JV Studio — PostZen Publisher (multi-user Node.js)

A Render-ready Express app with Supabase Auth/PostgreSQL and PostZen TikTok publishing. Every signed-in user receives a separate PostZen profile. Connected account IDs are checked against the signed-in user's profile before a post is sent.

## 1. Supabase setup

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste and run `supabase/schema.sql`.
3. In Supabase → **Connect** → **Framework** (the option you selected), copy:
   - Project URL
   - Publishable key (`sb_publishable_...`)
   - Secret key (`sb_secret_...`) — reveal/copy privately.
4. In Authentication → URL Configuration, set Site URL to your Render URL after deployment. Add your Render URL to Redirect URLs. For local testing, add `http://localhost:3000/**`.

This project uses Supabase Auth for signup/login. The browser receives only the publishable key. The secret key is used only by the server.

## 2. PostZen setup

Create a **Read & Write** API key in the PostZen dashboard. Store it only in Render environment variables. The app creates one PostZen profile per new Supabase user and stores the mapping in `app_profiles`.

PostZen's Free plan currently allows two connected accounts total on the API key/account, not two per user. More accounts may require a PostZen plan upgrade.

## 3. Deploy to Render

Create a **Web Service** from this repository:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Node: 20 or newer

Add environment variables in Render → Environment:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Supabase secret key |
| `POSTZEN_API_KEY` | PostZen Read & Write key |
| `APP_URL` | `https://your-service.onrender.com` |
| `MAX_VIDEO_SIZE_MB` | `500` (or a value appropriate for your Render plan) |

Redeploy after saving environment variables.

## 4. Run locally

```bash
cp .env.example .env
# Fill in the values in .env
npm install
npm start
```
Open `http://localhost:3000`.

## 5. Included API routes

- `GET /api/health`
- `GET /api/config`
- `GET /api/me` — verifies session, creates/loads the user's workspace, lists only their profile's TikTok accounts.
- `POST /api/connect/tiktok` — starts PostZen OAuth for that user's profile.
- `POST /api/connect/complete` — completes OAuth only if the OAuth state belongs to the signed-in user.
- `POST /api/upload` — uploads video to PostZen presigned storage.
- `POST /api/posts` — validates ownership of account and publishes/schedules/drafts.
- `GET /api/posts` — returns only the signed-in user's local publishing history.

## Security notes

- Never commit `.env`, Supabase secret key, or PostZen API key.
- Do not expose the Supabase secret key or PostZen API key in browser code.
- OAuth state is stored server-side and checked against the authenticated user.
- Every account/post query includes the authenticated Supabase user ID.
- For production, configure Supabase email confirmation, rate limits, logging, backups, and a durable upload strategy. Render's local filesystem is temporary; uploads are streamed to PostZen and temporary files are deleted.
- The default video limit is 500 MB to avoid oversized requests on free hosting. Raise only after checking your Render plan's request/body limits. TikTok videos have a 4 GB maximum according to PostZen's TikTok guide.
- The app stores publishing submission status. A webhook endpoint should be added before treating local status as final delivery status.

## API references used

- PostZen Quickstart: https://docs.postzen.dev/
- PostZen TikTok guide: https://docs.postzen.dev/platforms/tiktok
- PostZen OAuth completion: https://docs.postzen.dev/api-reference/connect/complete-connect
