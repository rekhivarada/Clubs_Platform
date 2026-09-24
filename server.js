const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const http = require("http");
const path = require("path");

const db = require("./db");
const { signToken, requireAuth } = require("./auth");
const { initRealtime, notifyUser, broadcastToClub } = require("./realtime");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------

function isClubAdmin(clubId, userId) {
  const row = db
    .prepare("SELECT 1 FROM club_admins WHERE club_id = ? AND user_id = ?")
    .get(clubId, userId);
  return !!row;
}

function isClubMember(clubId, userId) {
  if (isClubAdmin(clubId, userId)) return true;
  const row = db
    .prepare("SELECT 1 FROM memberships WHERE club_id = ? AND user_id = ?")
    .get(clubId, userId);
  return !!row;
}

function clubWithAdminFlag(club, userId) {
  return {
    ...club,
    tags: club.tags ? club.tags.split(",") : [],
    is_admin: isClubAdmin(club.id, userId),
    is_member: isClubMember(club.id, userId),
  };
}

// shared guard used by members-only routes below
function requireMembership(req, res, next) {
  const clubId = Number(req.params.id);
  if (!isClubMember(clubId, req.user.id)) {
    return res.status(403).json({ error: "You must be a member of this club to view this" });
  }
  req.clubId = clubId;
  next();
}

function userTagSet(userId) {
  const row = db.prepare("SELECT interests, skills FROM users WHERE id = ?").get(userId);
  if (!row) return new Set();
  const tags = `${row.interests || ""},${row.skills || ""}`
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return new Set(tags);
}

// Overlap between a user's interests+skills and a club's tags, as a fraction
// of the club's tags that are covered - e.g. a club tagged [ai, python, social]
// where the student's tags cover [ai, python] scores 2/3 ~ 0.67. Returns which
// tags matched too, so the UI can show *why* it's a recommendation, not just a score.
function matchScore(userTags, club) {
  const clubTags = (club.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (clubTags.length === 0 || userTags.size === 0) return { score: 0, matched: [] };
  const matched = clubTags.filter((t) => userTags.has(t));
  return { score: matched.length / clubTags.length, matched };
}

// ================= AUTH =================

app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required" });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "An account with that email already exists" });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run(name, email, hash);

  const user = { id: info.lastInsertRowid, name, email };
  res.json({ token: signToken(user), user });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const safeUser = { id: user.id, name: user.name, email: user.email };
  res.json({ token: signToken(safeUser), user: safeUser });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ================= PROFILE (interests / skills for matching) =================

app.get("/api/me/profile", requireAuth, (req, res) => {
  const row = db.prepare("SELECT interests, skills FROM users WHERE id = ?").get(req.user.id);
  res.json({
    interests: row.interests ? row.interests.split(",").filter(Boolean) : [],
    skills: row.skills ? row.skills.split(",").filter(Boolean) : [],
  });
});

app.put("/api/me/profile", requireAuth, (req, res) => {
  const interests = Array.isArray(req.body.interests) ? req.body.interests : [];
  const skills = Array.isArray(req.body.skills) ? req.body.skills : [];
  const norm = (arr) => arr.map((s) => s.trim().toLowerCase()).filter(Boolean).join(",");

  db.prepare("UPDATE users SET interests = ?, skills = ? WHERE id = ?").run(
    norm(interests),
    norm(skills),
    req.user.id
  );
  res.json({ interests: norm(interests).split(",").filter(Boolean), skills: norm(skills).split(",").filter(Boolean) });
});

// ================= CLUBS =================

// List / search / filter clubs. ?q=search&tag=tech
app.get("/api/clubs", requireAuth, (req, res) => {
  const { q, tag } = req.query;
  let clubs;

  if (q && q.trim()) {
    // full-text search via FTS5, joined back to the clubs table
    clubs = db
      .prepare(
        `SELECT c.* FROM clubs c
         JOIN clubs_fts f ON f.rowid = c.id
         WHERE clubs_fts MATCH ?
         ORDER BY rank`
      )
      .all(q.trim().split(/\s+/).map((t) => `${t}*`).join(" "));
  } else {
    clubs = db.prepare("SELECT * FROM clubs ORDER BY created_at DESC").all();
  }

  if (tag) {
    clubs = clubs.filter((c) => (c.tags || "").split(",").includes(tag));
  }

  res.json(clubs.map((c) => clubWithAdminFlag(c, req.user.id)));
});

// Ranked recommendations for the current student, based on interests+skills
// overlap with each club's tags. Excludes clubs they're already in.
app.get("/api/clubs/recommended", requireAuth, (req, res) => {
  const userTags = userTagSet(req.user.id);
  const clubs = db.prepare("SELECT * FROM clubs ORDER BY created_at DESC").all();

  const ranked = clubs
    .filter((c) => !isClubMember(c.id, req.user.id))
    .map((c) => {
      const { score, matched } = matchScore(userTags, c);
      return { ...clubWithAdminFlag(c, req.user.id), match_score: score, matched_tags: matched };
    })
    .filter((c) => c.match_score > 0)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 6);

  res.json(ranked);
});

