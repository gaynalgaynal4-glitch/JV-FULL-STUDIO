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
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MAX_MB = Math.max(1, Math.min(Number(process.env.MAX_VIDEO_SIZE_MB || 1024), 1024));
const MAX_BYTES = MAX_MB * 1024 * 1024;
const VOHOLABS_API = (process.env.VOHOLABS_API_URL || "https://studio.voholabs.com/api/public/v1").replace(/\/$/, "");
const VOHOLABS_API_KEY = process.env.VOHOLABS_API_KEY || "";
const VOHOLABS_OWNER_TG_UID = String(process.env.VOHOLABS_OWNER_TG_UID || "").trim();
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
// depend on Voholabs readiness or call the remote JV bot for every video upload.
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

function requireVoholabsOwner(req, res, next) {
  if (!VOHOLABS_OWNER_TG_UID || !/^[0-9]{5,20}$/.test(VOHOLABS_OWNER_TG_UID)) {
    return res.status(503).json({ error: "Set VOHOLABS_OWNER_TG_UID in Render to the Telegram UID that owns this Voholabs workspace." });
  }
  if (String(req.identity?.uid) !== VOHOLABS_OWNER_TG_UID) {
    return res.status(403).json({ error: "This Voholabs API key belongs to the workspace owner's Telegram account. Other users need their own Voholabs OAuth authorization." });
  }
  next();
}

