const $ = id => document.getElementById(id);

const STORAGE_UID = "jv_video_lab_telegram_uid_v1";
const STORAGE_BROWSER_TOKEN = "jv_video_lab_browser_token_v1";
const STORAGE_SESSION = "jv_postzen_session_v1";

let config = null;
let identity = null;
let sessionToken = null;
let accounts = [];
let selectedMethod = localStorage.getItem("jv_postzen_processing_method_v1") || "local";
let hdReencode = localStorage.getItem("jv_postzen_hd_reencode_v1") !== "false";
if (!Object.prototype.hasOwnProperty.call({ enhanced:1, hd:1, local:1, ffmpeg:1, upload:1 }, selectedMethod)) selectedMethod = "local";
let videoLabReady = false;
let videoLabReadyPromise = null;
let activeVideoLabJob = null;
const METHOD_LABELS = { enhanced: "ENHANCED METHOD", hd: "HD METHOD", local: "LOCAL METHOD", ffmpeg: "FFMPEG METHOD", upload: "ONLY UPLOAD" };

function browserToken() {
  let token = localStorage.getItem(STORAGE_BROWSER_TOKEN);
  if (!token) {
    if (!crypto?.getRandomValues) throw new Error("Secure browser randomness is unavailable. Open this site over HTTPS in a modern browser.");
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(STORAGE_BROWSER_TOKEN, token);
  }
  return token;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (identity?.uid) headers.set("X-JV-Telegram-UID", identity.uid);
  if (identity?.browserToken) headers.set("X-JV-Browser-Token", identity.browserToken);
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.reason ? ` (${data.reason})` : "";
    throw new Error((data.error || `Request failed (${response.status})`) + reason);
  }
  if (data.sessionToken) {
    sessionToken = data.sessionToken;
    localStorage.setItem(STORAGE_SESSION, sessionToken);
  }
  return data;
}

