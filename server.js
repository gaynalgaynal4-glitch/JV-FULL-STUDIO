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
const LIME_TOTAL_ACCOUNT_CAPACITY = Math.max(0, Number.parseInt(process.env.LIME_TOTAL_ACCOUNT_CAPACITY || "0", 10) || 0);
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MAX_MB = Math.max(1, Math.min(Number(process.env.MAX_VIDEO_SIZE_MB || 500), 500));
const MAX_BYTES = MAX_MB * 1024 * 1024;
const LIME_API = "https://api.limesocial.io";
const KURONAI_API = (process.env.KURONAI_API_BASE || "https://api.kuronaiapp.com").replace(/\/$/, "");
const KURONAI_TG_ID = process.env.KURONAI_TG_ID || "";
const KURONAI_MAX_BYTES = 60 * 1024 * 1024;

const required = [
  ["UPSTASH_REDIS_REST_URL", process.env.UPSTASH_REDIS_REST_URL],
  ["UPSTASH_REDIS_REST_TOKEN", process.env.UPSTASH_REDIS_REST_TOKEN],
  ["APP_URL", APP_URL],
  ["SESSION_SECRET", SESSION_SECRET.length >= 32 ? SESSION_SECRET : ""]
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

const userKey = uid => `jvpostzen:user:${uid}`; // Keep legacy key namespace so Telegram user records remain intact.
const postsKey = uid => `jvpostzen:user:${uid}:history`; // Preserve existing publishing history.
const LIME_ACTIVE_KEY = "jv:limesocial:connections";
const LIME_PENDING_KEY = "jv:limesocial:pending";
const limeUserKey = uid => `jv:limesocial:user:${uid}`;
const limeOAuthKey = state => `jv:limesocial:oauth:${state}`;
const keyFingerprint = keyRecord => crypto.createHash("sha256").update(keyRecord.key).digest("hex");
const limeHealthKey = keyRecord => `jv:limesocial:key-health:${keyFingerprint(keyRecord)}`;
const findConfiguredKey = record => configuredLimeKeys().find(item => keyFingerprint(item) === record?.keyFingerprint) || null;

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

// Video inspection only needs a previously verified, signed JV session. It must not
// depend on Redis/Lime Social readiness or call the remote JV bot for every video upload.
function requireSession(req, res, next) {
  const identity = getSession(req);
  if (!identity) return res.status(401).json({ error: "Your JV session is missing or expired. Sign in again, then select the video." });
  req.identity = identity;
  next();
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

async function rateLimitByUid(prefix, maxRequests, windowSeconds, req, res) {
  const uid = req.identity?.uid;
  if (!uid) return false;
  const key = `jv:ratelimit:${prefix}:${uid}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  if (count > maxRequests) {
    res.set("Retry-After", String(windowSeconds));
    res.status(429).json({ error: "Too many requests. Wait briefly and try again." });
    return true;
  }
  return false;
}

function safeTelegramProfile(verification) {
  const user = verification?.telegramProfile || verification?.profile || verification?.user || verification?.telegramUser || verification || {};
  const firstName = user.first_name || user.firstName || "";
  const username = user.username || "";
  const displayName = [firstName].filter(Boolean).join(" ") || username || "Telegram account";
  // Never send Telegram's token-bearing file URL to the browser.
  const hasPhoto = Boolean(user.photoUrl || user.photo_url || user.avatarUrl || user.avatar_url || user.profile_photo_url);
  return {
    displayName: String(displayName).slice(0, 80),
    username: String(username).slice(0, 64),
    photoUrl: hasPhoto ? "/api/telegram/profile-photo" : null
  };
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
    req.verification = verification;
    req.sessionToken = signedSession(identity);
    next();
  } catch (error) {
    console.error("JV verification failed:", error.message);
    res.status(error.status || 502).json({ error: error.message || "Could not reach the JV verification service." });
  }
}

async function limeRequest(keyRecord, pathname, options = {}) {
  const { authScheme = "raw", ...fetchOptions } = options;
  const health = await redis.get(limeHealthKey(keyRecord));
  if (health?.blockedUntil && Number(health.blockedUntil) > Date.now()) {
    const error = new Error("This Lime Social API key is temporarily unavailable.");
    error.status = health.status || 503;
    throw error;
  }
  let response;
  try {
    response = await fetch(`${LIME_API}${pathname}`, {
      ...fetchOptions,
      headers: {
        Authorization: `${authScheme === "Bearer" ? "Bearer " : ""}${keyRecord.key}`,
        ...(fetchOptions.body && !(fetchOptions.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.headers || {})
      },
      signal: fetchOptions.signal || AbortSignal.timeout(30000)
    });
  } catch (cause) {
    await redis.set(limeHealthKey(keyRecord), { status: 503, blockedUntil: Date.now() + 30000 }, { ex: 30 }).catch(() => {});
    const error = new Error("Lime Social could not be reached. This API key is temporarily paused.");
    error.status = 503;
    throw error;
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: "Provider returned an unreadable response." }; }
  if (response.status === 429) {
    await redis.set(limeHealthKey(keyRecord), { status: 429, blockedUntil: Date.now() + 60000 }, { ex: 60 });
  } else if (response.status === 401) {
    await redis.set(limeHealthKey(keyRecord), { status: 401, blockedUntil: Date.now() + 24 * 60 * 60 * 1000 }, { ex: 86400 });
  } else if (response.status >= 500) {
    await redis.set(limeHealthKey(keyRecord), { status: response.status, blockedUntil: Date.now() + 30000 }, { ex: 30 });
  } else if (response.ok) {
    await redis.del(limeHealthKey(keyRecord));
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.error || data?.message || `Lime Social returned HTTP ${response.status}.`;
    const error = new Error(typeof message === "string" ? message : `Lime Social returned HTTP ${response.status}.`);
    error.status = response.status;
    error.providerCode = data?.error?.code || null;
    throw error;
  }
  return data;
}

async function ensureUser(uid) {
  let record = await redis.get(userKey(uid));
  if (!record) {
    record = { telegramId: uid, createdAt: new Date().toISOString() };
    await redis.set(userKey(uid), record);
  }
  // Legacy PostZen profile fields are deliberately retained as inert historical data.
  return record;
}

function configuredLimeKeys() {
  return Object.entries(process.env).map(([name, value]) => {
    const match = name.match(/^LIME_API_KEY_(\d+)$/);
    return match && value?.trim() ? { id: Number(match[1]), key: value.trim() } : null;
  }).filter(Boolean).sort((a, b) => a.id - b.id);
}

async function getLimeMe(keyRecord) {
  const response = await limeRequest(keyRecord, "/v1/me");
  return { data: response.data || {}, accounts: Array.isArray(response.accounts) ? response.accounts : [] };
}

async function chooseLimeKey() {
  const keys = configuredLimeKeys();
  if (!keys.length) {
    const error = new Error("No Lime Social API keys are configured. Add LIME_API_KEY_1 and at least one valid key in Render.");
    error.status = 503;
    throw error;
  }
  const candidates = [];
  for (const key of keys) {
    try {
      const me = await getLimeMe(key);
      const tiktokCount = me.accounts.filter(a => a.platform === "tiktok").length;
      candidates.push({ key, tiktokCount });
    } catch (error) {
      console.warn(`Lime Social key slot ${key.id} unavailable (HTTP ${error.status || 0}).`);
    }
  }
  if (!candidates.length) {
    const error = new Error("No configured Lime Social API key is currently usable. Check the keys and provider rate limits.");
    error.status = 503;
    throw error;
  }
  candidates.sort((a, b) => a.tiktokCount - b.tiktokCount || a.key.id - b.key.id);
  return candidates[0].key;
}

async function getConnectionStats() {
  const active = await redis.hlen(LIME_ACTIVE_KEY);
  const now = Date.now();
  await redis.zremrangebyscore(LIME_PENDING_KEY, 0, now);
  const pending = await redis.zcard(LIME_PENDING_KEY);
  const total = LIME_TOTAL_ACCOUNT_CAPACITY;
  const providerKeysAvailable = configuredLimeKeys().length > 0;
  return { totalCapacity: total, connected: active, pendingReservations: pending, availableSlots: Math.max(0, total - active - pending), providerKeysAvailable, acceptingConnections: total > 0 && providerKeysAvailable && active + pending < total };
}

const RESERVE_SLOT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, ARGV[1])
if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 'USER_ALREADY_CONNECTED' end
local active = redis.call('HLEN', KEYS[1])
local pending = redis.call('ZCARD', KEYS[2])
if tonumber(ARGV[3]) <= 0 or active + pending >= tonumber(ARGV[3]) then return 'FULL' end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('SET', KEYS[3], ARGV[5], 'EX', 600)
return 'OK'
`;

async function reserveConnection(uid, state) {
  const result = await redis.eval(RESERVE_SLOT_LUA, [LIME_ACTIVE_KEY, LIME_PENDING_KEY, limeUserKey(uid)], [String(Date.now()), uid, String(LIME_TOTAL_ACCOUNT_CAPACITY), String(Date.now() + 10 * 60 * 1000), state]);
  return result;
}

async function releaseConnectionReservation(uid, state) {
  await redis.zrem(LIME_PENDING_KEY, state);
  const current = await redis.get(limeUserKey(uid));
  if (current === state) await redis.del(limeUserKey(uid));
  await redis.del(limeOAuthKey(state));
}

async function getUserConnection(uid) {
  const value = await redis.hget(LIME_ACTIVE_KEY, uid);
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

app.get("/api/config", (_req, res) => {
  res.json({
    ready: missing.length === 0 && Boolean(redis),
    missing,
    maxVideoSizeMB: Math.min(MAX_MB, 100),
    limeConfigured: configuredLimeKeys().length > 0,
    limeKeyCount: configuredLimeKeys().length,
    connectionCapacityConfigured: LIME_TOTAL_ACCOUNT_CAPACITY > 0,
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
      profileReady: true,
      telegramProfile: safeTelegramProfile(req.verification)
    });
  } catch (error) { next(error); }
});

app.get("/api/me", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const record = await ensureUser(req.identity.uid);
    res.json({ uid: req.identity.uid, profileReady: true, sessionToken: req.sessionToken, telegramProfile: safeTelegramProfile(req.verification) });
  } catch (error) { next(error); }
});

app.get("/api/telegram/profile-photo", requireVerified, async (req, res) => {
  // requireVerified supplies the UID and browser token only after the existing
  // JV bot has confirmed that this browser session is authorized.
  const identity = req.identity;
  if (!identity ||
      !/^[0-9]{5,20}$/.test(String(identity.uid)) ||
      !/^[a-f0-9]{48}$/.test(String(identity.browserToken))) {
    return res.sendStatus(401);
  }

  const maxPhotoBytes = 5 * 1024 * 1024;
  const photoEndpoint = `${VERIFY_API}/profile-photo/${encodeURIComponent(identity.uid)}/${encodeURIComponent(identity.browserToken)}`;

  try {
    const imageResponse = await fetch(photoEndpoint, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "image/jpeg" }
    });

    // The JV bot returns 404 when the Telegram user has no profile photo.
    // Do not expose upstream response bodies or internal service details.
    if (imageResponse.status === 404) return res.sendStatus(404);
    if (imageResponse.status === 401 || imageResponse.status === 403) return res.sendStatus(403);
    if (!imageResponse.ok) {
      console.warn("JV profile-photo service returned HTTP", imageResponse.status);
      return res.sendStatus(502);
    }

    const contentType = (imageResponse.headers.get("content-type") || "")
      .split(";")[0].trim().toLowerCase();
    if (contentType !== "image/jpeg") {
      await imageResponse.body?.cancel().catch(() => {});
      return res.sendStatus(502);
    }

    const declaredLength = Number(imageResponse.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxPhotoBytes) {
      await imageResponse.body?.cancel().catch(() => {});
      return res.sendStatus(413);
    }

    if (!imageResponse.body) return res.sendStatus(502);

    // Read incrementally so an upstream response cannot force an unbounded
    // allocation. The JV bot currently serves Telegram profile photos as JPEG.
    const reader = imageResponse.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxPhotoBytes) {
          await reader.cancel().catch(() => {});
          return res.sendStatus(413);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = Buffer.concat(chunks, totalBytes);
    // Check the JPEG signature as well as the upstream MIME type.
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return res.sendStatus(502);
    }

    res.set("Content-Type", "image/jpeg");
    res.set("Content-Length", String(bytes.length));
    res.set("Cache-Control", "private, max-age=300");
    res.set("X-Content-Type-Options", "nosniff");
    return res.send(bytes);
  } catch (error) {
    console.error("JV Telegram profile photo proxy:", error.name === "TimeoutError"
      ? "upstream request timed out"
      : error.message);
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return res.sendStatus(504);
    }
    return res.sendStatus(502);
  }
});