async function voholabsRequest(pathname, options = {}) {
  if (!VOHOLABS_API_KEY) {
    const error = new Error("Voholabs is not configured. Add VOHOLABS_API_KEY to your server environment.");
    error.status = 503;
    throw error;
  }
  const headers = { Authorization: VOHOLABS_API_KEY, Accept: "application/json", ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${VOHOLABS_API}${pathname}`, { ...options, headers, signal: options.signal || AbortSignal.timeout(60000) });
  } catch (cause) {
    const error = new Error(`Could not connect to Voholabs Studio (${cause?.cause?.code || cause?.name || "network error"}).`);
    error.status = 502;
    throw error;
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: "Voholabs returned a non-JSON response." }; }
  if (!response.ok) {
    const message = data?.message || data?.error?.message || data?.error || `Voholabs returned HTTP ${response.status}.`;
    const error = new Error(typeof message === "string" ? message : `Voholabs returned HTTP ${response.status}.`);
    error.status = response.status;
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

app.get("/api/config", (_req, res) => {
  res.json({
    ready: missing.length === 0 && Boolean(redis),
    missing,
    maxVideoSizeMB: MAX_MB,
    voholabsConfigured: Boolean(VOHOLABS_API_KEY),
    voholabsOwnerConfigured: Boolean(VOHOLABS_OWNER_TG_UID),
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

// All social-channel operations now use the Voholabs Studio workspace.
function unwrapArray(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  if (payload?.data) return unwrapArray(payload.data, keys);
  return [];
}
function channelProvider(channel) {
  return String(channel?.providerIdentifier || channel?.identifier || channel?.provider || channel?.platform || "").toLowerCase();
}
function isTikTokChannel(channel) {
  const provider = channelProvider(channel);
  return provider === "tiktok" || provider.startsWith("tiktok-") || String(channel?.name || "").toLowerCase().includes("tiktok");
}
function extractConnectAddress(payload) {
  const candidates = [payload?.url, payload?.address, payload?.connectUrl, payload?.connect_url, payload?.redirectUrl, payload?.redirect_url, payload?.data?.url, payload?.data?.address, payload?.data?.connectUrl, payload?.data?.connect_url];
  return candidates.find(value => typeof value === "string" && value.trim()) || null;
}

// Voholabs returns a hosted connection URL, which can send the user onward to
// TikTok's own OAuth consent page. Allow only HTTPS URLs on Voholabs or TikTok.
// Never allow an arbitrary host supplied by an upstream API response.
function isAllowedTikTokAuthorizationUrl(value) {
  try {
    const parsed = new URL(value);
    const allowedHosts = new Set([
      "studio.voholabs.com",
      "voholabs.com",
      "www.tiktok.com",
      "tiktok.com"
    ]);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password &&
      (!parsed.port || parsed.port === "443") && allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

app.get("/api/connections/capacity", ensureReady, requireVerified, requireVoholabsOwner, async (_req, res, next) => {
  try {
    const payload = await voholabsRequest("/integrations");
    const channels = unwrapArray(payload, ["integrations", "channels", "items", "results"]);
    const tiktok = channels.filter(isTikTokChannel);
    res.json({ totalCapacity: "Unlimited by Voholabs", connected: tiktok.length, availableSlots: "—", providerKeysAvailable: true, acceptingConnections: true, provider: "Voholabs Studio" });
  } catch (error) { next(error); }
});

app.post("/api/connect/tiktok", ensureReady, requireVerified, requireVoholabsOwner, async (_req, res, next) => {
  try {
    if (await rateLimitByUid("voholabs-connect", 5, 300, _req, res)) return;
    const result = await voholabsRequest("/social/tiktok");
    const connectUrl = extractConnectAddress(result);
    if (!connectUrl) {
      console.error("Voholabs /social/tiktok returned an unexpected response shape:", JSON.stringify(result).slice(0, 700));
      return res.status(502).json({ error: "Voholabs did not return a TikTok authorization URL. Check that TikTok is available in your Voholabs workspace." });
    }
    if (!isAllowedTikTokAuthorizationUrl(connectUrl)) {
      let returnedHost = "invalid URL";
      try { returnedHost = new URL(connectUrl).hostname; } catch {}
      console.error("Blocked unexpected Voholabs TikTok authorization host:", returnedHost);
      return res.status(502).json({ error: "Voholabs returned an unsupported TikTok authorization address. Check the Voholabs connection response." });
    }
    res.json({ connectUrl: new URL(connectUrl).toString() });
  } catch (error) { next(error); }
});

app.get("/api/accounts", ensureReady, requireVerified, requireVoholabsOwner, async (_req, res, next) => {
  try {
    const payload = await voholabsRequest("/integrations");
    const channels = unwrapArray(payload, ["integrations", "channels", "items", "results"]);
    const accounts = channels.filter(isTikTokChannel).map(channel => ({
      id: String(channel.id || channel._id || ""),
      platform: "tiktok",
      username: channel.username || channel.handle || channel.name || "TikTok account",
      displayName: channel.name || channel.displayName || channel.username || "TikTok account",
      avatarUrl: channel.picture || channel.avatar || channel.avatarUrl || null,
      canPost: channel.disabled !== true && channel.connected !== false,
      providerIdentifier: channelProvider(channel)
    })).filter(channel => channel.id);
    res.json({ accounts, workspace: "Voholabs Studio" });
  } catch (error) { next(error); }
});

app.delete("/api/accounts/:accountId", ensureReady, requireVerified, requireVoholabsOwner, async (req, res, next) => {
  try {
    if (await rateLimitByUid("voholabs-disconnect", 10, 300, req, res)) return;
    const id = String(req.params.accountId || "");
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(id)) return res.status(400).json({ error: "Invalid Voholabs channel ID." });
    await voholabsRequest(`/integrations/${encodeURIComponent(id)}`, { method: "DELETE" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_")}`)
  }),
  limits: { fileSize: MAX_BYTES, files: 1 }
});

// Voholabs Studio public API proxy. The API key remains server-side; the browser
// only receives data returned by these authenticated, Telegram-verified routes.
app.get("/api/voholabs/status", ensureReady, requireVerified, requireVoholabsOwner, async (_req, res, next) => {
  try { res.json(await voholabsRequest("/is-connected")); } catch (error) { next(error); }
});

app.get("/api/voholabs/channels", ensureReady, requireVerified, requireVoholabsOwner, async (req, res, next) => {
  try {
    res.json(await voholabsRequest("/integrations"));
  } catch (error) { next(error); }
});

