# Migration History

All 65 migrations, applied in order directly against the live Supabase project and tracked automatically by Supabase's migration system. This is the real build order, bug fixes included, not a cleaned-up version of events.

| # | Migration |
|---|---|
| 1 | enable_extensions |
| 2 | profiles_and_signup_trigger |
| 3 | games_and_badges |
| 4 | teams |
| 5 | trivia_tables |
| 6 | tournaments |
| 7 | tracker_sessions |
| 8 | streams_announcements_forums |
| 9 | pages_and_settings |
| 10 | storage_bucket_for_media |
| 11 | seed_reference_data |
| 12 | seed_owner_admin |
| 13 | seed_sample_content |
| 14 | email_lookup_for_login |
| 15 | allow_self_service_tier_upgrade |
| 16 | tighten_security_advisories |
| 17 | update_owner_admin_email |
| 18 | admin_audit_log |
| 19 | popup_and_slides |
| 20 | fix_site_popup_audit_trigger |
| 21 | more_editable_content_keys |
| 22 | granular_roles_and_permissions |
| 23 | audit_roles_and_profile_tracking |
| 24 | gate_profile_privileges_by_permission |
| 25 | rich_announcement_system |
| 26 | login_history_rpc |
| 27 | simplify_login_history_rpc_v2 |
| 28 | footer_and_theme_settings |
| 29 | live_streams_system |
| 30 | contact_messages |
| 31 | account_verification_system |
| 32 | add_games_id_column |
| 33 | games_hub_system |
| 34 | push_notifications_system |
| 35 | chat_system |
| 36 | creator_integration_system |
| 37 | credits_and_partners_system |
| 38 | admin_search_users_rpc |
| 39 | nn_user_id_system_fix |
| 40 | nn_user_id_column_and_backfill |
| 41 | fix_admin_search_regex |
| 42 | partner_system_schema |
| 43 | partner_system_rls |
| 44 | partner_assignment_rpcs |
| 45 | partner_page_views_and_team |
| 46 | partner_list_team_rpc |
| 47 | events_entry_fee |
| 48 | gallery_system |
| 49 | broadcast_and_popup_targeting |
| 50 | enable_scheduling |
| 51 | fix_scheduled_broadcasts_secret |
| 52 | community_content_system |
| 53 | remove_unrequested_onsite_likes |
| 54 | community_content_moderation_rpc |
| 55 | schedule_content_stats_refresh |
| 56 | competition_team_registration_system |
| 57 | competition_team_rpcs_part1 |
| 58 | competition_team_rpcs_part2 |
| 59 | competition_banner |
| 60 | fix_create_team_error_message |
| 61 | per_member_fields_system |
| 62 | stripe_payment_schema |
| 63 | **fix_competition_team_rls_recursion** — found via live testing, not code review: two RLS policies checking each other in a circular loop |
| 64 | **fix_all_rls_recursion_bugs** — same bug pattern found repeated 8 times across the chat/community/calls system, fixed in one pass after a full-schema audit |
| 65 | merge_tournaments_into_competitions_schema |
| 66 | partner_nav_banner |
| 67 | social_media_links_system |

Entries 63–64 are worth calling out specifically: they were found by actually simulating real user actions against the live database (creating a team, sending an invite, accepting it) rather than by reading the code, after a feature appeared to work in review but silently failed in practice. A full-schema regex sweep afterward caught the same mistake repeated in unrelated systems built earlier.
