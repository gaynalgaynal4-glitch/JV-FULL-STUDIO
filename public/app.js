let supabaseClient = null;
let session = null;
let mode = "login";
let uploadedMediaUrl = "";
let currentAccounts = [];

const $ = (id) => document.getElementById(id);
async function api(path, options = {}) {
  if (!session?.access_token) throw new Error("Please sign in first.");
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${session.access_token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function notice(id, message, error = false) {
  const el = $(id); el.textContent = message; el.style.color = error ? "#ff9a9a" : "";
}
async function init() {
  const cfg = await fetch("/api/config").then(r => r.json());
  if (!cfg.supabaseUrl || !cfg.supabasePublishableKey || !window.supabase) {
    notice("authMessage", "Server setup incomplete: add Supabase URL and publishable key in Render.", true);
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
  const { data } = await supabaseClient.auth.getSession();
  session = data.session;
  supabaseClient.auth.onAuthStateChange((_event, next) => { session = next; renderAuth(); if (session) loadDashboard(); });
  renderAuth();
  if (session) await loadDashboard();
}
function renderAuth() {
  $("authPanel").hidden = Boolean(session);
  $("appPanel").hidden = !session;
  $("logout").hidden = !session;
  if (session) {
    $("userEmail").textContent = session.user.email || "Signed in";
    $("avatar").textContent = (session.user.email || "U").slice(0,1).toUpperCase();
  }
}
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  mode = btn.dataset.mode;
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("selected", x === btn));
  $("authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  notice("authMessage", mode === "signup" ? "Use an email and a password with at least 8 characters." : "Sign in with your Supabase Auth account.");
}));
$("authSubmit").addEventListener("click", async () => {
  try {
    const email = $("email").value.trim(), password = $("password").value;
    if (!email || password.length < 8) throw new Error("Enter a valid email and password (at least 8 characters).");
    $("authSubmit").disabled = true;
    const result = mode === "signup"
      ? await supabaseClient.auth.signUp({ email, password })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    session = result.data.session;
    if (!session) notice("authMessage", "Account created. Check your email to confirm it, then sign in.");
    else { renderAuth(); await loadDashboard(); }
  } catch (e) { notice("authMessage", e.message, true); }
  finally { $("authSubmit").disabled = false; }
});
$("logout").addEventListener("click", async () => { await supabaseClient.auth.signOut(); session = null; currentAccounts = []; renderAuth(); });
async function loadDashboard() {
  try {
    const data = await api("/api/me");
    $("workspaceName").textContent = data.workspace.profile_name;
    currentAccounts = data.accounts || [];
    $("accountCount").textContent = currentAccounts.length;
    renderAccounts(); renderHistory(data.posts || []);
    await handleOAuthReturn();
  } catch (e) { alert(e.message); }
}
function renderAccounts() {
  $("accountCount").textContent = currentAccounts.length;
  $("accountList").innerHTML = currentAccounts.length ? currentAccounts.map(a =>
    `<div class="account"><div class="tiktokicon">♪</div><div class="accountinfo"><b>${escapeHtml(a.displayName || a.username || "TikTok account")}</b><small>@${escapeHtml(a.username || "connected")} · TikTok</small></div><span class="status">${escapeHtml(a.status)}</span></div>`
  ).join("") : '<div class="empty">No TikTok account connected. Use “Connect” to add one.</div>';
  $("accountSelect").innerHTML = currentAccounts.length
    ? currentAccounts.map(a => `<option value="${escapeHtml(a.accountId)}">${escapeHtml(a.displayName || a.username || a.accountId)} (@${escapeHtml(a.username || "TikTok")})</option>`).join("")
    : '<option value="">Connect an account first</option>';
}
function renderHistory(posts) {
  $("postCount").textContent = posts.length;
  $("history").innerHTML = posts.length ? posts.map(p =>
    `<tr><td title="${escapeHtml(p.caption || "")}">${escapeHtml(p.caption || "(No caption)")}</td><td>${escapeHtml(p.publish_mode || "")}</td><td>${escapeHtml(p.status || "submitted")}</td><td>${new Date(p.created_at).toLocaleString()}</td></tr>`
  ).join("") : '<tr><td colspan="4" class="empty">No posts yet.</td></tr>';
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
async function connectTikTok() {
  try { const data = await api("/api/connect/tiktok", { method: "POST" }); location.href = data.authUrl; }
  catch (e) { alert(e.message); }
}
$("connectBtn").addEventListener("click", connectTikTok);
$("connectTop").addEventListener("click", connectTikTok);
async function handleOAuthReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get("oauth") !== "postzen") return;
  const code = params.get("code"), state = params.get("state");
  if (code && state) {
    try {
      const result = await api("/api/connect/complete", { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ code, state }) });
      currentAccounts = result.accounts || currentAccounts; renderAccounts();
      alert(result.message || "TikTok account connected.");
    } catch (e) { alert(e.message); }
  } else if (params.get("error")) alert("TikTok connection was not completed: " + params.get("error"));
  history.replaceState({}, "", "/");
}
$("browse").addEventListener("click", () => $("video").click());
$("drop").addEventListener("click", e => { if (e.target.id !== "browse") $("video").click(); });
$("drop").addEventListener("dragover", e => { e.preventDefault(); $("drop").style.borderColor = "#8cf0c0"; });
$("drop").addEventListener("dragleave", () => $("drop").style.borderColor = "");
$("drop").addEventListener("drop", e => { e.preventDefault(); $("drop").style.borderColor = ""; if (e.dataTransfer.files[0]) setVideo(e.dataTransfer.files[0]); });
$("video").addEventListener("change", e => { if (e.target.files[0]) setVideo(e.target.files[0]); });
function setVideo(file) {
  $("video").files = createFileList(file);
  $("fileName").textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  uploadedMediaUrl = "";
}
function createFileList(file) { const dt = new DataTransfer(); dt.items.add(file); return dt.files; }
$("caption").addEventListener("input", () => $("charCount").textContent = $("caption").value.length);
$("mode").addEventListener("change", () => { $("scheduleWrap").hidden = $("mode").value !== "schedule"; $("publishBtn").textContent = $("mode").value === "draft" ? "Upload & save draft" : $("mode").value === "schedule" ? "Upload & schedule" : "Upload & publish video"; });
$("postForm").addEventListener("submit", async e => {
  e.preventDefault();
  const file = $("video").files[0];
  if (!file) return notice("publishMessage", "Choose a video file first.", true);
  if (!currentAccounts.length) return notice("publishMessage", "Connect your TikTok account first.", true);
  const btn = $("publishBtn"); btn.disabled = true;
  try {
    notice("publishMessage", "Uploading video to PostZen storage…");
    const form = new FormData(); form.append("video", file);
    const uploaded = await api("/api/upload", { method: "POST", body: form });
    uploadedMediaUrl = uploaded.publicUrl;
    notice("publishMessage", "Upload complete. Submitting your post…");
    const payload = {
      accountId: $("accountSelect").value, caption: $("caption").value,
      mediaUrl: uploadedMediaUrl, mode: $("mode").value,
      scheduledFor: $("scheduledFor").value ? new Date($("scheduledFor").value).toISOString() : null,
      privacyLevel: $("privacy").value, allowComments: $("comments").checked, isAigc: $("aigc").checked
    };
    const result = await api("/api/posts", { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    notice("publishMessage", result.message || "Post submitted.");
    $("postForm").reset(); $("comments").checked = true; $("charCount").textContent = "0"; $("scheduleWrap").hidden = true; $("fileName").textContent = "MP4, MOV, WEBM, AVI · size limit set by server";
    await loadDashboard();
  } catch (err) { notice("publishMessage", err.message, true); }
  finally { btn.disabled = false; }
});
$("refresh").addEventListener("click", loadDashboard);
init().catch(e => notice("authMessage", e.message, true));