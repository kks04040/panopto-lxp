# AGENTS.md

## Start

```
cp .env.example .env
# Fill PANOPTO_CLIENT_ID and PANOPTO_CLIENT_SECRET
npm start
```
Health: `curl http://localhost:3000/health`
Frontend: `http://localhost:3000/?sessionId=<uuid>&userId=<user>`

**Note:** `package.json` `main` field says `index.js` but `npm start` runs `server.js` — ignore the `main` field.

## Stack

- Node.js / Express (no TypeScript, no bundler)
- **No test runner, no linter** — do not run `npm test` or lint commands
- `npm start` and `npm run dev` are identical (`node server.js`, no nodemon)

## Architecture

- **`server.js`** — Express entry point; wires two independent `PanoptoClient` singletons (one for routes, one inside `AttendanceEngine`). Each has its **own OAuth token cache** — tokens are not shared.
- **`src/panopto.js`** — `PanoptoClient` with in-memory token cache (refreshed 60s before expiry).
- **`src/attendance.js`** — `AttendanceEngine` with per-session polling loops stored in a `Map<sessionId, Map<userId, record>>`.
- **`public/index.html`** — Vanilla JS frontend, reads `sessionId`/`userId` from URL query params.

## Key Behavioral Facts

- **Attendance is judged on `maxPercent`** (running maximum), not the latest API snapshot.
- **Sticky attendance**: once `isAttended` becomes true it is never reverted, even if later API calls show lower percentage.
- **Resume detection**: `resumeCount` increments when `ViewPercentage` drops >2% below the previous max (treated as a new viewing session).
- **`resumeCount` is only meaningful after polling starts.** The direct Panopto API fallback (when polling has never been started) hardcodes `resumeCount: 0`.
- **State is process-local.** Restarting the server wipes all attendance records, OAuth tokens, and polling intervals.
- **No route authentication.** Treat `userId` from query/session as untrusted input.

## Korean Conventions

- Comments and user-facing strings are in Korean. Preserve Korean when editing existing code; English is fine for net-new internal code.
