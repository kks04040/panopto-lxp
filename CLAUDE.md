# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LXP video player backend that bridges a Korean university LMS (건양대학교 LXP) to a Panopto-hosted video platform. Tracks student attendance by polling Panopto's viewing-stats API and judging attendance against a configurable view-percentage threshold.

## Commands

- `npm start` / `npm run dev` — both run `node server.js` (no nodemon, no test runner, no linter configured).
- Copy `.env.example` → `.env` and fill in `PANOPTO_CLIENT_ID` / `PANOPTO_CLIENT_SECRET` (issued from Panopto admin: System → Identity Providers → Add Panopto OAuth2 Client) before starting.
- Health check: `curl http://localhost:3000/health`.
- Frontend dev: open `http://localhost:3000/?sessionId=<panopto-session-uuid>&userId=<user>` — `public/index.html` reads those query params (defaults are demo values in the file).

## Architecture

Three-layer Node/Express app, all in-memory (no database yet — `src/attendance.js` notes Oracle/PostgreSQL is the eventual target).

**`server.js`** — Express server, session middleware, static `public/`. Wires up two singletons: a `PanoptoClient` and an `AttendanceEngine`. Both are constructed with the same Panopto credentials, so each holds its **own** OAuth token cache (they do not share tokens).

**`src/panopto.js`** — `PanoptoClient`: OAuth2 client-credentials grant against `https://{PANOPTO_SERVER}/Panopto/oauth2/connect/token` with `scope=api`, plus thin wrappers over `/Panopto/api/v1/sessions/{id}` and `/sessions/{id}/viewingStats`. Token is cached in-memory and refreshed 60s before expiry. `getStreamCount()` is how the frontend learns single-vs-dual-channel layout (derived from `session.Streams.length`).

**`src/attendance.js`** — `AttendanceEngine`: per-session polling loop (`startPolling`/`stopPolling`) that calls `viewingStats` every `POLLING_INTERVAL_SEC` and accumulates per-user records in a nested `Map<sessionId, Map<userId, record>>`. Key behaviors:
- **Resume detection**: if a user's `ViewPercentage` drops more than 2% below their previous max, `resumeCount` is incremented (treated as a new viewing session).
- **Sticky attendance**: once `maxPercent ≥ threshold`, `isAttended` is latched true and never reverts, even if Panopto later returns a lower percentage.
- **`maxPercent` vs `secondsViewed`**: attendance is judged off the running max of `ViewPercentage`, not the latest snapshot — important when editing the judging logic.

**Memory-vs-API fallback in routes**: `/api/session/:id/attendance` and `/summary` first read from the `AttendanceEngine` in-memory store. If the engine has no record for that session (i.e., no one has called `/poll/start`), the route falls back to a one-shot direct Panopto call. Anything that depends on `resumeCount` only works after polling has been started, since the direct-call path hardcodes `resumeCount: 0`.

**Frontend (`public/index.html`)** — single-page vanilla JS, dark UI. Reads `sessionId` / `userId` from the URL query string, calls `/api/session/:id/info` to choose single/dual-channel layout, then `POST /poll/start` and periodically polls `/attendance`. Embeds the Panopto player via the `Embed.aspx` URL constructed server-side.

## Constraints to remember

- **State is process-local.** Polling intervals, attendance records, and OAuth tokens all live in memory. Restarting the server loses everything except what Panopto itself has stored.
- **No auth on routes.** `userId` comes from `req.query` or `req.session.userId`. The README/comments anticipate LTI populating the session, but no LTI launch is implemented yet — treat the API as untrusted-input until that lands.
- **Comments and user-facing strings are in Korean.** Match that style when editing existing files; English is fine for net-new internal code.
