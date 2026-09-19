// Verifies a Google Identity Services ID token server-side, then creates
// the event registration — atomically, so a registration can never exist
// without having passed verification (there's no client INSERT policy on
// event_registrations at all; this function, using the service role, is
// the only path).
//
// This is intentionally a SEPARATE, simpler flow from the account-
// verification system (which uses supabase.auth.linkIdentity()). This one
// doesn't touch the user's Supabase Auth identity at all — it's a one-off
// verification that a specific Google account (identified by its stable
// `sub`, never by the email alone) is the one completing this specific
// registration. The user must still be logged into NIT Nation normally;
// this function requires that session and just adds a Google-verified
// stamp on top of it.
//
// Deploy: supabase functions deploy verify-google-registration
// Secrets: supabase secrets set GOOGLE_CLIENT_ID=...
//   (this is the SAME Web application OAuth Client ID already used
//   elsewhere — Google Identity Services' Sign-In-With-Google button
//   uses the same client_id type as the OAuth flows already set up.)

import { corsHeaders, getAdminClient, getCallerClient } from "../_shared/supabase-clients.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!GOOGLE_CLIENT_ID) {
      return new Response(JSON.stringify({ error: "GOOGLE_CLIENT_ID secret is not set yet — run: supabase secrets set GOOGLE_CLIENT_ID=..." }), { status: 500, headers: corsHeaders });
    }

    const { event_id, id_token, participant_name, responses } = await req.json();
    if (!event_id || !id_token || !participant_name) {
      return new Response(JSON.stringify({ error: "event_id, id_token, and participant_name are required." }), { status: 400, headers: corsHeaders });
    }

    // The user must be logged into NIT Nation normally — Google here only
    // proves the registrant's email ownership, it never replaces this.
    const caller = getCallerClient(req);
    const { data: { user }, error: userErr } = await caller.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "You must be signed in to NIT Nation to register." }), { status: 401, headers: corsHeaders });
    }

    // ---- Server-side Google ID token validation ----
    // Uses Google's own tokeninfo endpoint, which validates the token's
    // cryptographic signature at Google and returns the decoded claims —
    // this is Google's officially documented validation path. (For very
    // high registration volume, Google recommends caching their JWKS and
    // verifying signatures locally instead of calling this endpoint per
    // request; at NIT Nation's scale, the tokeninfo endpoint is the
    // simpler, still-fully-server-side-verified option.)
    const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`);
    if (!tokenInfoRes.ok) {
      return new Response(JSON.stringify({ error: "Google could not verify that credential — try again." }), { status: 400, headers: corsHeaders });
    }
    const claims = await tokenInfoRes.json();

    if (claims.aud !== GOOGLE_CLIENT_ID) {
      return new Response(JSON.stringify({ error: "Invalid verification token (audience mismatch)." }), { status: 400, headers: corsHeaders });
    }
    if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") {
      return new Response(JSON.stringify({ error: "Invalid verification token (issuer mismatch)." }), { status: 400, headers: corsHeaders });
    }
    if (!claims.exp || Number(claims.exp) * 1000 < Date.now()) {
      return new Response(JSON.stringify({ error: "That Google verification expired — please try again." }), { status: 400, headers: corsHeaders });
    }
    if (claims.email_verified !== "true" && claims.email_verified !== true) {
      return new Response(JSON.stringify({ error: "Your Google account's email isn't verified with Google." }), { status: 400, headers: corsHeaders });
    }

    const googleSub = claims.sub;   // stable identifier — used for the uniqueness check, never the email
    const googleEmail = claims.email;
    if (!googleSub || !googleEmail) {
      return new Response(JSON.stringify({ error: "Google didn't return the expected account information." }), { status: 400, headers: corsHeaders });
    }

    const admin = getAdminClient();

    const { data: event, error: eventErr } = await admin.from("events").select("*").eq("id", event_id).single();
    if (eventErr || !event) {
      return new Response(JSON.stringify({ error: "Event not found." }), { status: 404, headers: corsHeaders });
    }
    if (event.status === "cancelled" || event.status === "completed") {
      return new Response(JSON.stringify({ error: "Registration is not open for this event." }), { status: 400, headers: corsHeaders });
    }
    const now = new Date();
    if (event.registration_start && now < new Date(event.registration_start)) {
      return new Response(JSON.stringify({ error: "Registration hasn't opened yet for this event." }), { status: 400, headers: corsHeaders });
    }
    if (event.registration_end && now > new Date(event.registration_end)) {
      return new Response(JSON.stringify({ error: "Registration has closed for this event." }), { status: 400, headers: corsHeaders });
    }

    // Duplicate check — friendly message first; the two UNIQUE constraints
    // on event_registrations are the real, unbypassable backstop even if
    // this check is somehow raced.
    if (!event.allow_duplicate_registration) {
      const { data: existing } = await admin
        .from("event_registrations")
        .select("id")
        .eq("event_id", event_id)
        .or(`google_sub.eq.${googleSub},user_id.eq.${user.id}`)
        .limit(1);
      if (existing && existing.length) {
        return new Response(JSON.stringify({ error: "You are already registered for this event." }), { status: 409, headers: corsHeaders });
      }
    }

    // Capacity check.
    if (event.max_registrations) {
      const { count } = await admin.from("event_registrations").select("id", { count: "exact", head: true }).eq("event_id", event_id);
      if ((count || 0) >= event.max_registrations) {
        return new Response(JSON.stringify({ error: "Registration Full" }), { status: 400, headers: corsHeaders });
      }
    }

    // Required-field check against the event's form, if one exists.
    const { data: form } = await admin.from("event_forms").select("id").eq("event_id", event_id).maybeSingle();
    if (form) {
      const { data: fields } = await admin.from("event_form_fields").select("*").eq("form_id", form.id).eq("required", true);
      for (const f of fields || []) {
        const val = responses?.[f.id];
        if (val === undefined || val === null || val === "") {
          return new Response(JSON.stringify({ error: `"${f.label}" is required.` }), { status: 400, headers: corsHeaders });
        }
      }
    }

    const registrationCode = `REG-${crypto.randomUUID().split("-")[0].toUpperCase()}`;

    const { data: registration, error: insertErr } = await admin
      .from("event_registrations")
      .insert({
        event_id, form_id: form?.id || null, user_id: user.id,
        participant_name, google_sub: googleSub, google_email: googleEmail,
        google_email_verified: true, responses: responses || {},
        registration_code: registrationCode,
      })
      .select()
      .single();

    if (insertErr) {
      // The UNIQUE constraints are the final backstop against a race
      // between the check above and this insert.
      if (insertErr.code === "23505") {
        return new Response(JSON.stringify({ error: "You are already registered for this event." }), { status: 409, headers: corsHeaders });
      }
      throw new Error(insertErr.message);
    }

    return new Response(JSON.stringify({
      ok: true,
      registration: {
        id: registration.id,
        registration_code: registration.registration_code,
        event_name: event.name,
        participant_name: registration.participant_name,
        verified_email: registration.google_email,
        created_at: registration.created_at,
        event_date: event.event_date,
        discord_link: event.discord_link,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), { status: 500, headers: corsHeaders });
  }
});