app.get("/api/voholabs/connect/:network", ensureReady, requireVerified, requireVoholabsOwner, async (req, res, next) => {
  try {
    const network = String(req.params.network || "").toLowerCase();
    if (!/^[a-z0-9-]{2,32}$/.test(network)) return res.status(400).json({ error: "Invalid social network." });
    const result = await voholabsRequest(`/social/${encodeURIComponent(network)}`);
    const connectUrl = result?.url || result?.address || result?.connectUrl || result?.data?.url || result?.data?.address;
    if (!connectUrl || typeof connectUrl !== "string") return res.status(502).json({ error: "Voholabs did not return a channel connection address." });
    if (!isAllowedTikTokAuthorizationUrl(connectUrl)) {
      let returnedHost = "invalid URL";
      try { returnedHost = new URL(connectUrl).hostname; } catch {}
      console.error("Blocked unexpected Voholabs authorization host:", returnedHost);
      return res.status(502).json({ error: "Voholabs returned an unsupported authorization address." });
    }
    res.json({ connectUrl: new URL(connectUrl).toString() });
  } catch (error) { next(error); }
});

app.post("/api/voholabs/upload", ensureReady, requireVerified, requireVoholabsOwner, upload.single("file"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Choose a media file first." });
    const form = new FormData();
    form.append("file", await fs.openAsBlob(file.path, { type: file.mimetype || "application/octet-stream" }), file.originalname);
    res.json(await voholabsRequest("/upload", { method: "POST", body: form, signal: AbortSignal.timeout(20 * 60 * 1000) }));
  } catch (error) { next(error); }
  finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
});

app.get("/api/voholabs/posts", ensureReady, requireVerified, requireVoholabsOwner, async (req, res, next) => {
  try {
    const query = new URLSearchParams();
    for (const name of ["startDate", "endDate"]) if (req.query[name]) query.set(name, String(req.query[name]));
    query.set("customer", String(req.identity.uid));
    res.json(await voholabsRequest(`/posts?${query.toString()}`));
  } catch (error) { next(error); }
});

app.post("/api/voholabs/posts", ensureReady, requireVerified, requireVoholabsOwner, async (req, res, next) => {
  try {
    if (await rateLimitByUid("voholabs-post", 20, 3600, req, res)) return;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "A valid Voholabs post payload is required." });
    res.json(await voholabsRequest("/posts", { method: "POST", body: JSON.stringify(req.body) }));
  } catch (error) { next(error); }
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

