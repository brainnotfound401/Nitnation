# NIT Nation

A full gaming community platform: tournaments and team-based competitions, live chat, a partner ecosystem, user-submitted video content, and a full admin backend. Single-page app on the frontend, Supabase (Postgres + Auth + Storage + Realtime + Edge Functions) on the backend.

Live-tested throughout development by actually running real actions against the database as different users, not just reading the code. This caught real bugs, including a set of RLS policy recursion issues that code review alone did not catch. Details in `docs/MIGRATION_HISTORY.md`.

## Tech stack

- **Frontend:** single `index.html` file, vanilla JS, no build step
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime, Edge Functions, pg_cron)
- **Payments (schema ready, not yet wired to a gateway):** Stripe
- **Push notifications:** Web Push API with VAPID keys
- **Video integration:** official YouTube Data API and Twitch Helix API (no re-hosted video, ever)

## Features

**Accounts & identity**
Email/password auth, Google account verification, auto-generated unique "Special ID" per user (`NN0001`, `NN0002`, ...) used for privacy-safe lookups like team invites.

**Games Hub**
Per-game pages with sections, screenshots, videos, and related-game links, all admin-managed.

**Tournaments & Competitions**
One unified system. Admin sets a team size per event: `1` means a simple one-click entry, anything higher unlocks a full invite-and-accept team workflow (captain invites teammates by Special ID, they accept or deny, the roster auto-progresses to admin review once full, admin approves or denies with a reason). Custom registration questions, both team-level and per-teammate, are admin-configurable per competition.

**Partners**
Companies get their own branded page (banner, gallery, upcoming events, social links), a partner dashboard (page view analytics, team management, event creation), and can optionally co-brand the site's own top nav bar while a visitor is on their page specifically.

**Chat**
Direct messages and group conversations, friend requests, blocking, real-time delivery, push notifications on new messages.

**Community Content**
Users submit YouTube/Twitch links (never files). Admin moderates before anything goes public. View and like counts are pulled from the real platform APIs on a schedule, never faked or estimated.

**Admin panel**
Games, tournaments/competitions, partners, events, gallery, community content moderation, credits, push broadcasts (audience-targeted: everyone, a specific game's players, an event's registrants, or hand-picked users), site-wide popups/banners, roles and permissions, audit log.

**Share links**
A competition or tournament can be shared as a direct link. Opening it takes a new visitor straight to sign-in, then straight into that specific application form, not the homepage.

## Project structure

```
index.html                   the entire frontend
sw.js                        service worker for push notifications
supabase/functions/          Edge Functions (Deno)
supabase/migrations/         early SQL migrations (see note below)
docs/SCHEMA.md               current database schema, by feature area
docs/MIGRATION_HISTORY.md    all 65 migrations in order, as actually applied
```

**Note on migrations:** Supabase tracks every migration applied to this project, but most of them (everything after the first ~15) were applied directly against the live project through the Supabase MCP tool during development, not saved as local `.sql` files as I went. `docs/MIGRATION_HISTORY.md` lists all 65 in order. `docs/SCHEMA.md` documents the current, final state of all 80 tables, which is more useful than replaying every historical step if you're trying to understand or rebuild this.

## Edge Functions

| Function | Purpose |
|---|---|
| `verify-google-registration` | Verifies a Google ID token server-side and creates an event registration |
| `send-announcement-push` | Sends targeted push notifications, supports scheduled sends via `pg_cron` |
| `refresh-content-stats` | Pulls real view/like counts from YouTube and Twitch APIs |
| `pull-stream-analytics` | Pulls stream analytics from connected platforms |
| `admin-delete-user` | Admin-only account deletion |
| `youtube-oauth-start` / `youtube-oauth-callback` | YouTube account linking |
| `twitch-oauth-start` / `twitch-oauth-callback` | Twitch account linking |

## Running this yourself

1. Create a Supabase project.
2. Apply the schema. The cleanest path is `docs/SCHEMA.md` as a reference and writing fresh `CREATE TABLE` statements from it, since the historical migrations include several iterative fixes not meant to be replayed as-is.
3. Deploy the Edge Functions in `supabase/functions/`.
4. Set the required secrets in your Supabase project (Edge Functions → Secrets):
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (push notifications)
   - `GOOGLE_CLIENT_ID` (event registration verification)
   - `YOUTUBE_API_KEY` (community content stats)
   - `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (Twitch integration and stats)
   - `CRON_SECRET` (a random string, shared between the database's scheduled jobs and the Edge Functions they call)
5. Update the Supabase URL and anon key near the top of `index.html`.
6. Serve `index.html` as a static file. No build step.

## What I'd do differently

This was built iteratively over a long session, feature by feature, based on direct requests rather than a spec written up front. A few things I'd do differently starting from scratch:
- Write RLS policies more carefully the first time. The recursion bugs (see migration 63/64) all came from the same copy-pasted pattern used across three unrelated features.
- Decide on the tournaments/competitions data model up front instead of merging two systems together after the fact.
- Break `index.html` into modules. It works, but a 600KB+ single file is not how I'd structure this for a team.
