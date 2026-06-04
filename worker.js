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
    const directTicketId = url.searchParams.get('t');

    if (!clientId && !directTicketId) {
      return new Response(JSON.stringify({ error: 'Missing ?c= or ?t= param', meetings: [] }), {
        status: 400,
        headers: CORS,
      });
    }

    // 1. Look up hubspot_ticket_id from Supabase (skip if ?t= provided directly)
    let ticketId = directTicketId || null;
    if (!ticketId) {
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
    }

    if (!ticketId) {
      return new Response(JSON.stringify({ meetings: [] }), { headers: CORS });
    }

    // 2. Fetch ticket properties from HubSpot
    const PROPS = [
      'floorzap_url',
      'subject',
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

    // 3. Fetch associated meeting engagements to extract Zoom links from their bodies
    // zoomByDay maps "YYYY-MM-DD" -> first Zoom URL found in that meeting's body
    const zoomByDay = {};
    try {
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/meetings`,
        { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }
      );
      if (assocRes.ok) {
        const assocData = await assocRes.json();
        const meetingIds = (assocData.results || []).map(r => r.id).slice(0, 10);
        const details = await Promise.all(
          meetingIds.map(id =>
            fetch(
              `https://api.hubapi.com/crm/v3/objects/meetings/${id}?properties=hs_meeting_body,hs_timestamp`,
              { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }
            ).then(r => r.ok ? r.json() : null).catch(() => null)
          )
        );
        const zoomRe = /https:\/\/[a-z0-9.-]*zoom\.us\/j\/[^\s\n"<>]+/i;
        for (const m of details) {
          if (!m?.properties) continue;
          const ts = Number(m.properties.hs_timestamp);
          if (!ts) continue;
          const match = (m.properties.hs_meeting_body || '').match(zoomRe);
          if (match) {
            const dayKey = new Date(ts).toISOString().split('T')[0];
            zoomByDay[dayKey] = match[0];
          }
        }
      }
    } catch (_) {
      // Zoom enrichment is best-effort; continue without it
    }

    // Find the Zoom link for a ticket date property by matching within ±2 days
    function getZoom(isoDateVal) {
      if (!isoDateVal) return null;
      const num = Number(isoDateVal);
      const base = !isNaN(num) && num > 0 ? new Date(num) : new Date(isoDateVal);
      if (isNaN(base.getTime())) return null;
      for (let offset = 0; offset <= 2; offset++) {
        for (const sign of [0, 1, -1]) {
          const d = new Date(base);
          d.setUTCDate(d.getUTCDate() + sign * offset);
          const key = d.toISOString().split('T')[0];
          if (zoomByDay[key]) return zoomByDay[key];
        }
      }
      return null;
    }

    // Extract company name from "Onboarding | Company Name" format
    const rawSubject = p.subject || null;
    const clientName = rawSubject ? rawSubject.replace(/^[^|]+\|\s*/, '').trim() : null;

    return new Response(
      JSON.stringify({
        floorzap_url: p.floorzap_url ?? null,
        client_name: clientName,
        meetings: [
          { title: 'Kickoff Meeting',    date: p.initial_onboarding_meeting  ? fmtDate(p.initial_onboarding_meeting)  : null, isoDate: p.initial_onboarding_meeting  || null, zoom: getZoom(p.initial_onboarding_meeting) },
          { title: '2-Week Check-in',    date: p.n2_week_check_in_meeting    ? fmtDate(p.n2_week_check_in_meeting)    : null, isoDate: p.n2_week_check_in_meeting    || null, zoom: getZoom(p.n2_week_check_in_meeting) },
          { title: 'Integrations',       date: p.integrations_meeting        ? fmtDate(p.integrations_meeting)        : null, isoDate: p.integrations_meeting        || null, zoom: getZoom(p.integrations_meeting) },
          { title: 'Graduation Meeting', date: p.graduation_meeting          ? fmtDate(p.graduation_meeting)          : null, isoDate: p.graduation_meeting          || null, zoom: getZoom(p.graduation_meeting) },
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
