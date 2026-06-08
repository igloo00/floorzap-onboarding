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
    const zoomByTitle = {}; // slot key -> zoom url (title-based match)
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
              `https://api.hubapi.com/crm/v3/objects/meetings/${id}?properties=hs_meeting_body,hs_timestamp,hs_meeting_title`,
              { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }
            ).then(r => r.ok ? r.json() : null).catch(() => null)
          )
        );
        const zoomRe = /https:\/\/[a-z0-9.-]*zoom\.us\/j\/[^\s\n"<>]+/i;

        // Title keyword → slot key
        const titleKeywords = [
          { key: 'kickoff',      words: ['kickoff', 'kick-off', 'initial onboarding'] },
          { key: 'checkin',      words: ['2-week', '2 week', 'check-in', 'check in', 'checkin'] },
          { key: 'integrations', words: ['integration'] },
          { key: 'graduation',   words: ['graduation'] },
        ];

        for (const m of details) {
          if (!m?.properties) continue;
          const body = m.properties.hs_meeting_body || '';
          const title = (m.properties.hs_meeting_title || '').toLowerCase();
          const match = body.match(zoomRe);
          if (!match) continue;
          const zoomUrl = match[0];

          // 1. Try title-based match first (most reliable)
          let matched = false;
          for (const { key, words } of titleKeywords) {
            if (words.some(w => title.includes(w))) {
              if (!zoomByTitle[key]) zoomByTitle[key] = zoomUrl; // first match wins
              matched = true;
              break;
            }
          }

          // 2. Also store by date for fallback
          if (!matched) {
            const ts = Number(m.properties.hs_timestamp);
            if (ts) {
              const dayKey = new Date(ts).toISOString().split('T')[0];
              zoomByDay[dayKey] = zoomUrl;
            }
          } else {
            const ts = Number(m.properties.hs_timestamp);
            if (ts) {
              const dayKey = new Date(ts).toISOString().split('T')[0];
              zoomByDay[dayKey] = zoomUrl;
            }
          }
        }
      }
    } catch (_) {
      // Zoom enrichment is best-effort; continue without it
    }

    // 4. Fetch last contact date from notes, calls, and emails on this ticket
    let lastContactedIso = null;
    try {
      const [notesRes, callsRes, emailsRes] = await Promise.all([
        fetch(`https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/notes`,
          { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }),
        fetch(`https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/calls`,
          { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }),
        fetch(`https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/emails`,
          { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }),
      ]);
      const [notesData, callsData, emailsData] = await Promise.all([
        notesRes.ok ? notesRes.json() : { results: [] },
        callsRes.ok ? callsRes.json() : { results: [] },
        emailsRes.ok ? emailsRes.json() : { results: [] },
      ]);

      const engagements = [
        ...(notesData.results  || []).map(r => ({ id: r.id, type: 'notes'  })),
        ...(callsData.results  || []).map(r => ({ id: r.id, type: 'calls'  })),
        ...(emailsData.results || []).map(r => ({ id: r.id, type: 'emails' })),
      ].slice(0, 15);

      const engDetails = await Promise.all(
        engagements.map(({ id, type }) =>
          fetch(`https://api.hubapi.com/crm/v3/objects/${type}/${id}?properties=hs_timestamp`,
            { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } })
            .then(r => r.ok ? r.json() : null).catch(() => null)
        )
      );

      let maxTs = 0;
      for (const d of engDetails) {
        const ts = Number(d?.properties?.hs_timestamp);
        if (!isNaN(ts) && ts > maxTs) maxTs = ts;
      }
      if (maxTs > 0) lastContactedIso = new Date(maxTs).toISOString().split('T')[0];
    } catch (_) {
      // Last contact enrichment is best-effort
    }

    // Find the Zoom link — title match first, then date fallback (±2 days)
    function getZoom(slotKey, isoDateVal) {
      // 1. Title-based match
      if (zoomByTitle[slotKey]) return zoomByTitle[slotKey];
      // 2. Date-based fallback
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
        last_contacted: lastContactedIso,
        meetings: [
          { title: 'Kickoff Meeting',    date: p.initial_onboarding_meeting  ? fmtDate(p.initial_onboarding_meeting)  : null, isoDate: p.initial_onboarding_meeting  || null, zoom: getZoom('kickoff',      p.initial_onboarding_meeting) },
          { title: '2-Week Check-in',    date: p.n2_week_check_in_meeting    ? fmtDate(p.n2_week_check_in_meeting)    : null, isoDate: p.n2_week_check_in_meeting    || null, zoom: getZoom('checkin',      p.n2_week_check_in_meeting) },
          { title: 'Integrations',       date: p.integrations_meeting        ? fmtDate(p.integrations_meeting)        : null, isoDate: p.integrations_meeting        || null, zoom: getZoom('integrations', p.integrations_meeting) },
          { title: 'Graduation Meeting', date: p.graduation_meeting          ? fmtDate(p.graduation_meeting)          : null, isoDate: p.graduation_meeting          || null, zoom: getZoom('graduation',   p.graduation_meeting) },
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
