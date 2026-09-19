# Database Schema Reference

This project's schema lives entirely in Supabase (Postgres). It was built incrementally across **65 tracked migrations** (see the full list in `docs/MIGRATION_HISTORY.md`), rather than written all at once, so this file documents the **current, final state** of every table rather than replaying each historical step.

80 tables total, grouped by feature area below. Every table has Row Level Security enabled; policies are enforced server-side, not just hidden in the UI.

## Auth & Identity
`profiles`, `roles`, `permissions`, `role_permissions`, `user_badges`, `badges`, `verification_attempts`

Every account gets an auto-generated unique "Special ID" (`nn_id`, e.g. `NN0042`) on signup via a Postgres trigger, used for privacy-safe user lookup (e.g. team invites) without exposing email addresses.

## Games Hub
`games`, `game_sections`, `game_categories`, `game_images`, `game_videos`, `user_games`

## Tournaments & Competitions (unified system)
`competitions`, `competition_teams`, `competition_team_members`, `tournaments`, `tournament_entries`

A single admin-configurable system: `team_size = 1` yields a simple one-click entry, `team_size > 1` unlocks a full invite-and-accept team-building workflow with admin review. Originally two separate systems; merged into one schema, migrating live production data across (0 data loss, verified against real rows).

## Partners
`partners`, `partner_members`, `partner_gallery`, `partner_page_views`, `partner_announcements`, `events`, `event_forms`, `event_form_fields`, `event_sections`, `event_registrations`

## Chat & Social
`conversations`, `conversation_members`, `messages`, `message_attachments`, `message_reactions`, `friendships`, `friend_requests`, `user_blocks`, `communities`, `community_members`, `channels`, `call_sessions`, `call_participants`, `reports`, `moderation_actions`

## Community Content (user-submitted video/clips)
`community_content` — YouTube/Twitch links only, never re-hosted video files. View/like counts are pulled live from the real platform APIs on a schedule (`pg_cron`), never faked.

## Progression & Credits
`credit_transactions`, `trivia_questions`, `trivia_responses`, `teams`, `team_members`, `team_badges`

## Live Streaming
`live_streams`, `live_stream_signals`, `stream_sessions`, `stream_analytics_snapshots`, `stream_likes`, `streams`, `creator_connections`, `creator_connections_public`, `tracker_sessions`, `tracker_signals`

## Admin, Content & Notifications
`admin_audit_log`, `pages`, `slides`, `site_settings`, `site_announcements`, `announcement_dismissals`, `announcements`, `push_announcements`, `push_subscriptions`, `user_notifications`, `gallery_images`, `social_media_links`, `contact_messages`, `forum_categories`, `forum_threads`, `forum_replies`

## Payments (schema ready, gateway integration pending)
`event_registrations` carries `payment_status`, `stripe_session_id`, `stripe_payment_intent_id`, `amount_paid_cents` — the schema and planned Stripe Checkout flow are designed, but the Edge Functions and webhook handler are not yet built.

---

For exact column types, query `information_schema.columns` against the live project, or see the full migration history for the literal SQL of each change.
