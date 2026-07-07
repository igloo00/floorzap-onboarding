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
    const debugMode = url.searchParams.get('debug') === '1';

    // Debug endpoint: ?debug=1&t=<ticketId> — traces the addon chain
    if (debugMode && directTicketId) {
      const result = await fetchHubSpotAddonsDebug(directTicketId, env);
      return new Response(JSON.stringify(result, null, 2), { headers: CORS });
    }

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
    const zoomByTitle = {};
    let meetingDetails = [];
    try {
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/meetings`,
        { headers: { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` } }
      );
      if (assocRes.ok) {
        const assocData = await assocRes.json();
        const meetingIds = (assocData.results || []).map(r => r.id).slice(0, 10);
        meetingDetails = await Promise.all(
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
          { key: 'prep_golive',  words: ['prep go-live', 'prep golive', 'pre go-live', 'pregolive', 'prep for go live', 'prep for golive'] },
          { key: 'graduation',   words: ['graduation'] },
          { key: 'post_golive',  words: ['post go-live', 'post golive', 'post-go-live', 'postgolive'] },
        ];

        for (const m of meetingDetails) {
          if (!m?.properties) continue;
          const body = m.properties.hs_meeting_body || '';
          const title = (m.properties.hs_meeting_title || '').toLowerCase();
          const ts = Number(m.properties.hs_timestamp);
          const match = body.match(zoomRe);
          const zoomUrl = match ? match[0] : null;

          // Try title-based match
          let matched = false;
          for (const { key, words } of titleKeywords) {
            if (words.some(w => title.includes(w))) {
              if (zoomUrl && !zoomByTitle[key]) zoomByTitle[key] = zoomUrl;
              matched = true;
              break;
            }
          }

          // Store by date for fallback (Zoom links only)
          if (zoomUrl && ts) {
            const dayKey = new Date(ts).toISOString().split('T')[0];
            if (!zoomByDay[dayKey]) zoomByDay[dayKey] = zoomUrl;
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

    // Build date map from engagement timestamps (authoritative — reflects rescheduling)
    // Falls back to ticket properties for the 4 legacy slots
    const dateByKey = {};
    for (const m of meetingDetails) {
      if (!m?.properties) continue;
      const title = (m.properties.hs_meeting_title || '').toLowerCase();
      const ts = Number(m.properties.hs_timestamp);
      if (!ts) continue;
      const titleKeywordsForDate = [
        { key: 'kickoff',      words: ['kickoff', 'kick-off', 'initial onboarding'] },
        { key: 'checkin',      words: ['2-week', '2 week', 'check-in', 'check in', 'checkin'] },
        { key: 'integrations', words: ['integration'] },
        { key: 'prep_golive',  words: ['prep go-live', 'prep golive', 'pre go-live', 'pregolive', 'prep for go live', 'prep for golive'] },
        { key: 'graduation',   words: ['graduation'] },
        { key: 'post_golive',  words: ['post go-live', 'post golive', 'post-go-live', 'postgolive'] },
      ];
      for (const { key, words } of titleKeywordsForDate) {
        if (words.some(w => title.includes(w)) && !dateByKey[key]) {
          dateByKey[key] = String(ts);
          break;
        }
      }
    }

    // Zoom link helper — title match first, then date fallback (±2 days)
    function getZoom(slotKey, isoDateVal) {
      if (zoomByTitle[slotKey]) return zoomByTitle[slotKey];
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

    // Resolve date for a slot: engagement timestamp wins, ticket property as fallback
    function resolveDate(key, ticketProp) {
      return dateByKey[key] || ticketProp || null;
    }

    const kickoffDate      = resolveDate('kickoff',      p.initial_onboarding_meeting);
    const checkinDate      = resolveDate('checkin',      p.n2_week_check_in_meeting);
    const integrationsDate = resolveDate('integrations', p.integrations_meeting);
    const prepGoliveDate   = resolveDate('prep_golive',  null);
    const graduationDate   = resolveDate('graduation',   p.graduation_meeting);

    // Extract company name from "Onboarding | Company Name" format
    const rawSubject = p.subject || null;
    const clientName = rawSubject ? rawSubject.replace(/^[^|]+\|\s*/, '').trim() : null;

    return new Response(
      JSON.stringify({
        floorzap_url: p.floorzap_url ?? null,
        client_name: clientName,
        last_contacted: lastContactedIso,
        has_post_golive_meeting: !!dateByKey['post_golive'],
        meetings: [
          { key: 'kickoff',      title: 'Kickoff',         date: kickoffDate      ? fmtDate(kickoffDate)      : null, isoDate: kickoffDate,      zoom: getZoom('kickoff',      kickoffDate) },
          { key: 'checkin',      title: '2-Week check-in', date: checkinDate      ? fmtDate(checkinDate)      : null, isoDate: checkinDate,      zoom: getZoom('checkin',      checkinDate) },
          { key: 'integrations', title: 'Integrations',    date: integrationsDate ? fmtDate(integrationsDate) : null, isoDate: integrationsDate, zoom: getZoom('integrations', integrationsDate) },
          { key: 'prep_golive',  title: 'Prep go-live',    date: prepGoliveDate   ? fmtDate(prepGoliveDate)   : null, isoDate: prepGoliveDate,   zoom: getZoom('prep_golive',  prepGoliveDate) },
          { key: 'graduation',   title: 'Graduation',      date: graduationDate   ? fmtDate(graduationDate)   : null, isoDate: graduationDate,   zoom: getZoom('graduation',   graduationDate) },
        ],
      }),
      { headers: CORS }
    );
  },

  /**
   * Daily cron: refresh every client's add-ons in Supabase from HubSpot line items.
   * Configured via wrangler.jsonc triggers.crons. Clients whose HubSpot lookup
   * fails (e.g. missing scope) are skipped, never overwritten with an empty list.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyAddonSync(env));
  },
};

/**
 * Read all clients from Supabase and write each one's add-ons back, sourced from
 * their HubSpot deal line items. Best-effort and safe: a client is only updated
 * when fetchHubSpotAddons returns a definite result (array), never on null.
 */
async function runDailyAddonSync(env) {
  const SB = env.SUPABASE_URL;
  const SB_HEADERS = {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
  };

  const listRes = await fetch(
    `${SB}/rest/v1/clients?select=id,hubspot_ticket_id`,
    { headers: SB_HEADERS }
  );
  if (!listRes.ok) return;
  const clients = await listRes.json();
  const valid = (clients || []).filter(
    c => c.hubspot_ticket_id && /^\d+$/.test(String(c.hubspot_ticket_id))
  );

  // Process in small concurrent batches to stay within subrequest limits.
  const CHUNK = 5;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const batch = valid.slice(i, i + CHUNK);
    await Promise.all(batch.map(async c => {
      try {
        const addons = await fetchHubSpotAddons(String(c.hubspot_ticket_id), env);
        if (addons === null) return; // unknown / permission error — do not overwrite
        await fetch(`${SB}/rest/v1/clients?id=eq.${encodeURIComponent(c.id)}`, {
          method: 'PATCH',
          headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ addons, updated_at: new Date().toISOString() }),
        });
      } catch (_) { /* best-effort per client */ }
    }));
  }
}

