// ---- tiny shared client SDK: auth storage, fetch wrapper, websocket, toasts ----

const Auth = {
  getToken: () => localStorage.getItem("token"),
  getUser: () => JSON.parse(localStorage.getItem("user") || "null"),
  save(token, user) {
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  },
  requireLogin() {
    if (!Auth.getToken()) window.location.href = "/login.html";
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(Auth.getToken() ? { Authorization: `Bearer ${Auth.getToken()}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// Live connection: pushes toasts and lets pages subscribe to typed events.
function connectRealtime(onMessage) {
  const token = Auth.getToken();
  if (!token) return null;

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${token}`);
  const dot = () => document.querySelectorAll(".conn-dot");

  ws.onopen = () => dot().forEach((d) => d.classList.add("live"));
  ws.onclose = () => dot().forEach((d) => d.classList.remove("live"));
  ws.onmessage = (event) => {
    const notif = JSON.parse(event.data);
    if (notif.type === "new_application") {
      toast(`New application: ${notif.payload.applicantName} applied to ${notif.payload.clubName}`);
    } else if (notif.type === "application_decision") {
      toast(`${notif.payload.clubName}: your application was ${notif.payload.decision}`);
    } else if (notif.type === "club_match") {
      toast(`New club match: ${notif.payload.clubName} (${notif.payload.matchedTags.join(", ")})`);
    }
    if (onMessage) onMessage(notif);
  };
  return ws;
}

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function avatarHtml(name, size = 32) {
  const hue = [...(name || "")].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${size * 0.4}px;background:hsl(${hue},55%,45%)">${initials(
    name
  )}</span>`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function renderNav(active) {
  const user = Auth.getUser();
  const el = document.getElementById("nav");
  if (!el) return;
  el.innerHTML = `
    <span class="brand">UTD Clubs</span>
    <div>
      <span class="conn-dot" title="live connection"></span>
      <a href="/browse.html" ${active === "browse" ? 'style="text-decoration:underline"' : ""}>Browse Clubs</a>
      <a href="/student.html" ${active === "student" ? 'style="text-decoration:underline"' : ""}>My Applications</a>
      <a href="/admin.html" ${active === "admin" ? 'style="text-decoration:underline"' : ""}>Admin</a>
      <a href="/profile.html" ${active === "profile" ? 'style="text-decoration:underline"' : ""}>My Interests</a>
      <a href="#" id="logout-link">Logout (${user ? user.name : ""})</a>
    </div>
  `;
  document.getElementById("logout-link").onclick = (e) => {
    e.preventDefault();
    Auth.clear();
    window.location.href = "/login.html";
  };
}
