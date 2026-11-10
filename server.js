import "dotenv/config";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import jwt from "jsonwebtoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const VERIFY_API = (process.env.JV_VERIFY_API_BASE || "https://google-colabe-bot.onrender.com").replace(/\/$/, "");
const POSTZEN_KEY = process.env.POSTZEN_API_KEY || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MAX_MB = Math.max(1, Math.min(Number(process.env.MAX_VIDEO_SIZE_MB || 500), 500));
const MAX_BYTES = MAX_MB * 1024 * 1024;
const POSTZEN = "https://api.postzen.dev";
const KURONAI_API = (process.env.KURONAI_API_BASE || "https://api.kuronaiapp.com").replace(/\/$/, "");
const KURONAI_TG_ID = process.env.KURONAI_TG_ID || "";
const KURONAI_MAX_BYTES = 60 * 1024 * 1024;

const required = [
  ["UPSTASH_REDIS_REST_URL", process.env.UPSTASH_REDIS_REST_URL],
  ["UPSTASH_REDIS_REST_TOKEN", process.env.UPSTASH_REDIS_REST_TOKEN],
  ["POSTZEN_API_KEY", POSTZEN_KEY],
  ["APP_URL", APP_URL],
  ["SESSION_SECRET", SESSION_SECRET]
];
const missing = required.filter(([, value]) => !value).map(([name]) => name);
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try { redis = Redis.fromEnv(); } catch (error) { console.error("Upstash setup:", error.message); }
}

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const userKey = uid => `jvpostzen:user:${uid}`;
const oauthKey = state => `jvpostzen:oauth:${state}`;
const postsKey = uid => `jvpostzen:user:${uid}:history`;

function getIdentity(req) {
  const uid = String(req.get("x-jv-telegram-uid") || "");
  const browserToken = String(req.get("x-jv-browser-token") || "");
  if (!/^[0-9]{5,20}$/.test(uid) || !/^[a-f0-9]{48}$/.test(browserToken)) return null;
  return { uid, browserToken };
}

function signedSession(identity) {
  return jwt.sign(
    { sub: identity.uid, browserToken: identity.browserToken },
    SESSION_SECRET,
    { expiresIn: "12h", issuer: "jv-postzen-existing-bot" }
  );
}

function getSession(req) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET, { issuer: "jv-postzen-existing-bot" });
    if (!/^[0-9]{5,20}$/.test(String(payload.sub)) || !/^[a-f0-9]{48}$/.test(String(payload.browserToken))) return null;
    return { uid: String(payload.sub), browserToken: String(payload.browserToken) };
  } catch { return null; }
}

async function verifyWithExistingJVBot(identity) {
  const url = `${VERIFY_API}/verify/${encodeURIComponent(identity.uid)}/${encodeURIComponent(identity.browserToken)}`;
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  let data;
  try { data = await response.json(); } catch { throw new Error("JV verification service returned an unreadable response."); }
  if (!response.ok) {
    const error = new Error(data.message || `JV verification service returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function ensureReady(_req, res, next) {
  if (missing.length) return res.status(503).json({ error: "Server configuration is incomplete.", missing });
  if (!redis) return res.status(503).json({ error: "Upstash Redis is not configured." });
  next();
}

async function requireVerified(req, res, next) {
  try {
    const identity = getSession(req) || getIdentity(req);
    if (!identity) return res.status(401).json({ error: "Enter your Telegram UID and verify through the existing JV bot." });
    const verification = await verifyWithExistingJVBot(identity);
    if (verification.allowed !== true) {
      return res.status(403).json({
        error: verification.reason || "JV bot verification failed.",
        reason: verification.reason || "verification_failed",
        message: verification.message || null
      });
    }
    req.identity = identity;
    req.sessionToken = signedSession(identity);
    next();
  } catch (error) {
    console.error("JV verification failed:", error.message);
    res.status(error.status || 502).json({ error: error.message || "Could not reach the JV verification service." });
  }
}

async function postzen(pathname, options = {}) {
  const response = await fetch(`${POSTZEN}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${POSTZEN_KEY}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const error = new Error(data.error || `PostZen API returned HTTP ${response.status}.`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function ensureUser(uid) {
  let record = await redis.get(userKey(uid));
  if (record?.postzenProfileId) return record;
  const created = await postzen("/v1/profiles", {
    method: "POST",
    body: JSON.stringify({ name: `JV User ${uid}` })
  });
  const profileId = created.profile?._id || created.profile?.id || created._id || created.profileId;
  if (!profileId) throw new Error("PostZen did not return a profile ID when creating the user's workspace.");
  record = { telegramId: uid, postzenProfileId: profileId, createdAt: new Date().toISOString() };
  await redis.set(userKey(uid), record);
  return record;
}

app.get("/api/config", (_req, res) => {
  res.json({
    ready: missing.length === 0 && Boolean(redis),
    missing,
    maxVideoSizeMB: MAX_MB,
    authentication: "existing-jv-bot-uid"
  });
});

app.post("/api/auth/verify", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const record = await ensureUser(req.identity.uid);
    res.json({
      ok: true,
      uid: req.identity.uid,
      sessionToken: req.sessionToken,
      profileReady: Boolean(record.postzenProfileId)
    });
  } catch (error) { next(error); }
});

app.get("/api/me", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const record = await ensureUser(req.identity.uid);
    res.json({ uid: req.identity.uid, profileReady: Boolean(record.postzenProfileId) });
  } catch (error) { next(error); }
});

