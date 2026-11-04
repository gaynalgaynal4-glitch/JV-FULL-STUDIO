const $ = id => document.getElementById(id);

const STORAGE_UID = "jv_video_lab_telegram_uid_v1";
const STORAGE_BROWSER_TOKEN = "jv_video_lab_browser_token_v1";
const STORAGE_SESSION = "jv_postzen_session_v1";

let config = null;
let identity = null;
let sessionToken = null;
let accounts = [];
let selectedMethod = localStorage.getItem("jv_postzen_processing_method_v1") || "local";
if (!Object.prototype.hasOwnProperty.call({ enhanced:1, local:1, ffmpeg:1 }, selectedMethod)) selectedMethod = "local";
let videoLabReady = false;
let videoLabReadyPromise = null;
let activeVideoLabJob = null;
const METHOD_LABELS = { enhanced: "ENHANCED METHOD", local: "LOCAL METHOD", ffmpeg: "FFMPEG METHOD" };

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
    await api("/api/me");
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
      item.innerHTML = '<div class="account-left"><span class="tt-icon">♪</span><div><b></b><small></small></div></div><span class="history-status">Connected</span>';
      item.querySelector("b").textContent = name;
      item.querySelector("small").textContent = handle;
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
      $("videoLabFrame").contentWindow.postMessage({ type: "JV_VIDEO_LAB_PROCESS", requestId, method, file }, location.origin);
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
        if (item.type === "progress") onServerProgress?.(item);
        else if (item.type === "complete") finalResult = item.result || { ok: true, message: item.message };
        else if (item.type === "error" || item.error) serverError = item.error || "PostZen publishing failed.";
        // Accept a normal JSON success response as well as the NDJSON progress
        // protocol. This protects against hosts/proxies that buffer or normalize streams.
        else if (item.ok === true || item.post || item.existingPost) finalResult = item.result || item;
      }
    };
    xhr.open("POST", "/api/posts", true);
    if (identity?.uid) xhr.setRequestHeader("X-JV-Telegram-UID", identity.uid);
    if (identity?.browserToken) xhr.setRequestHeader("X-JV-Browser-Token", identity.browserToken);
    if (sessionToken) xhr.setRequestHeader("Authorization", `Bearer ${sessionToken}`);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.upload.onload = () => onServerProgress?.({ type:"progress", stage:"server_receive", percent:0, message:"Processed video received by JV PostZen. Preparing media storage…" });
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
          ? `PostZen returned HTTP ${xhr.status}, but no completion event was received (${contentType}). ${bodyHint || "The response body was empty."}`
          : `PostZen upload failed (HTTP ${xhr.status}). ${bodyHint}`)));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading the processed video to PostZen."));
    xhr.onabort = () => reject(new Error("PostZen upload was cancelled."));
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
$("methodSettingsBtn").addEventListener("click", () => { updateMethodUI(); $("methodModal").classList.remove("hidden"); });
$("closeMethodModal").addEventListener("click", () => $("methodModal").classList.add("hidden"));
$("methodModal").addEventListener("click", event => { if (event.target === $("methodModal")) $("methodModal").classList.add("hidden"); });
document.querySelectorAll(".method-choice").forEach(button => button.addEventListener("click", () => {
  selectedMethod = button.dataset.method;
  localStorage.setItem("jv_postzen_processing_method_v1", selectedMethod);
  updateMethodUI();
  $("methodModal").classList.add("hidden");
  toast(`${METHOD_LABELS[selectedMethod]} selected`);
}));

$("verifyBtn").addEventListener("click", () => verifyUID($("tgUidInput").value.trim()));
$("tgUidInput").addEventListener("keydown", event => {
  if (event.key === "Enter") verifyUID($("tgUidInput").value.trim());
});
$("connectBtn").addEventListener("click", async () => {
  const button = $("connectBtn");
  button.disabled = true;
  button.textContent = "Opening PostZen…";
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
$("mode").addEventListener("change", () => {
  const mode = $("mode").value;
  $("scheduleWrap").classList.toggle("hidden", mode !== "schedule");
  $("privacyWrap").classList.toggle("hidden", mode === "draft");
});
$("caption").addEventListener("input", () => $("captionCount").textContent = $("caption").value.length);
$("videoFile").addEventListener("change", () => {
  const file = $("videoFile").files[0];
  $("fileName").textContent = file ? file.name : "Choose a video";
});
$("publishForm").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("videoFile").files[0];
  if (!file) return notice($("publishMessage"), "Choose a video file.", true);
  if (!file.type.startsWith("video/")) return notice($("publishMessage"), "Please select a video file.", true);
  const extension = file.name.split(".").pop().toLowerCase();
  const supportedForMethod = selectedMethod === "ffmpeg" ? ["mp4", "mov", "m4v"] : ["mp4"];
  if (!supportedForMethod.includes(extension)) return notice($("publishMessage"), `${METHOD_LABELS[selectedMethod]} supports ${supportedForMethod.join(", ").toUpperCase()} files only.`, true);
  if (file.size > config.maxVideoSizeMB * 1024 * 1024) return notice($("publishMessage"), `The video is larger than ${config.maxVideoSizeMB} MB.`, true);
  if (!$("accountSelect").value) return notice($("publishMessage"), "Connect and select a TikTok account first.", true);
  const mode = $("mode").value;
  if (mode === "schedule" && !$("scheduleTime").value) return notice($("publishMessage"), "Choose a schedule date and time.", true);
  const button = $("publishBtn");
  button.disabled = true;
  button.textContent = "Processing video…";
  $("publishMessage").classList.add("hidden");
  try {
    showWorkflow(`Starting ${METHOD_LABELS[selectedMethod]}…`, 2, "Preparing the original video.");
    const processed = await processInVideoLab(file, selectedMethod);
    if (!processed?.blob?.size) throw new Error("The selected method returned an empty processed video.");
    showWorkflow("Video processing complete", 100, "Preparing the processed file for PostZen.");

    const form = new FormData();
    form.append("video", processed.blob, processed.fileName || file.name.replace(/\.[^.]+$/, "") + "_processed.mp4");
    form.append("accountId", $("accountSelect").value);
    form.append("caption", $("caption").value);
    form.append("mode", mode);
    form.append("privacyLevel", $("privacy").value);
    if (mode === "schedule") form.append("scheduledFor", new Date($("scheduleTime").value).toISOString());

    showWorkflow("Uploading processed video to PostZen…", 0, "The selected processing method has finished. PostZen media upload is now running.");
    const result = await uploadPostWithProgress(form, pct => showWorkflow(`Uploading to JV PostZen server · ${pct}%`, Math.min(10, pct * 0.10), "Sending the processed MP4 from your browser to JV PostZen."), event => showWorkflow(event.message || "PostZen is processing the upload…", event.stage === "server_receive" ? 10 : 10 + (event.percent ?? 0) * 0.90, event.stage || "PostZen media upload and publishing."));
    showWorkflow("Post submitted successfully", 100, result.message || "PostZen accepted the TikTok post request.");
    notice($("publishMessage"), result.message || "Processed video submitted to PostZen.");
    $("publishForm").reset();
    $("captionCount").textContent = "0";
    $("fileName").textContent = "Choose a video";
    $("scheduleWrap").classList.add("hidden");
    $("privacyWrap").classList.add("hidden");
    loadHistory();
  } catch (error) {
    showWorkflow("Workflow failed", 0, error.message);
    notice($("publishMessage"), error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Patch video &amp; post to TikTok <span>→</span>';
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