app.get("/api/connections/capacity", ensureReady, requireVerified, async (_req, res, next) => {
  try { res.json(await getConnectionStats()); } catch (error) { next(error); }
});

app.post("/api/connect/tiktok", ensureReady, requireVerified, async (req, res, next) => {
  let state = "";
  try {
    if (await rateLimitByUid("connect", 5, 300, req, res)) return;
    await ensureUser(req.identity.uid);
    const existing = await getUserConnection(req.identity.uid);
    if (existing) return res.status(409).json({ error: "This Telegram UID already has a connected TikTok account. Disconnect it before connecting another." });
    state = crypto.randomBytes(32).toString("hex");
    const reserved = await reserveConnection(req.identity.uid, state);
    if (reserved === "FULL") return res.status(409).json({ error: "The shared TikTok connection pool is full." });
    if (reserved === "USER_ALREADY_CONNECTED") return res.status(409).json({ error: "A TikTok connection or reservation already exists for this Telegram UID." });
    const key = await chooseLimeKey();
    const callback = new URL("/lime/callback", APP_URL);
    callback.searchParams.set("state", state);
    await redis.set(limeOAuthKey(state), { uid: req.identity.uid, keyId: key.id, keyFingerprint: keyFingerprint(key), createdAt: Date.now() }, { ex: 600 });
    const result = await limeRequest(key, "/v1/account/connect", {
      method: "POST",
      authScheme: "Bearer",
      body: JSON.stringify({ link_expiry_limit: 10, allowed_platforms: ["tiktok"], return_url: callback.toString() })
    });
    const connectUrl = result?.data?.connect_url;
    if (!connectUrl) throw new Error("Lime Social did not return a connection URL.");
    res.json({ connectUrl, expiresAt: result.data.expires_at || null, capacity: await getConnectionStats() });
  } catch (error) {
    if (state) {
      const pending = await redis.get(limeOAuthKey(state));
      await releaseConnectionReservation(pending?.uid || req.identity.uid, state).catch(() => {});
    }
    next(error);
  }
});

