# Clubs Platform

A full-stack platform where students discover and apply to student clubs, and
club admins manage applications — with **live, real-time notifications** in
both directions over WebSockets.

## Why this is more than CRUD

Three deliberate design decisions give this project real engineering weight
beyond "forms + a database":

1. **Per-club RBAC, not a global admin flag.** A user can be admin of Club A
   and a plain applicant of Club B. Every admin-only route checks membership
   in `club_admins` for that specific club — see `isClubAdmin()` in
   `server.js` and the 403 test in the walkthrough below.

2. **Real-time notification fan-out with an offline-durable fallback.**
   `realtime.js` keeps an in-memory map of `userId -> live WebSocket
   connections` (a user can have multiple tabs open). When something
   happens — a new application, a decision — the event is **persisted to
   the `notifications` table AND pushed live** to any open sockets for that
   user. If the user isn't connected, the row is still there next time they
   load `/api/notifications`. This is the same pattern production
   pub/sub systems use: durable-write-then-fanout, not fire-and-forget.

3. **Full-text search via SQLite FTS5**, kept in sync with the `clubs`
   table through triggers (`clubs_ai`/`clubs_ad`/`clubs_au` in `db.js`),
   instead of `LIKE '%term%'` scans.

## Architecture

```
Browser  <-- REST (fetch) -->  Express API   <-->  SQLite (better-sqlite3)
Browser  <-- WebSocket    -->  ws server (same HTTP server, /ws path)
```

- **Backend**: Node/Express, `better-sqlite3` (synchronous, embedded —
  no separate DB process needed for a project this size), `ws` for
  WebSockets on the same HTTP server, `jsonwebtoken` + `bcryptjs` for auth.
- **Frontend**: plain HTML/CSS/JS (no build step) — `public/`. Each page
  is a thin client against the REST API, using a shared `app.js` for the
  fetch wrapper, auth storage, and the WebSocket connection.
- **Auth**: JWT bearer tokens for REST; the same token is passed as a
  query param on the WebSocket upgrade (`/ws?token=...`) since browsers
  can't set custom headers on a WebSocket handshake.

## Club recommendations (new)

Every student can set **interests** and **skills** (`/profile.html`) — free-form
tags like `ai, robotics` and `python, public-speaking`. Browse Clubs then shows
a **"Recommended for you"** section, ranked by how much overlap each club's
tags have with the student's profile:

- Match score = *(club tags the student's profile covers) / (club's total tags)*,
  so a club tagged `[ai, python]` where the student has both scores 100%,
  one tagged `[ai, social]` where they only have `ai` scores 50%.
- Each recommended card shows *which* tags matched (`✓ ai`), not just a
  number — the point is a student can see *why* it's a fit, not just trust
  a black-box score.
- **Real-time tie-in**: the instant an admin creates a new club, the server
  checks every other user's interests/skills against its tags and pushes a
  live "new club match" toast to anyone with overlap — see the `club_match`
  branch of `notifyUser()` calls in the `POST /api/clubs` handler in
  `server.js`. A student doesn't have to go back and browse to discover a
  new club fits them; they find out the moment it exists.

This is intentionally a simple, explainable scoring function (tag overlap)
rather than an ML model — appropriate for the data available (a handful of
self-reported tags), and easy to defend in an interview: you can describe
exactly why a club was or wasn't recommended, which a black-box model
couldn't do at this scale.

## Club home page (new)

Once you're a member (or admin) of a club, its name becomes a link to
`/club.html?id=<id>` — a members-only space with four tabs:

- **Overview** — description and tags
- **Members** — every admin and member, with generated avatar initials
- **Announcements** — admins post updates; any member can reply in a thread
  under each one
- **Chat** — a live group chat for the whole club

Access is enforced server-side (`requireMembership` in `server.js`), not
just hidden in the UI — a non-member hitting any of these routes directly
gets a 403.

**How the live updates work here:** chat messages and announcement replies
don't go through the personal-notifications system (`notifyUser`) — they
use a separate `broadcastToClub()` in `realtime.js` that looks up every
member/admin of that club and pushes to whoever's currently connected. This
is a "room broadcast" rather than a per-user inbox item, which is the right
model for chat: you don't want a permanent notification-bell entry for
every chat message, just a live push while you're on the page (the last 50
messages are still persisted in the `messages` table so history isn't lost
on refresh).

## Data model

```
users            (id, name, email, password_hash, interests, skills)
clubs            (id, name, description, tags, meeting_time, created_by)
club_admins      (club_id, user_id, role)   -- composite PK, per-club roles
applications     (id, club_id, user_id, message, status, created_at, decided_at)
memberships      (club_id, user_id, joined_at)  -- created on approval
notifications    (id, user_id, type, payload, read, created_at)
announcements    (id, club_id, author_id, title, body, created_at)
announcement_replies (id, announcement_id, user_id, body, created_at)
messages         (id, club_id, user_id, body, created_at)   -- chat
clubs_fts        -- FTS5 virtual table, kept in sync via triggers
```

## Running it

```bash
npm install
node server.js
# -> http://localhost:3000
```

First visit redirects to `/register.html`. Register a user, create a club
(you become its admin automatically), then register a second user in an
incognito window to apply as a student — approve/reject from `/admin.html`
and watch the notification arrive live on the other tab.

## API surface

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Get a JWT |
| GET | `/api/clubs?q=&tag=` | user | Search/filter clubs |
| GET | `/api/clubs/recommended` | user | Clubs ranked by interest/skill match |
| GET/PUT | `/api/me/profile` | user | View/set interests & skills |
| POST | `/api/clubs` | user | Create a club (creator -> owner admin) |
| POST | `/api/clubs/:id/apply` | user | Apply; notifies all club admins live |
| GET | `/api/clubs/:id/applications` | club admin only | View applicants |
| POST | `/api/applications/:id/decision` | club admin only | Approve/reject; notifies applicant live |
| GET | `/api/me/applications` | user | Your own application statuses |
| GET | `/api/me/clubs` | user | Clubs you're a member/admin of |
| GET | `/api/notifications` | user | Durable notification history (offline fallback) |
| GET | `/api/clubs/:id/members` | member/admin | Roster (admins + members) |
| GET/POST | `/api/clubs/:id/announcements` | member (GET) / admin (POST) | Club announcements |
| POST | `/api/announcements/:id/replies` | member | Reply to an announcement, broadcast live |
| GET/POST | `/api/clubs/:id/messages` | member/admin | Chat history / send message, broadcast live |
| WS | `/ws?token=` | user | Live push channel (personal notifications + club room broadcasts) |

## What's deliberately out of scope (for a v1)

- Email verification / password reset
- Pagination (fine at student-club scale, would matter at real scale)
- Rate limiting on auth endpoints
- A real production DB (Postgres) — SQLite was the right call for a
  single-instance project like this; swapping the `better-sqlite3` calls
  in `db.js`/`server.js` for `pg` is the main change needed to scale out.

## Resume-bullet-worthy pieces, if you want to describe this project

- Designed a per-club role-based access control model instead of a global
  admin flag, enforced server-side on every admin-only route.
- Built a real-time notification system (WebSocket fan-out keyed by user
  ID, with a durable database-backed fallback for offline users).
- Implemented full-text search with SQLite FTS5, kept in sync with the
  primary table via triggers.
