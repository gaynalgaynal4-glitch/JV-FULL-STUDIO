import "dotenv/config";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
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

app.post("/api/posts", ensureReady, requireVerified, upload.single("video"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Choose a video file first." });
    const record = await ensureUser(req.identity.uid);
    const accountId = String(req.body.accountId || "");

    // Fetch fresh account ownership from PostZen; do not trust a browser-supplied account ID.
    const accountResponse = await postzen(`/v1/accounts?profileId=${encodeURIComponent(record.postzenProfileId)}`);
    const accounts = accountResponse.accounts || accountResponse.data || [];
    const account = accounts.find(item => String(item._id || item.id) === accountId && item.platform === "tiktok");
    if (!account) return res.status(403).json({ error: "That TikTok account is not connected to this Telegram UID's PostZen profile." });

    const contentType = file.mimetype || "video/mp4";
    const allowedTypes = new Set(["video/mp4", "video/mpeg", "video/quicktime", "video/avi", "video/x-msvideo", "video/webm", "video/x-m4v"]);
    if (!allowedTypes.has(contentType)) return res.status(400).json({ error: "Unsupported video type. Use MP4, MOV, WebM, AVI or MPEG." });

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

    const stream = fs.createReadStream(file.path);
    const putResponse = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: stream,
      duplex: "half",
      signal: AbortSignal.timeout(15 * 60 * 1000)
    });
    if (!putResponse.ok) throw new Error(`PostZen media upload failed with HTTP ${putResponse.status}.`);

    const mode = String(req.body.mode || "draft");
    const caption = String(req.body.caption || "").slice(0, 2200);
    const postBody = {
      content: caption,
      mediaItems: [{ url: presign.publicUrl }],
      platforms: [{
        platform: "tiktok",
        accountId,
        settings: mode === "draft"
          ? { uploadAsDraft: true }
          : { privacyLevel: req.body.privacyLevel || "publicToEveryone" }
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
    res.json({ ok: true, post: history, message: result.message || "Your post request was accepted by PostZen." });
  } catch (error) { next(error); }
  finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
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
