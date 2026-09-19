// NIT Nation — send-announcement-push
//
// This is the ONLY place VAPID private keys and the Supabase service role
// key are used. Both are read from environment secrets (never from the
// request body, never shipped to the frontend).
//
// Flow (matches the required architecture):
//   Admin clicks "Publish" (or the scheduler triggers it automatically)
//     -> this function verifies the caller is an admin OR carries the
//        correct internal cron secret (server-side, not just a hidden button)
//     -> resolves the actual target audience (everyone / a game's users /
//        an event's registrants / a tournament's entrants / a hand-picked
//        list) via the resolve_target_user_ids() DB function, so "who
//        counts as targeted" lives in one place, not duplicated here
//     -> fans out to those users' Notification Centre
//     -> sends a real Web Push to each of their stored push_subscriptions
//     -> cleans up subscriptions the push service reports as gone (410/404)
//     -> records subscriber_count / delivered_count for basic delivery info
//
// Deploy:
//   supabase functions deploy send-announcement-push
//
// Secrets (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com CRON_SECRET=<any random string>
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already provided automatically to every Edge Function)
//
// Generate a VAPID key pair (one-time, do this locally, not in the function):
//   npx web-push generate-vapid-keys
//   -> put the public key in your frontend as VAPID_PUBLIC_KEY, and both keys into the secrets above.
//
// CRON_SECRET is what lets the pg_cron scheduled job trigger a send with
// no user logged in — it's a shared secret only the DB job and this
// function know, checked via the x-cron-secret header, and it's the ONLY
// way to skip the admin-JWT check below. Anyone without it still needs a
// real admin session, same as before.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { announcement_id } = await req.json();
    if (!announcement_id) {
      return new Response(JSON.stringify({ error: "announcement_id is required" }), { status: 400, headers: corsHeaders });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Two ways to be allowed to trigger a send: a real admin session, or
    // the internal cron secret (used only by the scheduled-send job).
    const isCronTrigger = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
    if (!isCronTrigger) {
      const authHeader = req.headers.get("Authorization") || "";
      const supabaseAsCaller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error: userErr } = await supabaseAsCaller.auth.getUser();
      if (userErr || !user) {
        return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: corsHeaders });
      }
      const { data: profile, error: profileErr } = await admin.from("profiles").select("role").eq("id", user.id).single();
      if (profileErr || !profile || profile.role !== "admin") {
        return new Response(JSON.stringify({ error: "Admin permission required." }), { status: 403, headers: corsHeaders });
      }
    }

    const { data: announcement, error: annErr } = await admin
      .from("push_announcements")
      .select("*")
      .eq("id", announcement_id)
      .single();
    if (annErr || !announcement) {
      return new Response(JSON.stringify({ error: "Announcement not found." }), { status: 404, headers: corsHeaders });
    }

    // 1. Resolve the actual target audience, then fan out to their
    //    Notification Centre. (Denormalized copy of the text, per the
    //    migration's comments — editing/deleting the source later won't
    //    rewrite notifications already delivered.)
    const { data: targetUsers, error: targetErr } = await admin.rpc("resolve_target_user_ids", {
      p_target_type: announcement.target_type || "everyone",
      p_target_value: announcement.target_value || {},
    });
    if (targetErr) throw new Error(targetErr.message);
    const targetUserIds = new Set((targetUsers || []).map((r: { user_id: string }) => r.user_id));

    const notificationRows = Array.from(targetUserIds).map((uid) => ({
      user_id: uid,
      announcement_id: announcement.id,
      title: announcement.title,
      message: announcement.message,
      image_url: announcement.image_url,
      category: announcement.category,
      target_url: announcement.target_url,
    }));
    if (notificationRows.length) {
      // upsert + ignoreDuplicates relies on the unique (user_id, announcement_id)
      // index from the migration, so re-running a publish never double-delivers.
      const { error: insErr } = await admin
        .from("user_notifications")
        .upsert(notificationRows, { onConflict: "user_id,announcement_id", ignoreDuplicates: true });
      if (insErr) throw new Error(insErr.message);
    }

    // 2. Send real browser push notifications, but only to subscriptions
    //    belonging to the resolved target audience.
    const { data: allSubs, error: subsErr } = await admin.from("push_subscriptions").select("*");
    if (subsErr) throw new Error(subsErr.message);
    const subs = (allSubs || []).filter((s) => targetUserIds.has(s.user_id));

    const payload = JSON.stringify({
      title: announcement.title,
      message: announcement.message,
      image_url: announcement.image_url,
      target_url: announcement.target_url || "/",
      announcement_id: announcement.id,
    });

    let delivered = 0;
    const deadSubscriptionIds: number[] = [];

    await Promise.all(
      (subs || []).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            payload
          );
          delivered++;
        } catch (err) {
          const status = err?.statusCode;
          if (status === 404 || status === 410) {
            // The push service confirms this subscription no longer exists — clean it up.
            deadSubscriptionIds.push(sub.id);
          }
          // Any other failure (network blip, provider hiccup) is logged and skipped —
          // one failed delivery must never break the rest of the announcement send.
          console.error(`Push failed for subscription ${sub.id}:`, status || err?.message || err);
        }
      })
    );

    if (deadSubscriptionIds.length) {
      await admin.from("push_subscriptions").delete().in("id", deadSubscriptionIds);
    }

    // 3. Mark published + record basic delivery info.
    await admin
      .from("push_announcements")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        subscriber_count: (subs || []).length,
        delivered_count: delivered,
      })
      .eq("id", announcement.id);

    return new Response(
      JSON.stringify({
        ok: true,
        notified_users: notificationRows.length,
        subscriber_count: (subs || []).length,
        delivered_count: delivered,
        cleaned_up_subscriptions: deadSubscriptionIds.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), { status: 500, headers: corsHeaders });
  }
});