app.post("/api/posts", ensureReady, requireVerified, requireVoholabsOwner, upload.single("video"), async (req, res, next) => {
  const file = req.file;
  try {
    if (await rateLimitByUid("voholabs-post", 10, 3600, req, res)) return;
    if (!file) return res.status(400).json({ error: "Choose a video file first." });
    if (req.body.musicRights !== "true" || req.body.videoRights !== "true") return res.status(400).json({ error: "Confirm that you have rights to the music and video first." });
    const accountId = String(req.body.accountId || "");
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(accountId)) return res.status(400).json({ error: "Select a valid Voholabs TikTok channel." });
    const channelsPayload = await voholabsRequest("/integrations");
    const channels = unwrapArray(channelsPayload, ["integrations", "channels", "items", "results"]);
    const channel = channels.find(item => String(item.id || item._id || "") === accountId && isTikTokChannel(item));
    if (!channel) return res.status(403).json({ error: "That TikTok channel is not connected to the configured Voholabs workspace." });
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".mp4") return res.status(400).json({ error: "Voholabs TikTok video publishing requires an MP4 file." });
    if (file.size > 1024 * 1024 * 1024) return res.status(413).json({ error: "Voholabs accepts MP4 videos up to 1 GB." });
    const mode = String(req.body.mode || "publish");
    if (!["draft", "publish", "schedule"].includes(mode)) return res.status(400).json({ error: "Invalid publishing mode." });
    const caption = String(req.body.caption || "").trim().slice(0, 2000);
    if (!caption) return res.status(400).json({ error: "Enter a TikTok caption before publishing." });
    let scheduledDate = new Date().toISOString();
    if (mode === "schedule") {
      const date = new Date(req.body.scheduledFor);
      if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 60000) return res.status(400).json({ error: "Choose a schedule time at least 60 seconds in the future." });
      scheduledDate = date.toISOString();
    }

    const videoBlob = await fs.openAsBlob(file.path, { type: file.mimetype || "video/mp4" });
    const uploadForm = new FormData();
    uploadForm.append("file", videoBlob, file.originalname || "video.mp4");
    const uploaded = await voholabsRequest("/upload", { method: "POST", body: uploadForm, signal: AbortSignal.timeout(20 * 60 * 1000) });
    const media = uploaded?.media || uploaded?.file || uploaded?.data?.media || uploaded?.data?.file || uploaded?.data || uploaded;
    const mediaId = media?.id || media?._id || uploaded?.id || uploaded?.data?.id;
    const mediaPath = media?.path || media?.url || uploaded?.path || uploaded?.url || uploaded?.data?.path || uploaded?.data?.url;
    if (!mediaId || !mediaPath) {
      console.error("Voholabs upload response did not contain media id/path:", JSON.stringify(uploaded).slice(0, 900));
      return res.status(502).json({ error: "Voholabs accepted the upload but returned no usable media ID/path. Check the server log for the response shape." });
    }

    const privacy = ({ publicToEveryone: "PUBLIC_TO_EVERYONE", mutualFollowFriends: "MUTUAL_FOLLOW_FRIENDS", selfOnly: "SELF_ONLY" })[req.body.privacyLevel] || "PUBLIC_TO_EVERYONE";
    const uploadToInbox = mode === "draft";
    const settings = {
      __type: channelProvider(channel) || "tiktok",
      content_posting_method: uploadToInbox ? "UPLOAD" : "DIRECT_POST",
      duet: req.body.allowDuet === "true",
      stitch: req.body.allowStitch === "true",
      comment: req.body.allowComment === "true",
      autoAddMusic: "no",
      brand_organic_toggle: false,
      brand_content_toggle: false
    };
    if (!uploadToInbox) settings.privacy_level = privacy;
    const postPayload = {
      type: mode === "schedule" ? "schedule" : "now",
      date: scheduledDate,
      shortLink: false,
      tags: [],
      posts: [{
        integration: { id: accountId },
        value: [{ content: caption, video: [{ id: String(mediaId), path: String(mediaPath) }] }],
        settings
      }]
    };
    const created = await voholabsRequest("/posts", { method: "POST", body: JSON.stringify(postPayload), signal: AbortSignal.timeout(120000) });
    const history = { id: String(created?.id || created?.post?.id || created?.data?.id || crypto.randomUUID()), provider: "voholabs", channelId: accountId, channelName: channel.name || channel.username || "TikTok", caption, status: mode === "schedule" ? "scheduled" : uploadToInbox ? "sent_to_tiktok_inbox" : "submitted", createdAt: new Date().toISOString(), scheduledFor: mode === "schedule" ? scheduledDate : null, response: created };
    await redis.lpush(postsKey(req.identity.uid), JSON.stringify(history));
    await redis.ltrim(postsKey(req.identity.uid), 0, 49);
    res.json({ ok: true, post: history, message: mode === "draft" ? "Video sent to your TikTok inbox. Finish and publish it in the TikTok app." : mode === "schedule" ? "Video scheduled through Voholabs Studio." : "Video submitted to Voholabs Studio for TikTok publishing." });
  } catch (error) { next(error); }
  finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
});

app.get("/api/history", ensureReady, requireVerified, async (req, res) => {
  const items = await redis.lrange(postsKey(req.identity.uid), 0, 49);
  res.json({
    posts: items.map(item => typeof item === "string" ? JSON.parse(item) : item)
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "JV Studio · Voholabs" }));

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
  console.log(`JV Studio server listening on ${PORT}`);
  if (missing.length) console.warn("Missing environment variables:", missing.join(", "));
});