app.get("/lime/callback", ensureReady, async (req, res) => {
  const state = String(req.query.state || "");
  if (!/^[a-f0-9]{64}$/.test(state)) return res.redirect("/?connect=invalid");
  const pending = await redis.get(limeOAuthKey(state));
  if (!pending?.uid || !Number.isInteger(Number(pending.keyId))) return res.redirect("/?connect=expired");
  const finishFailure = async status => {
    await releaseConnectionReservation(pending.uid, state).catch(() => {});
    return res.redirect(`/?connect=${status}`);
  };
  if (String(req.query.result || "") !== "success" || String(req.query.platform || "") !== "tiktok") return finishFailure("failed");
  const username = String(req.query.account || "").trim().replace(/^@/, "");
  if (!username || username.length > 100) return finishFailure("failed");
  try {
    const key = findConfiguredKey(pending);
    if (!key) return finishFailure("key-unavailable");
    const me = await getLimeMe(key);
    const account = me.accounts.find(item => item.platform === "tiktok" && String(item.username || "").replace(/^@/, "").toLowerCase() === username.toLowerCase());
    if (!account) return finishFailure("not-confirmed");
    const connection = { uid: pending.uid, keyId: key.id, keyFingerprint: keyFingerprint(key), platform: "tiktok", username: String(account.username).replace(/^@/, ""), canPost: account.can_post !== false, connectedAt: new Date().toISOString() };
    const saveLua = `
      if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 'RESERVATION_EXPIRED' end
      if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then return 'ALREADY_CONNECTED' end
      redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
      redis.call('ZREM', KEYS[2], ARGV[1])
      redis.call('DEL', KEYS[3])
      return 'OK'
    `;
    const saved = await redis.eval(saveLua, [LIME_ACTIVE_KEY, LIME_PENDING_KEY, limeUserKey(pending.uid)], [state, pending.uid, JSON.stringify(connection)]);
    if (saved !== "OK") return finishFailure("expired");
    await redis.del(limeOAuthKey(state));
    return res.redirect("/?connect=success");
  } catch (error) {
    console.error("Lime Social callback verification failed:", error.status || "provider error");
    return finishFailure("failed");
  }
});

