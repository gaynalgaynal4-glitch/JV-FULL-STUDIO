const $ = id => document.getElementById(id);

const STORAGE_UID = "jv_video_lab_telegram_uid_v1";
const STORAGE_BROWSER_TOKEN = "jv_video_lab_browser_token_v1";
const STORAGE_SESSION = "jv_postzen_session_v1";

let config = null;
let identity = null;
let sessionToken = null;
let accounts = [];

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
  if (file.size > config.maxVideoSizeMB * 1024 * 1024) return notice($("publishMessage"), `The video is larger than ${config.maxVideoSizeMB} MB.`, true);
  if (!$("accountSelect").value) return notice($("publishMessage"), "Connect and select a TikTok account first.", true);
  const mode = $("mode").value;
  const form = new FormData();
  form.append("video", file);
  form.append("accountId", $("accountSelect").value);
  form.append("caption", $("caption").value);
  form.append("mode", mode);
  form.append("privacyLevel", $("privacy").value);
  if (mode === "schedule") {
    if (!$("scheduleTime").value) return notice($("publishMessage"), "Choose a schedule date and time.", true);
    form.append("scheduledFor", new Date($("scheduleTime").value).toISOString());
  }
  const button = $("publishBtn");
  button.disabled = true;
  button.textContent = "Uploading video…";
  try {
    const result = await api("/api/posts", { method: "POST", body: form });
    notice($("publishMessage"), result.message || "Post request submitted to PostZen.");
    $("publishForm").reset();
    $("captionCount").textContent = "0";
    $("fileName").textContent = "Choose a video";
    $("scheduleWrap").classList.add("hidden");
    $("privacyWrap").classList.add("hidden");
    loadHistory();
  } catch (error) {
    notice($("publishMessage"), error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Upload &amp; submit <span>→</span>';
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
