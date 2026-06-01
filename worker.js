/**
 * Floorzap HubSpot Proxy Worker
 *
 * Required Cloudflare secrets (set via `wrangler secret put`):
 *   HUBSPOT_API_KEY   — HubSpot private app access token
 *   SUPABASE_URL      — e.g. https://abszmmrjaxqpnjomfbxd.supabase.co
 *   SUPABASE_ANON_KEY — Supabase anon/public key
 *
 * Usage: GET https://<worker-url>?c=<client_id>
 */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

    const url = new URL(request.url);
    const clientId = url.searchParams.get('c');

    if (!clientId) {
      return new Response(JSON.stringify({ error: 'Missing ?c= param', meetings: [] }), {
        status: 400,
        headers: CORS,
      });
    }

    // 1. Look up hubspot_ticket_id from Supabase
    let ticketId;
    try {
      const sbRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=hubspot_ticket_id`,
        {
          headers: {
            apikey: env.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
          },
        }
      );
      const rows = await sbRes.json();
      ticketId = rows?.[0]?.hubspot_ticket_id;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Supabase lookup failed', meetings: [] }), {
        headers: CORS,
      });
    }

    if (!ticketId) {
      return new Response(JSON.stringify({ meetings: [] }), { headers: CORS });
    }

    // 2. Fetch ticket properties from HubSpot
    const PROPS = [
      'floorzap_url',
      'initial_onboarding_meeting',
      'n2_week_check_in_meeting',
      'integrations_meeting',
      'graduation_meeting',
    ].join(',');

    let p;
    try {
      const hsRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}?properties=${PROPS}`,
        { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }
      );
      if (!hsRes.ok) {
        return new Response(JSON.stringify({ error: 'HubSpot API error', meetings: [] }), {
          headers: CORS,
        });
      }
      const hsData = await hsRes.json();
      p = hsData.properties || {};
    } catch (e) {
      return new Response(JSON.stringify({ error: 'HubSpot fetch failed', meetings: [] }), {
        headers: CORS,
      });
    }

    return new Response(
      JSON.stringify({
        floorzap_url: p.floorzap_url ?? null,
        meetings: [
          { title: 'Kickoff Meeting',    date: p.initial_onboarding_meeting  ? fmtDate(p.initial_onboarding_meeting)  : null },
          { title: '2-Week Check-in',    date: p.n2_week_check_in_meeting    ? fmtDate(p.n2_week_check_in_meeting)    : null },
          { title: 'Integrations',       date: p.integrations_meeting        ? fmtDate(p.integrations_meeting)        : null },
          { title: 'Graduation Meeting', date: p.graduation_meeting          ? fmtDate(p.graduation_meeting)          : null },
        ],
      }),
      { headers: CORS }
    );
  },
};

/**
 * HubSpot sends datetime properties as Unix ms timestamps (e.g. "1748476800000")
 * and date-only properties as "YYYY-MM-DD" strings.
 */
function fmtDate(val) {
  if (!val) return '';
  const num = Number(val);
  const d = !isNaN(num) && num > 0 ? new Date(num) : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