app.get("/api/accounts", ensureReady, requireVerified, async (req, res, next) => {
  try {
    const connection = await getUserConnection(req.identity.uid);
    if (!connection) return res.json({ accounts: [] });
    const key = findConfiguredKey(connection);
    if (!key) return res.status(503).json({ error: "The API key assigned to this TikTok account is not configured." });
    const me = await getLimeMe(key);
    const account = me.accounts.find(item => item.platform === "tiktok" && String(item.username || "").replace(/^@/, "").toLowerCase() === String(connection.username).toLowerCase());
    if (!account) {
      await redis.hdel(LIME_ACTIVE_KEY, req.identity.uid);
      return res.json({ accounts: [] });
    }
    res.json({ accounts: [{ id: `tiktok-${req.identity.uid}`, platform: "tiktok", username: connection.username, displayName: connection.username, canPost: account.can_post !== false }] });
  } catch (error) { next(error); }
});

app.delete("/api/accounts/:accountId", ensureReady, requireVerified, async (req, res, next) => {
  try {
    if (await rateLimitByUid("disconnect", 10, 300, req, res)) return;
    const connection = await getUserConnection(req.identity.uid);
    if (!connection || req.params.accountId !== `tiktok-${req.identity.uid}`) return res.status(404).json({ error: "This TikTok account is not connected to your Telegram UID." });
    const key = findConfiguredKey(connection);
    if (!key) return res.status(503).json({ error: "The assigned Lime Social API key is unavailable. The connection was not released." });
    const removed = await limeRequest(key, "/v1/account/remove", { method: "DELETE", body: JSON.stringify({ platform: "tiktok", username: connection.username }) });
    if (removed?.success !== true) throw new Error("Lime Social did not confirm that the TikTok account was disconnected.");
    await redis.hdel(LIME_ACTIVE_KEY, req.identity.uid);
    res.json({ ok: true, capacity: await getConnectionStats() });
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_")}`)
  }),
  limits: { fileSize: MAX_BYTES, files: 1 }
});