app.post("/api/connect/tiktok", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const record = await ensureUser(req.identity.uid);
    const redirectUrl = `${APP_URL}/oauth/postzen`;
    const result = await postzen(`/v1/connect/tiktok?profileId=${encodeURIComponent(record.postzenProfileId)}&redirectUrl=${encodeURIComponent(redirectUrl)}`);
    const authUrl = result.authUrl || result.url || result.connectUrl;
    const state = result.state;
    if (!authUrl || !state) throw new Error("PostZen did not return the TikTok authorization URL and state.");
    await redis.set(oauthKey(String(state)), {
      telegramId: req.identity.uid,
      profileId: record.postzenProfileId
    }, { ex: 600 });
    res.json({ authUrl });
  } catch (error) { next(error); }
});

app.get("/oauth/postzen", ensureReady, async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error || !code || !state) return res.redirect("/?connect=cancelled");
    const stateRecord = await redis.get(oauthKey(String(state)));
    if (!stateRecord?.profileId || !stateRecord?.telegramId) return res.redirect("/?connect=expired");
    await postzen("/v1/connect/tiktok", {
      method: "POST",
      body: JSON.stringify({
        code: String(code),
        state: String(state),
        profileId: stateRecord.profileId
      })
    });
    await redis.del(oauthKey(String(state)));
    res.redirect("/?connect=success");
  } catch (error) {
    console.error("PostZen OAuth callback:", error.details || error.message);
    res.redirect("/?connect=failed");
  }
});

app.get("/api/accounts", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const record = await ensureUser(req.identity.uid);
    const data = await postzen(`/v1/accounts?profileId=${encodeURIComponent(record.postzenProfileId)}`);
    const accounts = data.accounts || data.data || [];
    await redis.set(`${userKey(req.identity.uid)}:accounts`, accounts);
    res.json({ accounts });
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_")}`)
  }),
  limits: { fileSize: MAX_BYTES, files: 1 }
});