/**
 * Fetch premium-feature add-ons for a ticket by reading the LINE ITEMS on the
 * onboarding deal(s) associated with the ticket.
 *   ticket → associated deal(s) → line items → mapped premium features
 * Returns [{ product, status }] where status is 'included' (on the plan), an
 * empty array when the client genuinely has no add-on line items, or NULL when
 * a HubSpot call failed (e.g. missing line-items scope) — callers MUST treat
 * null as "unknown, do not overwrite" so a permission error never wipes data.
 */
async function fetchHubSpotAddons(ticketId, env) {
  const AUTH = { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` };

  try {
    const dealIds = await getAddonDealIds(ticketId, AUTH);
    if (dealIds.length === 0) return [];

    // Collect line-item ids across all associated deals. A non-OK response
    // (e.g. 403 missing scope) marks the result degraded → return null.
    const liIdSet = new Set();
    let degraded = false;
    await Promise.all(
      dealIds.slice(0, 10).map(id =>
        fetch(`https://api.hubapi.com/crm/v3/objects/deals/${id}/associations/line_items`, { headers: AUTH })
          .then(r => (r.ok ? r.json() : (degraded = true, { results: [] })))
          .then(d => (d.results || []).forEach(x => liIdSet.add(x.id)))
          .catch(() => { degraded = true; })
      )
    );
    if (degraded) return null;
    const liIds = [...liIdSet];
    if (liIds.length === 0) return [];

    // Batch-read line-item names (max 100)
    const batchRes = await fetch(
      'https://api.hubapi.com/crm/v3/objects/line_items/batch/read',
      {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: ['name'],
          inputs: liIds.slice(0, 100).map(id => ({ id })),
        }),
      }
    );
    if (!batchRes.ok) return null;
    const batchData = await batchRes.json();

    const products = new Set();
    for (const li of (batchData?.results || [])) {
      const product = lineItemToProduct(li.properties?.name);
      if (product) products.add(product);
    }

    return [...products].map(product => ({ product, status: 'included' }));
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the deal ids whose line items describe the account's add-ons.
 * Prefers deals associated directly with the onboarding ticket; falls back to
 * the ticket's company deals only when the ticket has no direct deal.
 */
