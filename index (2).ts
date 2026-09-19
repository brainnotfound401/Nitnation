// NIT Nation — refresh-content-stats
//
// Pulls REAL view/like counts from YouTube's Data API and Twitch's Helix
// API for user-submitted community content. Never fakes or estimates a
// number — if a platform doesn't expose a stat (Twitch clips/videos have
// no public like count, and YouTube creators can hide their like count),
// that field is just left null and the frontend hides it rather than
// showing a wrong number.
//
// Two ways to call this:
//   { content_id: 123 }  -> refreshes just that one row (used right after
//                           a user submits, and from the admin panel)
//   { all: true }        -> refreshes every approved row whose stats are
//                           more than 6 hours old (used by the pg_cron job)
// Both require either a real admin session OR the shared x-cron-secret
// header (same pattern as send-announcement-push) — a normal user can
// never trigger a refresh for content that isn't theirs.
//
// Deploy: supabase functions deploy refresh-content-stats
// Secrets needed (TWITCH_CLIENT_ID/SECRET already exist from Creator
// Integration and are reused here — only YOUTUBE_API_KEY is new):
//   supabase secrets set YOUTUBE_API_KEY=... CRON_SECRET=<same value as send-announcement-push>
//   (YOUTUBE_API_KEY is a plain API key restricted to "YouTube Data API v3"
//   in Google Cloud Console -> Credentials -> Create Credentials -> API key.
//   This is NOT the OAuth Client ID/Secret used elsewhere — public stats
//   only need a simple key, not user consent.)

import { corsHeaders, getAdminClient, getCallerClient } from "../_shared/supabase-clients.ts";

const YOUTUBE_API_KEY = Deno.env.get("YOUTUBE_API_KEY") || "";
const TWITCH_CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") || "";
const TWITCH_CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

let cachedTwitchToken: { token: string; expiresAt: number } | null = null;
async function getTwitchAppToken(): Promise<string | null> {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  if (cachedTwitchToken && cachedTwitchToken.expiresAt > Date.now() + 60_000) return cachedTwitchToken.token;
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  cachedTwitchToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedTwitchToken.token;
}

async function fetchYoutubeStats(externalId: string) {
  if (!YOUTUBE_API_KEY) return null;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${externalId}&part=statistics,snippet&key=${YOUTUBE_API_KEY}`);
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;
  return {
    views: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
    // YouTube creators can hide their like count entirely — when that
    // happens the API just omits likeCount, so this stays null, not 0.
    likes: item.statistics?.likeCount ? Number(item.statistics.likeCount) : null,
    thumbnail_url: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
    published_at: item.snippet?.publishedAt || null,
  };
}
async function fetchTwitchClipStats(externalId: string, token: string) {
  const res = await fetch(`https://api.twitch.tv/helix/clips?id=${externalId}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.data?.[0];
  if (!item) return null;
  // Twitch's public API doesn't expose a like count for clips at all —
  // left null rather than guessed.
  return { views: item.view_count ?? null, likes: null, thumbnail_url: item.thumbnail_url || null, published_at: item.created_at || null };
}
async function fetchTwitchVideoStats(externalId: string, token: string) {
  const res = await fetch(`https://api.twitch.tv/helix/videos?id=${externalId}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.data?.[0];
  if (!item) return null;
  return { views: item.view_count ?? null, likes: null, thumbnail_url: item.thumbnail_url?.replace("%{width}", "480").replace("%{height}", "270") || null, published_at: item.published_at || item.created_at || null };
}

async function refreshOne(admin: ReturnType<typeof getAdminClient>, row: any) {
  let stats = null;
  if (row.platform === "youtube" || row.platform === "youtube_shorts") {
    stats = await fetchYoutubeStats(row.external_id);
  } else if (row.platform === "twitch_clip" || row.platform === "twitch_video") {
    const token = await getTwitchAppToken();
    if (token) stats = row.platform === "twitch_clip" ? await fetchTwitchClipStats(row.external_id, token) : await fetchTwitchVideoStats(row.external_id, token);
  }
  if (!stats) return false;
  const update: Record<string, unknown> = { stats_fetched_at: new Date().toISOString() };
  if (stats.views !== null) update.views = stats.views;
  if (stats.likes !== null) update.likes = stats.likes;
  if (stats.thumbnail_url && !row.thumbnail_url) update.thumbnail_url = stats.thumbnail_url; // don't clobber an admin-set custom thumbnail
  if (stats.published_at) update.published_at = stats.published_at;
  await admin.from("community_content").update(update).eq("id", row.id);
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { content_id, all } = await req.json();
    const admin = getAdminClient();

    const isCronTrigger = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
    if (!isCronTrigger) {
      const caller = getCallerClient(req);
      const { data: { user }, error: userErr } = await caller.auth.getUser();
      if (userErr || !user) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: corsHeaders });
      // A user refreshing their OWN submission's stats is fine; anything
      // broader (all:true, or someone else's content_id) needs admin.
      if (all) {
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
        if (profile?.role !== "admin") return new Response(JSON.stringify({ error: "Admin permission required." }), { status: 403, headers: corsHeaders });
      } else if (content_id) {
        const { data: row } = await admin.from("community_content").select("user_id").eq("id", content_id).single();
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
        if (!row || (row.user_id !== user.id && profile?.role !== "admin")) {
          return new Response(JSON.stringify({ error: "Not your content." }), { status: 403, headers: corsHeaders });
        }
      }
    }

    if (content_id) {
      const { data: row, error } = await admin.from("community_content").select("*").eq("id", content_id).single();
      if (error || !row) return new Response(JSON.stringify({ error: "Content not found." }), { status: 404, headers: corsHeaders });
      const ok = await refreshOne(admin, row);
      return new Response(JSON.stringify({ ok, refreshed: ok ? 1 : 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (all) {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const { data: rows, error } = await admin
        .from("community_content")
        .select("*")
        .eq("status", "approved")
        .or(`stats_fetched_at.is.null,stats_fetched_at.lt.${sixHoursAgo}`)
        .limit(50);
      if (error) throw new Error(error.message);
      let refreshed = 0;
      for (const row of rows || []) {
        if (await refreshOne(admin, row)) refreshed++;
      }
      return new Response(JSON.stringify({ ok: true, checked: (rows || []).length, refreshed }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Provide content_id or all:true" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), { status: 500, headers: corsHeaders });
  }
});
