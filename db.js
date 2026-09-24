const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "clubs.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  interests TEXT DEFAULT '',   -- comma-separated, e.g. "ai,robotics,music"
  skills TEXT DEFAULT '',      -- comma-separated, e.g. "python,public-speaking"
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT,               -- comma-separated, e.g. "tech,ai,social"
  meeting_time TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- per-club admin roles: a user can be an admin of one club and a regular
-- member/applicant of another. This is the "real" access-control model
-- instead of a single global is_admin flag.
CREATE TABLE IF NOT EXISTS club_admins (
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin',  -- 'owner' | 'admin'
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE(club_id, user_id)
);

CREATE TABLE IF NOT EXISTS memberships (
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,       -- 'new_application' | 'application_decision'
  payload TEXT NOT NULL,    -- JSON string
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS clubs_fts USING fts5(
  name, description, tags, content='clubs', content_rowid='id'
);

-- keep the FTS index in sync with the clubs table
CREATE TRIGGER IF NOT EXISTS clubs_ai AFTER INSERT ON clubs BEGIN
  INSERT INTO clubs_fts(rowid, name, description, tags) VALUES (new.id, new.name, new.description, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS clubs_ad AFTER DELETE ON clubs BEGIN
  INSERT INTO clubs_fts(clubs_fts, rowid, name, description, tags) VALUES('delete', old.id, old.name, old.description, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS clubs_au AFTER UPDATE ON clubs BEGIN
  INSERT INTO clubs_fts(clubs_fts, rowid, name, description, tags) VALUES('delete', old.id, old.name, old.description, old.tags);
  INSERT INTO clubs_fts(rowid, name, description, tags) VALUES (new.id, new.name, new.description, new.tags);
END;
`);

module.exports = db;

// Lightweight migration for databases created before interests/skills existed.
// better-sqlite3 has no "ADD COLUMN IF NOT EXISTS", so we probe and swallow
// the duplicate-column error if it's already there.
for (const col of ["interests", "skills"]) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT DEFAULT ''`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}