async function getAddonDealIds(ticketId, AUTH) {
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/deals`,
      { headers: AUTH }
    );
    if (r.ok) {
      const ids = ((await r.json())?.results || []).map(d => d.id);
      if (ids.length) return ids;
    }
  } catch (_) { /* fall through to company deals */ }

  try {
    const cr = await fetch(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}/associations/companies`,
      { headers: AUTH }
    );
    if (!cr.ok) return [];
    const companyId = (await cr.json())?.results?.[0]?.id;
    if (!companyId) return [];
    const dr = await fetch(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/deals`,
      { headers: AUTH }
    );
    if (!dr.ok) return [];
    return ((await dr.json())?.results || []).map(d => d.id);
  } catch (_) {
    return [];
  }
}

/**
 * Map a HubSpot line-item / product name to a premium-feature key.
 * Base products (onboarding fees, core subscriptions, additional users) match
 * nothing and are correctly ignored.
 */
function lineItemToProduct(name) {
  const n = (name || '').toLowerCase();
  if (!n) return null;
  if (n.includes('zapassist') || n.includes('zap assist')) return 'zapAssist_ai';
  if (n.includes('accounting')) return 'floorzap_accounting';
  if (n.includes('consumer financ') || n.includes('financing') || n.includes('wisetack')) return 'consumer_finance';
  if (n.includes('sms')) return 'two_way_sms';
  if (n.includes('email marketing')) return 'email_marketing';
  if (n.includes('payment')) return 'floorzap_payments';
  if (n.includes('growth') || n.includes('website')) return 'growth_sites';
  return null;
}

/**
 * Debug version of fetchHubSpotAddons — traces the ticket → deals → line items
 * chain and shows how each line item maps to a premium feature.
 */
async function fetchHubSpotAddonsDebug(ticketId, env) {
  const AUTH = { Authorization: `Bearer ${env.HUBSPOT_API_KEY}` };
  const debug = { ticketId, steps: {} };

  // Step 1: resolve deal ids (ticket → deals, fallback company → deals)
  const dealIds = await getAddonDealIds(ticketId, AUTH);
  debug.steps.deal_ids = dealIds;
  if (dealIds.length === 0) return debug;

  // Step 2: deals → line item ids
  const liIdSet = new Set();
  debug.steps.li_assoc = [];
  for (const id of dealIds.slice(0, 10)) {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${id}/associations/line_items`,
      { headers: AUTH }
    );
    const rawText = await r.text();
    debug.steps.li_assoc.push({ dealId: id, status: r.status, body: rawText.slice(0, 400) });
    if (r.ok) {
      try { (JSON.parse(rawText)?.results || []).forEach(x => liIdSet.add(x.id)); } catch (_) {}
    }
  }
  const liIds = [...liIdSet];
  debug.steps.line_item_ids = liIds;
  if (liIds.length === 0) return debug;

  // Step 3: batch read line item names + show mapping
  const batchRes = await fetch(
    'https://api.hubapi.com/crm/v3/objects/line_items/batch/read',
    {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: ['name', 'price', 'quantity'],
        inputs: liIds.slice(0, 100).map(id => ({ id })),
      }),
    }
  );
  debug.steps.batch_status = batchRes.status;
  if (!batchRes.ok) return debug;
  const batchData = await batchRes.json();
  debug.steps.line_items = (batchData?.results || []).map(li => ({
    id: li.id,
    name: li.properties?.name,
    price: li.properties?.price,
    mapped: lineItemToProduct(li.properties?.name),
  }));
  debug.steps.addons = [...new Set(
    debug.steps.line_items.map(x => x.mapped).filter(Boolean)
  )].map(product => ({ product, status: 'included' }));

  return debug;
}

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
