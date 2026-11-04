import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const POSTZEN_API_KEY = process.env.POSTZEN_API_KEY;
const MAX_VIDEO_SIZE = Math.max(1, Number(process.env.MAX_VIDEO_SIZE_MB || 500)) * 1024 * 1024;
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

if (!SUPABASE_URL || !SUPABASE_SECRET) {
  console.warn("Missing SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY.");
}
if (!POSTZEN_API_KEY) console.warn("Missing POSTZEN_API_KEY.");
const supabase = SUPABASE_URL && SUPABASE_SECRET
  ? createClient(SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_VIDEO_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/mpeg", "video/x-m4v"]);
    cb(allowed.has(file.mimetype) ? null : new Error("Unsupported video type. Use MP4, MOV, WEBM, AVI, MPEG or M4V."), allowed.has(file.mimetype));
  }
});

function requireConfig() {
  if (!supabase || !POSTZEN_API_KEY) {
    const err = new Error("Server is not configured. Add Supabase and PostZen environment variables in Render.");
    err.status = 503;
    throw err;
  }
}
async function auth(req, res, next) {
  try {
    requireConfig();
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Sign in to continue." });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Your session has expired. Sign in again." });
    req.user = data.user;
    next();
  } catch (e) { next(e); }
}
async function db(table, query) {
  const result = await query;
  if (result.error) throw new Error(`${table}: ${result.error.message}`);
  return result.data;
}
async function ensureWorkspace(user) {
  let rows = await db("app_profiles", supabase.from("app_profiles").select("*").eq("user_id", user.id).limit(1));
  if (rows?.[0]?.postzen_profile_id) return rows[0];

  if (!rows?.length) {
    rows = await db("app_profiles", supabase.from("app_profiles").insert({
      user_id: user.id,
      profile_name: (user.email || "User").split("@")[0].slice(0, 60) + " TikTok"
    }).select("*"));
  }
  const local = rows[0];
  const response = await pz("/v1/profiles", {
    method: "POST",
    body: JSON.stringify({ name: local.profile_name, description: "JV Publisher workspace" })
  });
  const profileId = response.profile?._id;
  if (!profileId) throw new Error("PostZen did not return a profile ID.");
  const updated = await db("app_profiles", supabase.from("app_profiles")
    .update({ postzen_profile_id: profileId, updated_at: new Date().toISOString() })
    .eq("user_id", user.id).select("*"));
  return updated[0];
}
async function pz(endpoint, options = {}) {
  const response = await fetch(`https://api.postzen.dev${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${POSTZEN_API_KEY}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const err = new Error(data.error || data.message || `PostZen request failed (${response.status})`);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data;
}
const safeAccount = (a) => ({
  accountId: a._id,
  profileId: typeof a.profileId === "object" ? a.profileId?._id : a.profileId,
  platform: a.platform,
  username: a.username || "",
  displayName: a.displayName || "",
  status: a.status || (a.isActive ? "connected" : "unknown"),
  connectedAt: a.connectedAt || null
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "JV PostZen Publisher" }));

app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL || "",
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "",
    configured: Boolean(SUPABASE_URL && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY) && SUPABASE_SECRET && POSTZEN_API_KEY)
  });
});

app.get("/api/me", auth, async (req, res, next) => {
  try {
    const workspace = await ensureWorkspace(req.user);
    const accounts = await pz(`/v1/accounts?profileId=${encodeURIComponent(workspace.postzen_profile_id)}`);
    const remote = (accounts.accounts || []).filter(a => a.platform === "tiktok").map(safeAccount);
    await syncAccounts(req.user.id, workspace.postzen_profile_id, remote, accounts.accounts || []);
    const { data: posts } = await supabase.from("posts").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(20);
    res.json({ user: { id: req.user.id, email: req.user.email }, workspace, accounts: remote, posts: posts || [] });
  } catch (e) { next(e); }
});

async function syncAccounts(userId, profileId, accounts, rawAccounts) {
  for (const a of accounts) {
    const raw = rawAccounts.find(x => x._id === a.accountId) || {};
    await db("connected_accounts", supabase.from("connected_accounts").upsert({
      user_id: userId, postzen_account_id: a.accountId, postzen_profile_id: profileId,
      platform: a.platform, username: a.username, display_name: a.displayName,
      status: a.status, connected_at: a.connectedAt, raw
    }, { onConflict: "postzen_account_id" }));
  }
}

app.post("/api/connect/tiktok", auth, async (req, res, next) => {
  try {
    const workspace = await ensureWorkspace(req.user);
    const redirectUrl = `${APP_URL}/?oauth=postzen`;
    const result = await pz(`/v1/connect/tiktok?profileId=${encodeURIComponent(workspace.postzen_profile_id)}&redirectUrl=${encodeURIComponent(redirectUrl)}`);
    if (!result.authUrl || !result.state) throw new Error("PostZen did not return an authorization URL and state.");
    await db("oauth_attempts", supabase.from("oauth_attempts").insert({
      state: result.state, user_id: req.user.id, postzen_profile_id: workspace.postzen_profile_id,
      platform: "tiktok", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    }));
    res.json({ authUrl: result.authUrl });
  } catch (e) { next(e); }
});

app.post("/api/connect/complete", auth, async (req, res, next) => {
  try {
    const { code, state } = req.body || {};
    if (!code || !state) return res.status(400).json({ error: "Missing OAuth code or state." });
    const attempts = await db("oauth_attempts", supabase.from("oauth_attempts").select("*")
      .eq("state", state).eq("user_id", req.user.id).gt("expires_at", new Date().toISOString()).limit(1));
    const attempt = attempts?.[0];
    if (!attempt) return res.status(400).json({ error: "OAuth state is invalid, expired, or belongs to another user. Start the connection again." });
    const completed = await pz("/v1/connect/tiktok", {
      method: "POST",
      body: JSON.stringify({ code, state, profileId: attempt.postzen_profile_id })
    });
    await db("oauth_attempts", supabase.from("oauth_attempts").delete().eq("state", state).eq("user_id", req.user.id));
    const accounts = await pz(`/v1/accounts?profileId=${encodeURIComponent(attempt.postzen_profile_id)}`);
    const filtered = (accounts.accounts || []).filter(a => a.platform === "tiktok").map(safeAccount);
    await syncAccounts(req.user.id, attempt.postzen_profile_id, filtered, accounts.accounts || []);
    res.json({ message: completed.message || "TikTok account connected.", accounts: filtered });
  } catch (e) { next(e); }
});

app.post("/api/upload", auth, upload.single("video"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: "Choose a video file." });
    const workspace = await ensureWorkspace(req.user);
    const mime = file.mimetype;
    const presign = await pz("/v1/media/presign", {
      method: "POST",
      body: JSON.stringify({ filename: file.originalname, contentType: mime })
    });
    if (!presign.uploadUrl || !presign.publicUrl) throw new Error("PostZen did not return uploadUrl and publicUrl.");
    const stream = fs.createReadStream(file.path);
    const put = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: stream,
      duplex: "half"
    });
    if (!put.ok) throw new Error(`Video upload failed (${put.status}).`);
    res.json({ publicUrl: presign.publicUrl, filename: file.originalname, size: file.size, profileId: workspace.postzen_profile_id });
  } catch (e) { next(e); }
  finally { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); }
});

app.post("/api/posts", auth, async (req, res, next) => {
  try {
    const { accountId, caption = "", mediaUrl, mode = "now", scheduledFor, privacyLevel = "publicToEveryone", allowComments = true, isAigc = false } = req.body || {};
    if (!accountId || !mediaUrl) return res.status(400).json({ error: "Select a TikTok account and upload a video first." });
    if (typeof caption !== "string" || caption.length > 2200) return res.status(400).json({ error: "TikTok captions must be 2,200 characters or fewer." });
    const workspace = await ensureWorkspace(req.user);
    const owned = await db("connected_accounts", supabase.from("connected_accounts").select("*")
      .eq("user_id", req.user.id).eq("postzen_account_id", accountId).eq("postzen_profile_id", workspace.postzen_profile_id).limit(1));
    if (!owned?.length) return res.status(403).json({ error: "That TikTok account is not connected to your user profile." });
    const platform = {
      platform: "tiktok",
      accountId,
      settings: { privacyLevel, allowComments: Boolean(allowComments), isAigc: Boolean(isAigc) }
    };
    const body = {
      content: caption,
      mediaItems: [{ url: mediaUrl }],
      platforms: [platform]
    };
    let publishMode = mode;
    if (mode === "now") body.publishNow = true;
    else if (mode === "schedule") {
      const date = new Date(scheduledFor);
      if (!scheduledFor || Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 60000) {
        return res.status(400).json({ error: "Choose a schedule time at least 60 seconds in the future." });
      }
      body.scheduledFor = date.toISOString();
    } else if (mode === "draft") {
      body.isDraft = true;
    } else return res.status(400).json({ error: "Invalid publishing mode." });

    const result = await pz("/v1/posts", { method: "POST", body: JSON.stringify(body), headers: { "x-request-id": randomBytes(16).toString("hex") } });
    const post = result.post || result.existingPost || {};
    const saved = await db("posts", supabase.from("posts").insert({
      user_id: req.user.id, postzen_post_id: post._id || null, account_id: accountId,
      platform: "tiktok", caption, status: post.status || result.message || "submitted",
      publish_mode: publishMode, scheduled_for: mode === "schedule" ? new Date(scheduledFor).toISOString() : null,
      media_url: mediaUrl, raw: result
    }).select("*"));
    res.json({ message: result.message || "Post submitted to PostZen.", post: saved?.[0] || post });
  } catch (e) { next(e); }
});

app.get("/api/posts", auth, async (req, res, next) => {
  try {
    const rows = await db("posts", supabase.from("posts").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(100));
    res.json({ posts: rows || [] });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  res.status(status).json({
    error: err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
      ? `Video exceeds the configured upload limit (${process.env.MAX_VIDEO_SIZE_MB || 500} MB).`
      : (err.message || "Unexpected server error."),
    details: process.env.NODE_ENV === "development" ? err.details : undefined
  });
});

app.listen(PORT, () => console.log(`JV PostZen Publisher listening on ${PORT}`));