// Video preview and basic metadata are extracted locally in the browser.

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
    res.write(`${JSON.stringify({ type: stage === "complete" ? "complete" : "progress", stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message, ...extra })}\n`);
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
    if (await rateLimitByUid("publish", 10, 3600, req, res)) return;
    if (!file) return res.status(400).json({ error: "Choose a video file first." });
    if (req.body.musicRights !== "true" || req.body.videoRights !== "true") return res.status(400).json({ error: "Tick both the music copyright and video copyright boxes first." });
    const connection = await getUserConnection(req.identity.uid);
    if (!connection) return res.status(409).json({ error: "Connect a TikTok account before publishing." });
    const accountId = String(req.body.accountId || "");
    if (accountId !== `tiktok-${req.identity.uid}`) return res.status(403).json({ error: "The selected TikTok account does not belong to this Telegram UID." });
    const key = findConfiguredKey(connection);
    if (!key) return res.status(503).json({ error: "The Lime Social API key assigned to this account is missing." });
    const contentType = file.mimetype || "video/mp4";
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (![".mp4", ".mov", ".avi"].includes(ext)) return res.status(400).json({ error: "Lime Social direct video upload supports MP4, MOV and AVI files." });
    if (file.size > 100 * 1024 * 1024) return res.status(413).json({ error: "Lime Social documents a maximum direct video upload size of 100 MB." });
    const mode = String(req.body.mode || "publish");
    const caption = String(req.body.caption || "").trim().slice(0, 10000);
    if (!caption) return res.status(400).json({ error: "Enter a caption before publishing." });
    if (!["draft", "publish", "schedule"].includes(mode)) return res.status(400).json({ error: "Invalid publishing mode." });
    let scheduledDate = null;
    if (mode === "schedule") {
      const date = new Date(req.body.scheduledFor);
      if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 60000) return res.status(400).json({ error: "Choose a schedule time at least 60 seconds in the future." });
      scheduledDate = date.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    startProgressStream();
    sendProgress("account", 5, "Checking your connected TikTok account…");
    const me = await getLimeMe(key);
    const liveAccount = me.accounts.find(item => item.platform === "tiktok" && String(item.username || "").replace(/^@/, "").toLowerCase() === String(connection.username).toLowerCase());
    if (!liveAccount) throw new Error("The connected TikTok account is no longer available in its Lime Social workspace.");
    if (liveAccount.can_post === false) throw new Error("Lime Social reports that this TikTok account cannot currently publish. Reconnect it in Lime Social first.");

    sendProgress("upload", 15, "Uploading the selected video directly to Lime Social. No JV video processing is running.");
    const videoBlob = await fs.openAsBlob(file.path, { type: contentType });
    const form = new FormData();
    form.append("title", caption);
    form.append("accounts[0][platform]", "tiktok");
    form.append("accounts[0][username]", connection.username);
    const privacy = ({ publicToEveryone: "PUBLIC_TO_EVERYONE", mutualFollowFriends: "MUTUAL_FOLLOW_FRIENDS", selfOnly: "SELF_ONLY" })[req.body.privacyLevel] || "PUBLIC_TO_EVERYONE";
    form.append("accounts[0][privacy_level]", privacy);
    form.append("accounts[0][disable_comment]", String(req.body.allowComment !== "true"));
    form.append("accounts[0][disable_duet]", String(req.body.allowDuet !== "true"));
    form.append("accounts[0][disable_stitch]", String(req.body.allowStitch !== "true"));
    form.append("accounts[0][post_mode]", mode === "draft" ? "MEDIA_UPLOAD" : "DIRECT_POST");
    if (scheduledDate) form.append("scheduled_date", scheduledDate);
    form.append("mediaFile", videoBlob, file.originalname);
    const result = await limeRequest(key, "/v1/post", { method: "POST", body: form, signal: AbortSignal.timeout(20 * 60 * 1000) });
    const requestId = result?.data?.request_id;
    if (!requestId) throw new Error("Lime Social did not return a publishing request ID.");
    const history = {
      id: String(requestId), requestId: String(requestId), provider: "lime", keyId: key.id, keyFingerprint: keyFingerprint(key), caption,
      status: result?.data?.status || (mode === "schedule" ? "scheduled" : mode === "draft" ? "media_upload_queued" : "pending"),
      createdAt: new Date().toISOString(), scheduledFor: scheduledDate
    };
    await redis.lpush(postsKey(req.identity.uid), JSON.stringify(history));
    await redis.ltrim(postsKey(req.identity.uid), 0, 49);
    const response = { ok: true, post: history, message: "Lime Social accepted the video upload and queued the TikTok job. Final delivery is asynchronous." };
    sendProgress("complete", 100, "Lime Social accepted the TikTok publishing job.", { result: response });
    res.end();
  } catch (error) {
    if (progressStreamStarted) {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`${JSON.stringify({ type: "error", error: error.message || "Lime Social publishing failed." })}\n`);
        res.end();
      }
    } else next(error);
  } finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
});