app.get("/api/clubs/:id", requireAuth, (req, res) => {
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(req.params.id);
  if (!club) return res.status(404).json({ error: "Club not found" });
  res.json(clubWithAdminFlag(club, req.user.id));
});

// Create a club — creator automatically becomes its 'owner' admin
app.post("/api/clubs", requireAuth, (req, res) => {
  const { name, description, tags, meeting_time } = req.body;
  if (!name) return res.status(400).json({ error: "Club name is required" });

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO clubs (name, description, tags, meeting_time, created_by) VALUES (?, ?, ?, ?, ?)"
      )
      .run(name, description || "", (tags || []).join(","), meeting_time || "", req.user.id);

    db.prepare(
      "INSERT INTO club_admins (club_id, user_id, role) VALUES (?, ?, 'owner')"
    ).run(info.lastInsertRowid, req.user.id);

    return info.lastInsertRowid;
  });

  const clubId = tx();
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(clubId);

  // Real-time recommendation nudge: tell any student whose interests/skills
  // overlap this club's tags right when it's created, not just when they
  // happen to browse later.
  const candidates = db.prepare("SELECT id FROM users WHERE id != ?").all(req.user.id);
  for (const { id: candidateId } of candidates) {
    const { score, matched } = matchScore(userTagSet(candidateId), club);
    if (score > 0) {
      notifyUser(candidateId, "club_match", {
        clubId: club.id,
        clubName: club.name,
        matchedTags: matched,
      });
    }
  }

  res.status(201).json(clubWithAdminFlag(club, req.user.id));
});

// ================= MEMBERSHIP / APPLICATIONS =================

// Student applies to a club
app.post("/api/clubs/:id/apply", requireAuth, (req, res) => {
  const clubId = Number(req.params.id);
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(clubId);
  if (!club) return res.status(404).json({ error: "Club not found" });

  const already = db
    .prepare("SELECT * FROM applications WHERE club_id = ? AND user_id = ?")
    .get(clubId, req.user.id);
  if (already) return res.status(409).json({ error: "You already applied to this club", status: already.status });

  const info = db
    .prepare("INSERT INTO applications (club_id, user_id, message) VALUES (?, ?, ?)")
    .run(clubId, req.user.id, req.body.message || "");

  // notify every admin of this club, live if they're connected
  const admins = db.prepare("SELECT user_id FROM club_admins WHERE club_id = ?").all(clubId);
  for (const { user_id } of admins) {
    notifyUser(user_id, "new_application", {
      applicationId: info.lastInsertRowid,
      clubId,
      clubName: club.name,
      applicantName: req.user.name,
    });
  }

  res.status(201).json({ id: info.lastInsertRowid, status: "pending" });
});

// Student's own applications, with live status
app.get("/api/me/applications", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, c.name AS club_name FROM applications a
       JOIN clubs c ON c.id = a.club_id
       WHERE a.user_id = ? ORDER BY a.created_at DESC`
    )
    .all(req.user.id);
  res.json(rows);
});

// Admin: list applications for a club they administer
app.get("/api/clubs/:id/applications", requireAuth, (req, res) => {
  const clubId = Number(req.params.id);
  if (!isClubAdmin(clubId, req.user.id)) {
    return res.status(403).json({ error: "Only admins of this club can view applications" });
  }
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS applicant_name, u.email AS applicant_email
       FROM applications a JOIN users u ON u.id = a.user_id
       WHERE a.club_id = ? ORDER BY a.created_at DESC`
    )
    .all(clubId);
  res.json(rows);
});

// Admin: approve or reject an application
app.post("/api/applications/:id/decision", requireAuth, (req, res) => {
  const { decision } = req.body; // 'approved' | 'rejected'
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const application = db.prepare("SELECT * FROM applications WHERE id = ?").get(req.params.id);
  if (!application) return res.status(404).json({ error: "Application not found" });
  if (!isClubAdmin(application.club_id, req.user.id)) {
    return res.status(403).json({ error: "Only admins of this club can decide applications" });
  }

  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(application.club_id);

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE applications SET status = ?, decided_at = datetime('now') WHERE id = ?"
    ).run(decision, application.id);

    if (decision === "approved") {
      db.prepare(
        "INSERT OR IGNORE INTO memberships (club_id, user_id) VALUES (?, ?)"
      ).run(application.club_id, application.user_id);
    }
  });
  tx();

  notifyUser(application.user_id, "application_decision", {
    clubId: application.club_id,
    clubName: club.name,
    decision,
  });

  res.json({ id: application.id, status: decision });
});

// Clubs the current user is a member of (approved) or admins
app.get("/api/me/clubs", requireAuth, (req, res) => {
  const memberOf = db
    .prepare(
      `SELECT c.* FROM clubs c JOIN memberships m ON m.club_id = c.id WHERE m.user_id = ?`
    )
    .all(req.user.id);
  const adminOf = db
    .prepare(
      `SELECT c.* FROM clubs c JOIN club_admins a ON a.club_id = c.id WHERE a.user_id = ?`
    )
    .all(req.user.id);
  res.json({
    memberOf: memberOf.map((c) => clubWithAdminFlag(c, req.user.id)),
    adminOf: adminOf.map((c) => clubWithAdminFlag(c, req.user.id)),
  });
});