// Native FFmpeg processing runs on the server. No FFmpeg WebAssembly is sent to browsers.
app.post("/api/process/ffmpeg", ensureReady, requireVerified, upload.single("file"), async (req, res, next) => {
  const input = req.file;
  let outputPath = "";
  try {
    if (!input) return res.status(400).json({ error: "Choose a video file first." });
    const ext = path.extname(input.originalname || "").toLowerCase();
    const allowed = new Set([".mp4", ".mov", ".m4v"]);
    if (!allowed.has(ext)) return res.status(400).json({ error: "Use an MP4, MOV, or M4V video for native FFmpeg stream-copy processing." });

    const fpsValue = req.body.outputFps ? Number(req.body.outputFps) : 0;
    if (req.body.outputFps && (!Number.isFinite(fpsValue) || fpsValue < 1 || fpsValue > 240)) {
      return res.status(400).json({ error: "Output FPS must be between 1 and 240." });
    }

    outputPath = path.join(os.tmpdir(), `${crypto.randomUUID()}-jv-output.mp4`);
    const args = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"];
    if (fpsValue > 0) {
      const inputFps = Number(req.body.inputFps);
      if (!Number.isFinite(inputFps) || inputFps <= 0 || inputFps > 1000) {
        return res.status(400).json({ error: "A valid detected input FPS is required for timestamp scaling." });
      }
      const scale = inputFps / fpsValue;
      args.push("-itsscale:v", String(scale), "-itsscale:a", String(scale));
    }
    args.push("-i", input.path, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputPath);

    await new Promise((resolve, reject) => {
      const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
      child.once("error", error => {
        if (error.code === "ENOENT") reject(new Error("Native FFmpeg is not installed on this server. Check the Render build command."));
        else reject(error);
      });
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (exit ${code}): ${stderr.trim().slice(-1800) || "unsupported input or stream layout"}`)));
    });

    const stat = await fs.promises.stat(outputPath);
    if (!stat.size) throw new Error("FFmpeg produced an empty output file.");
    const suffix = fpsValue > 0 ? `_itscale_${fpsValue}fps` : "_ffmpeg";
    const downloadName = `${path.basename(input.originalname, path.extname(input.originalname))}${suffix}.mp4`;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.setHeader("Cache-Control", "no-store");
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(outputPath);
      stream.on("error", reject);
      res.on("finish", resolve);
      res.on("close", resolve);
      stream.pipe(res);
    });
  } catch (error) {
    if (!res.headersSent) next(error);
    else console.error("Native FFmpeg response failed:", error.message);
  } finally {
    if (input?.path) fs.promises.unlink(input.path).catch(() => {});
    if (outputPath) fs.promises.unlink(outputPath).catch(() => {});
  }
});

// Kuronai processing is proxied through this server so the Telegram access ID
// is never shipped to browser JavaScript.
app.post("/api/process/jarvis", ensureReady, requireVerified, upload.single("file"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!KURONAI_TG_ID) return res.status(503).json({ error: "KURONAI_TG_ID is not configured on the server." });
    if (!file) return res.status(400).json({ error: "Choose a video file first." });
    if (file.size > KURONAI_MAX_BYTES) return res.status(413).json({ error: "Kuronai processing is limited to 60 MB per video." });
    const enhanced = String(req.query.enhanced || "0") === "1";
    const hq = String(req.query.hd || "0") === "1";
    const hqReencode = String(req.query.reencode || "1") !== "0";
    const form = new FormData();
    const bytes = await fs.promises.readFile(file.path);
    form.append("file", new Blob([bytes], { type: file.mimetype || "video/mp4" }), file.originalname);
    form.append("tg_id", KURONAI_TG_ID);
    form.append("progress", "true");
    // Kuronai HQ mode uses /upload/. Re-encoding ON omits encode_video
    // (HQ server default); OFF explicitly sends false. Standard patch mode
    // always disables re-encoding.
    if (!enhanced && (!hq || !hqReencode)) form.append("encode_video", "false");
    const upstream = await fetch(`${KURONAI_API}${enhanced ? "/uploaden/" : "/upload/"}`, {
      method: "POST", body: form, signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) { next(error); }
  finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
});

app.get("/api/process/jarvis/download/:fileId", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const fileId = String(req.params.fileId || "");
    if (!/^[a-zA-Z0-9._-]{1,512}$/.test(fileId)) return res.status(400).json({ error: "Invalid Kuronai file ID." });
    // Kuronai uses tg_id as its server-access credential for file retrieval too.
    const downloadUrl = new URL(`${KURONAI_API}/download/${encodeURIComponent(fileId)}`);
    downloadUrl.searchParams.set("tg_id", KURONAI_TG_ID);
    const upstream = await fetch(downloadUrl, {
      headers: { "X-TG-ID": KURONAI_TG_ID },
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 1200);
      console.error("Kuronai download rejected:", upstream.status, detail);
      return res.status(upstream.status).json({
        error: `Kuronai download failed (HTTP ${upstream.status}).`,
        upstream: detail || null
      });
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    if (upstream.headers.get("content-length")) res.setHeader("Content-Length", upstream.headers.get("content-length"));
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
  } catch (error) { next(error); }
});

app.delete("/api/process/jarvis/cleanup/:fileId", ensureReady, requireVerified, async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "");
    if (!/^[a-zA-Z0-9._-]{1,512}$/.test(fileId)) return res.status(400).json({ error: "Invalid Kuronai file ID." });
    const cleanupUrl = new URL(`${KURONAI_API}/cleanup/${encodeURIComponent(fileId)}`);
    cleanupUrl.searchParams.set("tg_id", KURONAI_TG_ID);
    const upstream = await fetch(cleanupUrl, {
      method: "DELETE",
      headers: { "X-TG-ID": KURONAI_TG_ID }
    });
    res.status(upstream.ok ? 204 : upstream.status).end();
  } catch { res.status(204).end(); }
});

app.post("/api/posts", ensureReady, requireVerified, upload.single("video"), async (req, res, next) => {
  const file = req.file;
  let progressStreamStarted = false;
  const sendProgress = (stage, percent, message, extra = {}) => {
    if (!progressStreamStarted || res.destroyed || res.writableEnded) return;
    const type = stage === "complete" ? "complete" : "progress";
    res.write(`${JSON.stringify({ type, stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message, ...extra })}\n`);
  };
  const startProgressStream = () => {
    if (progressStreamStarted) return;
    progressStreamStarted = true;
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  };
  try {
    if (!file) return res.status(400).json({ error: "Choose a video file first." });
    if (req.body.musicRights !== "true" || req.body.videoRights !== "true") return res.status(400).json({ error: "Tick both the music copyright and video copyright boxes first." });
    startProgressStream();
    sendProgress("profile", 3, "Checking your private PostZen profile…");
    const record = await ensureUser(req.identity.uid);
    const accountId = String(req.body.accountId || "");

    sendProgress("account", 8, "Verifying the selected TikTok account…");
    // Fetch fresh account ownership from PostZen; do not trust a browser-supplied account ID.
    const accountResponse = await postzen(`/v1/accounts?profileId=${encodeURIComponent(record.postzenProfileId)}`);
    const accounts = accountResponse.accounts || accountResponse.data || [];
    const account = accounts.find(item => String(item._id || item.id) === accountId && item.platform === "tiktok");
    if (!account) throw new Error("That TikTok account is not connected to this Telegram UID's PostZen profile.");

    const contentType = file.mimetype || "video/mp4";
    const allowedTypes = new Set(["video/mp4", "video/mpeg", "video/quicktime", "video/avi", "video/x-msvideo", "video/webm", "video/x-m4v"]);
    if (!allowedTypes.has(contentType)) throw new Error("Unsupported video type. Use MP4, MOV, WebM, AVI or MPEG.");

    const mode = String(req.body.mode || "draft");
    const userCaption = String(req.body.caption || "").trim();
    const watermark = "#jvpersonaltest • Upload Method - @jv_60fps";
    const caption = (userCaption ? `${userCaption}\n\n${watermark}` : watermark).slice(0, 2200);
    const postBody = {
      content: caption,
      mediaItems: [],
      platforms: [{
        platform: "tiktok",
        accountId,
        settings: mode === "draft"
          ? { uploadAsDraft: true }
          : {
              privacyLevel: ["publicToEveryone", "mutualFollowFriends", "selfOnly"].includes(req.body.privacyLevel) ? req.body.privacyLevel : "publicToEveryone",
              allowComment: req.body.allowComment !== "false",
              allowDuet: req.body.allowDuet !== "false",
              allowStitch: req.body.allowStitch !== "false"
            }
      }]
    };
    if (mode === "publish") postBody.publishNow = true;
    else if (mode === "schedule") {
      const date = new Date(req.body.scheduledFor);
      if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 60000) {
        throw new Error("Choose a schedule time at least 60 seconds in the future.");
      }
      postBody.scheduledFor = date.toISOString();
    } else if (mode === "draft") postBody.isDraft = true;
    else throw new Error("Invalid publishing mode.");

    sendProgress("presign", 14, "Requesting a secure media upload from PostZen…");
    const presign = await postzen("/v1/media/presign", {
      method: "POST",
      body: JSON.stringify({
        filename: file.originalname,
        contentType,
        size: file.size,
        profileId: record.postzenProfileId
      })
    });
    if (!presign.uploadUrl || !presign.publicUrl) throw new Error("PostZen returned an incomplete media upload response.");

    sendProgress("media_upload", 20, "Uploading the processed video to PostZen media storage…");
    let uploadedBytes = 0;
    let lastReportedPercent = -1;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        uploadedBytes += chunk.length;
        const transferPercent = Math.min(100, Math.round(uploadedBytes / Math.max(file.size, 1) * 100));
        if (transferPercent >= lastReportedPercent + 1 || uploadedBytes >= file.size) {
          lastReportedPercent = transferPercent;
          const pct = 20 + (file.size ? (uploadedBytes / file.size) * 60 : 60);
          sendProgress("media_upload", pct, `Transferring video to PostZen media storage · ${transferPercent}%`);
        }
        callback(null, chunk);
      }
    });
    const stream = fs.createReadStream(file.path).pipe(meter);
    const putResponse = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(file.size) },
      body: stream,
      duplex: "half",
      signal: AbortSignal.timeout(15 * 60 * 1000)
    });
    if (!putResponse.ok) throw new Error(`PostZen media upload failed with HTTP ${putResponse.status}.`);
    postBody.mediaItems = [{ url: presign.publicUrl }];

    sendProgress("publish", 85, "Media upload complete. Submitting the TikTok post request…");
    const result = await postzen("/v1/posts", {
      method: "POST",
      body: JSON.stringify(postBody),
      headers: { "x-request-id": crypto.randomUUID() }
    });
    const post = result.post || result.existingPost || result;
    const history = {
      id: post._id || crypto.randomUUID(),
      caption,
      status: post.status || (mode === "draft" ? "draft_submitted" : mode === "schedule" ? "scheduled_submitted" : "publish_submitted"),
      createdAt: new Date().toISOString(),
      scheduledFor: post.scheduledFor || postBody.scheduledFor || null
    };
    await redis.lpush(postsKey(req.identity.uid), JSON.stringify(history));
    await redis.ltrim(postsKey(req.identity.uid), 0, 49);
    const response = { ok: true, post: history, message: result.message || "Your post request was accepted by PostZen." };
    sendProgress("complete", 100, "PostZen accepted the TikTok post request.", { result: response });
    res.end();
  } catch (error) {
    if (progressStreamStarted) {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`${JSON.stringify({ type: "error", error: error.message || "PostZen publishing failed." })}\n`);
        res.end();
      }
    } else next(error);
  } finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
});

app.get("/api/history", ensureReady, requireVerified, async (req, res) => {
  const items = await redis.lrange(postsKey(req.identity.uid), 0, 49);
  res.json({
    posts: items.map(item => typeof item === "string" ? JSON.parse(item) : item)
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "JV PostZen" }));

app.use((error, _req, res, _next) => {
  console.error(error.details || error.stack || error.message);
  const status = error.code === "LIMIT_FILE_SIZE" ? 413 : (error.status || 500);
  res.status(status).json({
    error: error.code === "LIMIT_FILE_SIZE"
      ? `Video exceeds the ${MAX_MB} MB upload limit.`
      : (error.message || "Unexpected server error"),
    details: process.env.NODE_ENV === "production" ? undefined : error.details
  });
});

app.listen(PORT, () => {
  console.log(`JV PostZen server listening on ${PORT}`);
  if (missing.length) console.warn("Missing environment variables:", missing.join(", "));
});