app.get("/api/posts/:requestId/status", ensureReady, requireVerified, async (req, res, next) => {
  try {
    if (await rateLimitByUid("status", 30, 60, req, res)) return;
    const requestId = String(req.params.requestId || "");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) return res.status(400).json({ error: "Invalid publishing request ID." });
    const rawItems = await redis.lrange(postsKey(req.identity.uid), 0, 49);
    const posts = rawItems.map(item => typeof item === "string" ? JSON.parse(item) : item);
    const index = posts.findIndex(item => String(item.requestId || item.id) === requestId);
    if (index < 0) return res.status(404).json({ error: "This publishing request does not belong to your account." });
    const post = posts[index];
    const key = findConfiguredKey(post);
    if (!key) return res.status(503).json({ error: "The Lime Social key assigned to this post is not configured." });
    const status = await limeRequest(key, `/v1/status/${encodeURIComponent(requestId)}`);
    const data = status.data || status;
    post.status = data.status || post.status;
    post.statusCheckedAt = new Date().toISOString();
    post.providerResults = Array.isArray(data.results) ? data.results : [];
    posts[index] = post;
    await redis.lset(postsKey(req.identity.uid), index, JSON.stringify(post));
    res.json({ post, providerStatus: data });
  } catch (error) { next(error); }
});

app.get("/api/history", ensureReady, requireVerified, async (req, res) => {
  const items = await redis.lrange(postsKey(req.identity.uid), 0, 49);
  res.json({
    posts: items.map(item => typeof item === "string" ? JSON.parse(item) : item)
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "JV Lime Social Studio" }));

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
  console.log(`JV Lime Social server listening on ${PORT}`);
  if (missing.length) console.warn("Missing environment variables:", missing.join(", "));
});