// ================= CLUB HOME: members, announcements, chat =================

// Everything below requires the caller to be a member OR admin of :id.
// Non-members get a 403 - the club's internal space is private to its people.

app.get("/api/clubs/:id/members", requireAuth, requireMembership, (req, res) => {
  const admins = db
    .prepare(
      `SELECT u.id, u.name, u.email FROM users u
       JOIN club_admins a ON a.user_id = u.id WHERE a.club_id = ?`
    )
    .all(req.clubId);
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.joined_at FROM users u
       JOIN memberships m ON m.user_id = u.id WHERE m.club_id = ?`
    )
    .all(req.clubId);
  const adminIds = new Set(admins.map((a) => a.id));
  res.json({
    admins,
    // members list excludes anyone already shown as an admin, so nobody appears twice
    members: members.filter((m) => !adminIds.has(m.id)),
  });
});

app.get("/api/clubs/:id/announcements", requireAuth, requireMembership, (req, res) => {
  const announcements = db
    .prepare(
      `SELECT a.*, u.name AS author_name FROM announcements a
       JOIN users u ON u.id = a.author_id
       WHERE a.club_id = ? ORDER BY a.created_at DESC`
    )
    .all(req.clubId);

  const replyStmt = db.prepare(
    `SELECT r.*, u.name AS author_name FROM announcement_replies r
     JOIN users u ON u.id = r.user_id WHERE r.announcement_id = ? ORDER BY r.created_at ASC`
  );
  res.json(announcements.map((a) => ({ ...a, replies: replyStmt.all(a.id) })));
});

app.post("/api/clubs/:id/announcements", requireAuth, (req, res) => {
  const clubId = Number(req.params.id);
  if (!isClubAdmin(clubId, req.user.id)) {
    return res.status(403).json({ error: "Only admins of this club can post announcements" });
  }
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: "title and body are required" });

  const info = db
    .prepare("INSERT INTO announcements (club_id, author_id, title, body) VALUES (?, ?, ?, ?)")
    .run(clubId, req.user.id, title, body);

  const announcement = {
    id: info.lastInsertRowid,
    club_id: clubId,
    author_id: req.user.id,
    author_name: req.user.name,
    title,
    body,
    created_at: new Date().toISOString(),
    replies: [],
  };
  broadcastToClub(clubId, "new_announcement", announcement, req.user.id);
  res.status(201).json(announcement);
});

app.post("/api/announcements/:id/replies", requireAuth, (req, res) => {
  const announcement = db.prepare("SELECT * FROM announcements WHERE id = ?").get(req.params.id);
  if (!announcement) return res.status(404).json({ error: "Announcement not found" });
  if (!isClubMember(announcement.club_id, req.user.id)) {
    return res.status(403).json({ error: "You must be a member of this club to reply" });
  }
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Reply cannot be empty" });

  const info = db
    .prepare("INSERT INTO announcement_replies (announcement_id, user_id, body) VALUES (?, ?, ?)")
    .run(announcement.id, req.user.id, body.trim());

  const reply = {
    id: info.lastInsertRowid,
    announcement_id: announcement.id,
    user_id: req.user.id,
    author_name: req.user.name,
    body: body.trim(),
    created_at: new Date().toISOString(),
  };
  broadcastToClub(announcement.club_id, "new_reply", reply, req.user.id);
  res.status(201).json(reply);
});

// Chat: last 50 messages on load, then live via WebSocket from here on
app.get("/api/clubs/:id/messages", requireAuth, requireMembership, (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.*, u.name AS author_name FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.club_id = ? ORDER BY m.created_at DESC LIMIT 50`
    )
    .all(req.clubId);
  res.json(rows.reverse());
});

app.post("/api/clubs/:id/messages", requireAuth, requireMembership, (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Message cannot be empty" });

  const info = db
    .prepare("INSERT INTO messages (club_id, user_id, body) VALUES (?, ?, ?)")
    .run(req.clubId, req.user.id, body.trim());

  const message = {
    id: info.lastInsertRowid,
    club_id: req.clubId,
    user_id: req.user.id,
    author_name: req.user.name,
    body: body.trim(),
    created_at: new Date().toISOString(),
  };
  broadcastToClub(req.clubId, "chat_message", message, req.user.id); // sender already has it from this response
  res.status(201).json(message);
});

// ================= NOTIFICATIONS =================

// Durable fallback for anything missed while offline (WebSocket delivers live)
app.get("/api/notifications", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(req.user.id);
  res.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?").run(
    req.params.id,
    req.user.id
  );
  res.json({ ok: true });
});

// ================= boot =================

const server = http.createServer(app);
initRealtime(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Clubs platform running on http://localhost:${PORT}`);
});