function notice(el, message, error = false) {
  el.textContent = message;
  el.classList.remove("hidden", "error");
  if (error) el.classList.add("error");
}
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3200);
}
function setProfileDisplay(profile = {}) {
  const name = profile.displayName || profile.first_name || profile.username || "Telegram account";
  $("telegramDisplayName").textContent = name;
  const avatar = $("telegramAvatar");
  const photo = profile.photoUrl || profile.photo_url || profile.avatarUrl || profile.avatar_url || profile.photo || profile.avatar;
  if (typeof photo === "string" && (photo.startsWith("/") || /^https:\/\//i.test(photo))) {
    avatar.classList.add("has-photo");
    const headers = new Headers();
    if (identity?.uid) headers.set("X-JV-Telegram-UID", identity.uid);
    if (identity?.browserToken) headers.set("X-JV-Browser-Token", identity.browserToken);
    if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
    fetch(photo, { headers, credentials: "same-origin" })
      .then(response => {
        if (!response.ok) throw new Error("Profile photo unavailable");
        return response.blob();
      })
      .then(blob => {
        if (avatar.dataset.photoObjectUrl) URL.revokeObjectURL(avatar.dataset.photoObjectUrl);
        const objectUrl = URL.createObjectURL(blob);
        avatar.dataset.photoObjectUrl = objectUrl;
        avatar.src = objectUrl;
      })
      .catch(() => {
        avatar.removeAttribute("src");
        avatar.classList.remove("has-photo");
        avatar.alt = "Telegram profile photo unavailable";
      });
  } else {
    avatar.removeAttribute("src");
    avatar.classList.remove("has-photo");
    avatar.alt = "Telegram profile photo unavailable";
  }
}
function showDashboard() {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
  $("methodSettingsBtn").classList.remove("hidden");
  updateMethodUI();
  $("userId").textContent = `Telegram UID · ${identity.uid}`;
  loadAccounts();
  loadHistory();
}
function showLogin() {
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("logoutBtn").classList.add("hidden");
}

async function verifyUID(uid, silent = false) {
  if (!/^[0-9]{5,20}$/.test(uid)) {
    notice($("loginMessage"), "Enter a valid numeric Telegram UID.", true);
    return false;
  }
  const button = $("verifyBtn");
  button.disabled = true;
  button.textContent = "Checking JV membership…";
  if (!silent) notice($("loginMessage"), "Contacting your existing JV verification server…");
  identity = { uid, browserToken: browserToken() };
  sessionToken = null;
  try {
    const result = await api("/api/auth/verify", { method: "POST" });
    localStorage.setItem(STORAGE_UID, uid);
    if (result.sessionToken) sessionToken = result.sessionToken;
    setProfileDisplay(result.telegramProfile || {});
    $("loginMessage").classList.add("hidden");
    showDashboard();
    return true;
  } catch (error) {
    if (error.message.includes("session_taken")) {
      notice($("loginMessage"), "This UID is linked to another browser. Use Reset Extension in your existing JV bot, then verify again here.", true);
    } else if (error.message.includes("not_member")) {
      notice($("loginMessage"), "Channel membership was not found. Join the JV channel, then try again.", true);
    } else if (error.message.includes("blocked")) {
      notice($("loginMessage"), "This Telegram account is blocked from using the service.", true);
    } else {
      notice($("loginMessage"), error.message, true);
    }
    return false;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Verify &amp; unlock <span>→</span>';
  }
}

async function refreshAuth() {
  const savedUID = localStorage.getItem(STORAGE_UID);
  if (!savedUID) return;
  $("tgUidInput").value = savedUID;
  identity = { uid: savedUID, browserToken: browserToken() };
  sessionToken = localStorage.getItem(STORAGE_SESSION);
  try {
    const me = await api("/api/me");
    setProfileDisplay(me.telegramProfile || {});
    showDashboard();
  } catch {
    sessionToken = null;
    localStorage.removeItem(STORAGE_SESSION);
    showLogin();
    notice($("loginMessage"), "Your saved JV verification needs to be checked again. Press Verify to continue.", true);
  }
}

async function loadAccounts() {
  try {
    const data = await api("/api/accounts");
    accounts = data.accounts || [];
    const list = $("accountsList");
    const select = $("accountSelect");
    list.innerHTML = "";
    select.innerHTML = "";
    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state">No TikTok accounts connected yet. Select “Connect TikTok” to get started.</div>';
      select.innerHTML = '<option value="">Connect an account first</option>';
      return;
    }
    for (const account of accounts) {
      const id = account._id || account.id;
      const name = account.displayName || account.username || "TikTok account";
      const handle = account.username ? `@${account.username}` : "TikTok";
      const item = document.createElement("div");
      item.className = "account-item";
      const avatarUrl = account.avatarUrl || account.avatar_url || account.profilePictureUrl || account.profile_picture_url || account.avatar || account.picture;
      item.innerHTML = '<div class="account-left"><img class="account-avatar" alt="TikTok profile photo"><div><b></b><small></small></div></div><div class="account-actions"><span class="history-status">Connected</span><button class="button danger disconnect-account" type="button">Disconnect</button></div>';
      const avatar = item.querySelector(".account-avatar");
      if (typeof avatarUrl === "string" && /^https:\/\//i.test(avatarUrl)) avatar.src = avatarUrl;
      else avatar.classList.add("avatar-fallback");
      item.querySelector("b").textContent = name;
      item.querySelector("small").textContent = handle;
      item.querySelector(".disconnect-account").addEventListener("click", async () => {
        if (!window.confirm(`Disconnect ${name} from this JV workspace?`)) return;
        const button = item.querySelector(".disconnect-account");
        button.disabled = true;
        button.textContent = "Disconnecting…";
        try {
          await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
          toast("TikTok account disconnected.");
          await loadAccounts();
        } catch (error) {
          toast(error.message);
          button.disabled = false;
          button.textContent = "Disconnect";
        }
      });
      list.appendChild(item);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = `${name} (${handle})`;
      select.appendChild(option);
    }
  } catch (error) {
    $("accountsList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}
async function loadHistory() {
  try {
    const data = await api("/api/history");
    const list = $("historyList");
    list.innerHTML = "";
    if (!data.posts?.length) {
      list.innerHTML = '<div class="empty-state">Your submitted posts will appear here.</div>';
      return;
    }
    for (const post of data.posts) {
      const item = document.createElement("div");
      item.className = "history-item";
      const left = document.createElement("div");
      const title = document.createElement("b");
      title.textContent = post.caption || "TikTok video";
      const small = document.createElement("small");
      small.textContent = new Date(post.createdAt).toLocaleString();
      left.append(title, small);
      const status = document.createElement("span");
      status.className = "history-status";
      status.textContent = String(post.status || "submitted").replaceAll("_", " ");
      item.append(left, status);
      list.appendChild(item);
    }
  } catch (error) {
    $("historyList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function updateMethodUI() {
  const label = METHOD_LABELS[selectedMethod] || METHOD_LABELS.local;
  $("selectedMethodTag").textContent = label;
  document.querySelectorAll(".method-choice").forEach(button => button.classList.toggle("selected", button.dataset.method === selectedMethod));
  const hdOptions = $("hdOptions");
  if (hdOptions) hdOptions.classList.toggle("hidden", selectedMethod !== "hd");
  const hdToggle = $("hdReencodeToggle");
  if (hdToggle) hdToggle.checked = hdReencode;
  const hdState = $("hdReencodeState");
  if (hdState) hdState.textContent = hdReencode ? "ON" : "OFF";
}
function showWorkflow(message, percent = 0, stage = "", indeterminate = false) {
  $("workflowProgress").classList.remove("hidden");
  $("workflowStatus").textContent = message;
  $("workflowPercent").textContent = indeterminate ? "Working" : `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  const fill = $("workflowProgressBar");
  fill.classList.toggle("indeterminate", indeterminate);
  fill.style.width = indeterminate ? "100%" : `${Math.max(0, Math.min(100, percent))}%`;
  $("workflowStage").textContent = stage;
}
function hideWorkflow() { $("workflowProgress").classList.add("hidden"); }
function waitForVideoLab() {
  if (videoLabReady) return Promise.resolve();
  if (!videoLabReadyPromise) videoLabReadyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Video Lab processor did not load. Refresh the page and try again.")), 20000);
    window.__jvVideoLabReady = () => { clearTimeout(timer); videoLabReady = true; resolve(); };
  });
  return videoLabReadyPromise;
}
function processInVideoLab(file, method) {
  return new Promise(async (resolve, reject) => {
    try {
      await waitForVideoLab();
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => { if (activeVideoLabJob?.requestId === requestId) { activeVideoLabJob = null; reject(new Error("Video processing timed out. Check the selected method server and try again.")); } }, 30 * 60 * 1000);
      activeVideoLabJob = { requestId, resolve: value => { clearTimeout(timeout); activeVideoLabJob = null; resolve(value); }, reject: error => { clearTimeout(timeout); activeVideoLabJob = null; reject(error); } };
      $("videoLabFrame").contentWindow.postMessage({ type: "JV_VIDEO_LAB_PROCESS", requestId, method, file, hdReencode }, location.origin);
    } catch (error) { reject(error); }
  });
}
function uploadPostWithProgress(form, onProgress, onServerProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0, pending = "", finalResult = null, serverError = null;
    const parseProgress = (flush = false) => {
      const fresh = xhr.responseText.slice(consumed);
      consumed = xhr.responseText.length;
      pending += fresh;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      if (flush && pending.trim()) { lines.push(pending); pending = ""; }
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        let item; try { item = JSON.parse(line); } catch { continue; }
        if (item.type === "progress") {
          onServerProgress?.(item);
          // The server's final event may be encoded as a progress event with
          // stage="complete" and the accepted post result attached.
          if (item.stage === "complete" && (item.result || item.ok === true || item.post || item.existingPost)) {
            finalResult = item.result || item;
          }
        } else if (item.type === "complete") {
          finalResult = item.result || { ok: true, message: item.message };
        } else if (item.type === "error" || item.error) {
          serverError = item.error || "TikTok publishing failed.";
        }
        // Also accept a normal JSON success response if a host/proxy buffers
        // or normalizes the NDJSON stream.
        else if (item.ok === true || item.post || item.existingPost) finalResult = item.result || item;
      }
    };
    xhr.open("POST", "/api/posts", true);
    if (identity?.uid) xhr.setRequestHeader("X-JV-Telegram-UID", identity.uid);
    if (identity?.browserToken) xhr.setRequestHeader("X-JV-Browser-Token", identity.browserToken);
    if (sessionToken) xhr.setRequestHeader("Authorization", `Bearer ${sessionToken}`);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.upload.onload = () => onServerProgress?.({ type:"progress", stage:"server_receive", percent:0, message:"Processed video received by JV TikTok. Preparing media storage…" });
    xhr.onprogress = () => parseProgress();
    xhr.onload = () => {
      parseProgress(true);
      if (xhr.status >= 200 && xhr.status < 300 && !serverError && finalResult) resolve(finalResult);
      else if (serverError) reject(new Error(serverError));
      else {
        let data = {}; try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
        const contentType = xhr.getResponseHeader("content-type") || "unknown content type";
        const bodyHint = (xhr.responseText || "").trim().slice(0, 240);
        reject(new Error(data.error || (xhr.status >= 200 && xhr.status < 300
          ? `TikTok returned HTTP ${xhr.status}, but no completion event was received (${contentType}). ${bodyHint || "The response body was empty."}`
          : `TikTok upload failed (HTTP ${xhr.status}). ${bodyHint}`)));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading the processed video to TikTok."));
    xhr.onabort = () => reject(new Error("TikTok upload was cancelled."));
    xhr.send(form);
  });
}

window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.source !== $("videoLabFrame").contentWindow) return;
  const data = event.data || {};
  if (data.type === "JV_VIDEO_LAB_READY") { videoLabReady = true; window.__jvVideoLabReady?.(); return; }
  if (!activeVideoLabJob || data.requestId !== activeVideoLabJob.requestId) return;
  if (data.type === "JV_VIDEO_LAB_PROGRESS") {
    showWorkflow(data.message || "Processing video…", data.progress ?? 0, data.stage || "Selected method is running in JV Video Lab.", data.indeterminate === true);
  } else if (data.type === "JV_VIDEO_LAB_RESULT") {
    activeVideoLabJob.resolve({ blob: data.blob, fileName: data.fileName || "processed-video.mp4" });
  } else if (data.type === "JV_VIDEO_LAB_ERROR") {
    activeVideoLabJob.reject(new Error(data.error || "The selected video processing method failed."));
  }
});
const videoLabFrame = $("videoLabFrame");
videoLabFrame.addEventListener("load", () => videoLabFrame.contentWindow?.postMessage({ type: "JV_VIDEO_LAB_PING" }, location.origin));
videoLabFrame.contentWindow?.postMessage({ type: "JV_VIDEO_LAB_PING" }, location.origin);
function setMethodModalOpen(open) {
  const modal = $("methodModal");
  modal.classList.toggle("hidden", !open);
  document.body.classList.toggle("method-modal-open", open);
  if (open) {
    updateMethodUI();
    requestAnimationFrame(() => $("closeMethodModal").focus());
  } else {
    $("methodSettingsBtn").focus();
  }
}
$("methodSettingsBtn").addEventListener("click", () => setMethodModalOpen(true));
$("closeMethodModal").addEventListener("click", () => setMethodModalOpen(false));
$("methodModal").addEventListener("click", event => { if (event.target === $("methodModal")) setMethodModalOpen(false); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("methodModal").classList.contains("hidden")) setMethodModalOpen(false);
});
document.querySelectorAll(".method-choice").forEach(button => button.addEventListener("click", () => {
  selectedMethod = button.dataset.method;
  localStorage.setItem("jv_postzen_processing_method_v1", selectedMethod);
  updateMethodUI();
  if (selectedMethod !== "hd") {
    setMethodModalOpen(false);
    toast(`${METHOD_LABELS[selectedMethod]} selected`);
  }
}));
$("hdReencodeToggle").addEventListener("change", event => {
  hdReencode = Boolean(event.target.checked);
  localStorage.setItem("jv_postzen_hd_reencode_v1", String(hdReencode));
  updateMethodUI();
});
$("confirmHdMethod").addEventListener("click", () => {
  setMethodModalOpen(false);
  toast(`HD METHOD selected · Re-encoding ${hdReencode ? "ON" : "OFF"}`);
});

$("verifyBtn").addEventListener("click", () => verifyUID($("tgUidInput").value.trim()));
$("tgUidInput").addEventListener("keydown", event => {
  if (event.key === "Enter") verifyUID($("tgUidInput").value.trim());
});
$("connectBtn").addEventListener("click", async () => {
  const button = $("connectBtn");
  button.disabled = true;
  button.textContent = "Opening TikTok…";
  try {
    const result = await api("/api/connect/tiktok", { method: "POST" });
    location.href = result.authUrl;
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "＋ Connect TikTok";
  }
});
function refreshPostMode() {
  const mode = $("mode").value;
  $("scheduleWrap").classList.toggle("hidden", mode !== "schedule");
  $("publishForm").classList.toggle("is-draft", mode === "draft");
  $("draftNote").classList.toggle("hidden", mode !== "draft");
  $("publishBtn").firstChild.nodeValue = (mode === "draft" ? "Upload & save draft" : mode === "schedule" ? "Upload & schedule" : "Upload & post to TikTok") + " ";
}
$("mode").addEventListener("change", refreshPostMode);
refreshPostMode();
$("caption").addEventListener("input", () => $("captionCount").textContent = $("caption").value.length);

let previewObjectUrl = null;
let previewLoadId = 0;
let coverDuration = 0;
let browserCoverFrames = [];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
function drawCoverFrame(video, canvas) {
  if (!video.videoWidth || !video.videoHeight) return false;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#05080e"; ctx.fillRect(0, 0, w, h);
  const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
  const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return true;
}
function seekVideo(video, time, id) {
  return new Promise(resolve => {
    if (id !== previewLoadId) return resolve(false);
    const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.08)));
    if (Math.abs(video.currentTime - target) < 0.04 && video.readyState >= 2) return resolve(true);
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve(ok && id === previewLoadId);
    };
    const onSeeked = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), 2500);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    try { video.currentTime = target; } catch { finish(false); }
  });
}
function paintBrowserCover(frame) {
  if (!frame?.dataUrl) return;
  const canvas = $("coverCanvas"), ctx = canvas.getContext("2d");
  const image = new Image();
  image.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); };
  image.src = frame.dataUrl;
}
function selectBrowserCover(index, id = previewLoadId) {
  if (id !== previewLoadId || !browserCoverFrames.length) return;
  const frame = browserCoverFrames[Math.max(0, Math.min(browserCoverFrames.length - 1, index))];
  $("coverTime").value = String(frame.time);
  $("coverTimeLabel").textContent = `${frame.time.toFixed(1)}s`;
  $("coverThumbnails").querySelectorAll(".cover-thumb").forEach((el, i) => el.classList.toggle("active", i === index));
  paintBrowserCover(frame);
}
async function inspectVideoInBrowser(file, id) {
  const video = $("selectedVideoPreview");
  const metadataReady = () => new Promise((resolve, reject) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration)) return resolve();
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("This browser cannot read the selected video's metadata.")); };
    const cleanup = () => { video.removeEventListener("loadedmetadata", done); video.removeEventListener("error", fail); };
    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
  await metadataReady();
  if (id !== previewLoadId) return;
  coverDuration = Number.isFinite(video.duration) ? video.duration : 0;
  $("videoResolution").textContent = video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : "Unavailable";
  $("videoDuration").textContent = formatDuration(coverDuration);
  // HTML video metadata does not expose exact average FPS or stream bitrate.
  // Do not guess these values; WebCodecs also requires a container demuxer.
  $("videoFps").textContent = "Not exposed by browser";
  $("videoBitrate").textContent = "Not exposed by browser";
  $("coverTime").max = String(Math.max(0, coverDuration));
  $("coverTimeLabel").textContent = "Creating previews…";
  browserCoverFrames = [];
  const holder = $("coverThumbnails"); holder.replaceChildren();
  const times = coverDuration > 0 ? [0, .25, .5, .75, .95].map(f => Math.max(0, Math.min(coverDuration - .08, coverDuration * f))) : [0];
  const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 270;
  for (const time of times) {
    if (id !== previewLoadId) return;
    const ok = await seekVideo(video, time, id);
    if (!ok || !drawCoverFrame(video, canvas)) continue;
    const dataUrl = canvas.toDataURL("image/jpeg", .82);
    const frame = { time, dataUrl };
    browserCoverFrames.push(frame);
    const button = document.createElement("button");
    button.type = "button"; button.className = "cover-thumb";
    button.setAttribute("aria-label", `Select cover at ${time.toFixed(1)} seconds`);
    const image = document.createElement("img"); image.src = dataUrl; image.alt = `Video frame at ${time.toFixed(1)} seconds`;
    button.append(image);
    const index = browserCoverFrames.length - 1;
    button.addEventListener("click", () => selectBrowserCover(index, id));
    holder.append(button);
  }
  if (id !== previewLoadId) return;
  if (browserCoverFrames.length) selectBrowserCover(0, id);
  else $("coverTimeLabel").textContent = "Preview frames unavailable";
  // Restore playback position after thumbnail extraction.
  try { video.currentTime = 0; } catch {}
}
function clearVideoPreview() {
  previewLoadId++;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  $("videoPreviewPanel").classList.add("hidden");
  $("dropzone")?.classList.remove("hidden");
  $("fileName").textContent = "Choose a video";
  $("coverThumbnails").replaceChildren();
  browserCoverFrames = [];
  $("selectedVideoPreview").removeAttribute("src");
  $("selectedVideoPreview").load();
}
$("videoFile").addEventListener("change", async () => {
  const file = $("videoFile").files[0];
  if (!file) { clearVideoPreview(); return; }
  if (!file.type.startsWith("video/")) {
    toast("Please select a video file.");
    $("videoFile").value = "";
    clearVideoPreview();
    return;
  }
  const id = ++previewLoadId;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = URL.createObjectURL(file);
  $("dropzone")?.classList.add("hidden");
  $("videoPreviewPanel").classList.remove("hidden");
  $("fileName").textContent = file.name;
  $("previewFileName").textContent = file.name;
  $("previewFileSize").textContent = formatBytes(file.size);
  $("videoResolution").textContent = "Reading…";
  $("videoFps").textContent = "—";
  $("videoDuration").textContent = "Reading…";
  $("videoBitrate").textContent = "—";
  const video = $("selectedVideoPreview");
  video.src = previewObjectUrl;
  video.load();
  inspectVideoInBrowser(file, id).catch(error => {
    if (id !== previewLoadId) return;
    const reason = error.message || "Browser inspection failed.";
    $("videoResolution").textContent = "Unavailable";
    $("videoFps").textContent = "Not exposed by browser";
    $("videoDuration").textContent = "Unavailable";
    $("videoBitrate").textContent = "Not exposed by browser";
    $("coverTimeLabel").textContent = "Preview unavailable";
    toast(`Video preview: ${reason}`);
  });
});
$("coverTime").addEventListener("input", event => {
  if (!browserCoverFrames.length) return;
  const target = Number(event.target.value);
  let nearest = 0;
  for (let i = 1; i < browserCoverFrames.length; i++) {
    if (Math.abs(browserCoverFrames[i].time - target) < Math.abs(browserCoverFrames[nearest].time - target)) nearest = i;
  }
  selectBrowserCover(nearest);
});
{
  const dz = document.querySelector(".dropzone");
  ["dragenter", "dragover"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => {
    if (!e.dataTransfer.files.length) return;
    $("videoFile").files = e.dataTransfer.files;
    $("videoFile").dispatchEvent(new Event("change"));
  });
}
$("publishForm").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("videoFile").files[0];
  if (!file) return notice($("publishMessage"), "Choose a video file.", true);
  if (!file.type.startsWith("video/")) return notice($("publishMessage"), "Please select a video file.", true);
  const extension = file.name.split(".").pop().toLowerCase();
  const supportedForMethod = selectedMethod === "ffmpeg" || selectedMethod === "upload" ? ["mp4", "mov", "m4v", "webm", "avi", "mpeg", "mpg"] : ["mp4"];
  if (!supportedForMethod.includes(extension)) return notice($("publishMessage"), `${METHOD_LABELS[selectedMethod]} supports ${supportedForMethod.join(", ").toUpperCase()} files only.`, true);
  if (file.size > config.maxVideoSizeMB * 1024 * 1024) return notice($("publishMessage"), `The video is larger than ${config.maxVideoSizeMB} MB.`, true);
  if (!$("accountSelect").value) return notice($("publishMessage"), "Connect and select a TikTok account first.", true);
  const mode = $("mode").value;
  if (mode === "schedule" && !$("scheduleTime").value) return notice($("publishMessage"), "Choose a schedule date and time.", true);
  const button = $("publishBtn");
  button.disabled = true;
  button.textContent = selectedMethod === "upload" ? "Upload & post…" : "Processing video…";
  $("publishMessage").classList.add("hidden");
  try {
    let videoToUpload = file;
    let uploadFileName = file.name;
    if (selectedMethod === "upload") {
      showWorkflow("Only Upload selected", 5, "No patching, conversion, enhancement, or video processing. Sending the original video to your existing JV server.");
    } else {
      showWorkflow(`Starting ${METHOD_LABELS[selectedMethod]}…`, 2, "Preparing the original video.");
      const processed = await processInVideoLab(file, selectedMethod);
      if (!processed?.blob?.size) throw new Error("The selected method returned an empty processed video.");
      videoToUpload = processed.blob;
      uploadFileName = processed.fileName || file.name.replace(/\.[^.]+$/, "") + "_processed.mp4";
      showWorkflow("Video processing complete", 100, "Preparing the processed file for TikTok.");
    }

    const form = new FormData();
    form.append("video", videoToUpload, uploadFileName);
    form.append("accountId", $("accountSelect").value);
    form.append("caption", $("caption").value);
    form.append("mode", mode);
    form.append("privacyLevel", document.querySelector('input[name="privacy"]:checked')?.value || "publicToEveryone");
    form.append("allowComment", $("allowComment").checked);
    form.append("allowDuet", $("allowDuet").checked);
    form.append("allowStitch", $("allowStitch").checked);
    form.append("musicRights", $("musicRights").checked);
    form.append("videoRights", $("videoRights").checked);
    if (mode === "schedule") form.append("scheduledFor", new Date($("scheduleTime").value).toISOString());

    showWorkflow("Uploading video to TikTok…", 0, selectedMethod === "upload" ? "The original file is being sent unchanged to your existing JV server, then uploaded to TikTok." : "The selected processing method has finished. TikTok media upload is now running.");
    const result = await uploadPostWithProgress(form, pct => showWorkflow(`Uploading to JV TikTok server · ${pct}%`, Math.min(10, pct * 0.10), "Sending the processed MP4 from your browser to JV TikTok."), event => showWorkflow(event.message || "TikTok is processing the upload…", event.stage === "server_receive" ? 10 : 10 + (event.percent ?? 0) * 0.90, event.stage || "TikTok media upload and publishing."));
    showWorkflow("Post submitted successfully", 100, result.message || "TikTok accepted the TikTok post request.");
    notice($("publishMessage"), result.message || "Processed video submitted to TikTok.");
    $("publishForm").reset();
    $("captionCount").textContent = "0";
    clearVideoPreview();
    $("videoFile").value = "";
    refreshPostMode();
    loadHistory();
  } catch (error) {
    showWorkflow("Workflow failed", 0, error.message);
    notice($("publishMessage"), error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = selectedMethod === "upload" ? 'Upload &amp; post to TikTok <span>→</span>' : 'Patch video &amp; post to TikTok <span>→</span>';
  }
});
$("refreshHistory").addEventListener("click", loadHistory);
$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_UID);
  localStorage.removeItem(STORAGE_SESSION);
  // Keep browser token: this is the same browser-binding key used by the existing JV bot.
  identity = null;
  sessionToken = null;
  showLogin();
  toast("Signed out on this website. Use the JV bot's reset option if you need to move browsers.");
});

(async function init() {
  try {
    config = await api("/api/config");
    $("maxSize").textContent = config.maxVideoSizeMB || 500;
    $("connectionStatus").textContent = config.ready ? "Server ready" : "Setup required";
    $("connectionStatus").classList.toggle("online", config.ready);
    if (!config.ready) {
      notice($("loginMessage"), `Server setup incomplete: ${(config.missing || []).join(", ") || "Upstash connection"}. Configure Render environment variables.`, true);
      return;
    }
    const params = new URLSearchParams(location.search);
    if (params.has("connect")) {
      const code = params.get("connect");
      toast(code === "success" ? "TikTok connected successfully." : `TikTok connection: ${code}`);
      history.replaceState({}, "", "/");
    }
    await refreshAuth();
  } catch (error) {
    $("connectionStatus").textContent = "Server unavailable";
    notice($("loginMessage"), error.message, true);
  }
})();
