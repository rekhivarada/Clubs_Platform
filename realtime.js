const { WebSocketServer } = require("ws");
const { verifyToken } = require("./auth");
const db = require("./db");

// userId -> Set of live WebSocket connections (a user can have multiple tabs)
const connections = new Map();

function initRealtime(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const payload = token && verifyToken(token);

    if (!payload) {
      ws.close(4001, "unauthorized");
      return;
    }

    const userId = payload.id;
    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId).add(ws);

    ws.on("close", () => {
      const set = connections.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) connections.delete(userId);
      }
    });
  });

  return wss;
}

// Persist a notification AND push it live if the user is currently connected.
// This is the "real-time if online, durable if offline" pattern - a client
// reconnecting later still sees it via GET /api/notifications.
function notifyUser(userId, type, payload) {
  const stmt = db.prepare(
    "INSERT INTO notifications (user_id, type, payload) VALUES (?, ?, ?)"
  );
  const info = stmt.run(userId, type, JSON.stringify(payload));

  const message = JSON.stringify({
    id: info.lastInsertRowid,
    type,
    payload,
    created_at: new Date().toISOString(),
  });

  const sockets = connections.get(userId);
  if (sockets) {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }
}

// Live-only broadcast to every currently-connected member/admin of a club.
// Used for chat and announcement replies: these live in their own durable
// tables (messages, announcement_replies) already, so unlike notifyUser()
// this does NOT also write to the notifications table - it's a room
// broadcast, not a per-user inbox item.
function broadcastToClub(clubId, type, payload, excludeUserId = null) {
  const memberIds = db
    .prepare(
      `SELECT user_id FROM memberships WHERE club_id = ?
       UNION
       SELECT user_id FROM club_admins WHERE club_id = ?`
    )
    .all(clubId, clubId)
    .map((r) => r.user_id);

  const message = JSON.stringify({ type, payload, created_at: new Date().toISOString() });

  for (const userId of memberIds) {
    if (userId === excludeUserId) continue;
    const sockets = connections.get(userId);
    if (!sockets) continue;
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }
}

module.exports = { initRealtime, notifyUser, broadcastToClub, connections };
