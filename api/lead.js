// Vercel serverless function — lead handler for the "Steal your time back" landing page.
// POST /api/lead — JSON body: { name, email, company, companySize, phone, hiringTimeline, userAgent, stage }
// Stage flow: 'partial' (name+email) → 'partial2' (+company+companySize) → 'complete' (+phone+timeline).
// Side effects (per scope): (1) ALWAYS upsert to Coconut OS, (2) Slack notification.
// No Meta/CAPI, no Resend email — intentionally removed for this page.

// ----------------------------------------------------------------------------
// TODO(daniel): confirm the lead tag name you want in Coconut OS. Placeholder below.
const LEAD_TAG    = 'LP - Steal Your Time Back';
const SOURCE_INFO = 'Landing Page — Steal Your Time Back (join.coconutva.com)';
const PAGE_URL    = process.env.PAGE_URL || 'https://join.coconutva.com/';
// ----------------------------------------------------------------------------

// NOTE ON company size ↔ Coconut OS:
// The existing RPC `upsert_ad_lead` has a FIXED signature where `p_ap_tool` is REQUIRED
// and there is NO `p_company_size` param (verified against contacts table / generated types).
// The `contacts` table has an `ap_tool` text column but no `company_size` column.
// PRAGMATIC PATH (used here, zero DB changes): we store the company size in the `p_ap_tool`
// slot so it lands in contacts.ap_tool. It works today, but it is semantically off.
// CLEAN PATH (recommended when you're ready — needs an explicit DB go-ahead):
//   1) ALTER TABLE contacts ADD COLUMN company_size text;
//   2) update/replace upsert_ad_lead to accept p_company_size and write that column.
// Until then, flip STORE_SIZE_IN to 'ap_tool'. If/when the clean path is live, you can
// switch to sending p_company_size instead (see the commented block in the upsert call).
const STORE_SIZE_IN = 'ap_tool';

const VALID_COMPANY_SIZES = ['Just me (1)', '2 to 10', '11 to 50', '51 to 200', '201+'];
const VALID_TIMELINES = [
  'ASAP (within 2 weeks)',
  'Within the next month',
  '1 to 3 months',
  '3 to 6 months',
  'Just exploring for now'
];
const STAGES = ['partial', 'partial2', 'complete'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const raw = await readJson(req);
  const stage = STAGES.includes(raw && raw.stage) ? raw.stage : 'complete';
  const name = clean(raw && raw.name, 120);
  const email = clean(raw && raw.email, 160).toLowerCase();
  const company = clean(raw && raw.company, 160);
  const companySize = VALID_COMPANY_SIZES.includes(raw && raw.companySize) ? raw.companySize : null;
  const phone = clean(raw && raw.phone, 40);
  const hiringTimeline = VALID_TIMELINES.includes(raw && raw.hiringTimeline) ? raw.hiringTimeline : null;

  if (!email || !isEmail(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

  const parts = name.split(/\s+/);
  const firstName = parts.shift() || null;
  const lastName = parts.length ? parts.join(' ') : null;

  // 1. Upsert into Coconut OS (always)
  let contactId = null;
  try {
    const supaUrl = process.env.SUPABASE_OS_URL;
    const supaKey = process.env.SUPABASE_OS_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) {
      console.error('SUPABASE env vars missing');
      return res.status(500).json({ ok: false, error: 'config_missing' });
    }

    // Pragmatic mapping: company size → p_ap_tool (contacts.ap_tool). See note above.
    const rpcBody = {
      p_email: email,
      p_full_name: name,
      p_first_name: firstName,
      p_last_name: lastName,
      p_company: company || null,
      p_ap_tool: STORE_SIZE_IN === 'ap_tool' ? companySize : null,
      p_lead_tag: LEAD_TAG,
      p_source_info: SOURCE_INFO,
      p_phone: phone || null,
      p_hiring_timeline: hiringTimeline
      // CLEAN PATH (after DB change): add `p_company_size: companySize` and set
      // STORE_SIZE_IN to something else so p_ap_tool goes null.
    };

    const r = await fetch(`${supaUrl}/rest/v1/rpc/upsert_ad_lead`, {
      method: 'POST',
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(rpcBody)
    });
    if (!r.ok) {
      console.error('Supabase upsert failed', r.status, await r.text());
      return res.status(502).json({ ok: false, error: 'db_upsert_failed' });
    }
    const body = await r.json();
    contactId = typeof body === 'string' ? body : (body && body[0]) || null;
  } catch (e) {
    console.error('Supabase exception', e);
    return res.status(502).json({ ok: false, error: 'db_exception' });
  }

  // 2. Slack notification (new channel webhook)
  if (stage === 'complete') {
    await safe(() => notifySlackComplete({ name, email, company, companySize, phone, hiringTimeline }), 'slack:complete');
  } else if (stage === 'partial2') {
    await safe(() => notifySlackPartial2({ name, email, company, companySize }), 'slack:partial2');
  } else {
    await safe(() => notifySlackPartial({ name, email }), 'slack:partial');
  }

  return res.status(200).json({ ok: true, contactId, stage });
}

/* ===================== SLACK ===================== */

async function notifySlackComplete({ name, email, company, companySize, phone, hiringTimeline }) {
  const url = process.env.SLACK_WEBHOOK_LEADS;
  if (!url) { console.warn('Slack webhook missing — complete skipped'); return; }
  await postSlack(url, {
    text: '🥥 New lead — Steal your time back',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🥥 New lead — Steal your time back' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Work email:*\n${email}` },
        { type: 'mrkdwn', text: `*Company:*\n${company || '—'}` },
        { type: 'mrkdwn', text: `*Company size:*\n${companySize || '—'}` },
        { type: 'mrkdwn', text: `*Phone:*\n${phone || '—'}` },
        { type: 'mrkdwn', text: `*Hiring:*\n${hiringTimeline || '—'}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Source: ${SOURCE_INFO}` }] }
    ]
  }, 'complete');
}

async function notifySlackPartial2({ name, email, company, companySize }) {
  const url = process.env.SLACK_WEBHOOK_LEADS;
  if (!url) { console.warn('Slack webhook missing — partial2 skipped'); return; }
  await postSlack(url, {
    text: '🟠 Partial lead (step 2) — Steal your time back',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🟠 Partial lead — step 2 of 3' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Work email:*\n${email}` },
        { type: 'mrkdwn', text: `*Company:*\n${company || '—'}` },
        { type: 'mrkdwn', text: `*Company size:*\n${companySize || '—'}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Phone / hiring timeline not yet provided. Source: ${SOURCE_INFO}` }] }
    ]
  }, 'partial2');
}

async function notifySlackPartial({ name, email }) {
  const url = process.env.SLACK_WEBHOOK_LEADS;
  if (!url) { console.warn('Slack webhook missing — partial skipped'); return; }
  await postSlack(url, {
    text: '🟡 Partial lead (step 1) — Steal your time back',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🟡 Partial lead — step 1 of 3' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Work email:*\n${email}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Name + email captured. Source: ${SOURCE_INFO}` }] }
    ]
  }, 'partial');
}

async function postSlack(url, payload, tag) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) console.error(`Slack webhook (${tag}) error`, r.status, await r.text());
}

/* ===================== HELPERS ===================== */

function clean(v, max) { return (typeof v === 'string' ? v : '').trim().slice(0, max); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

async function safe(fn, tag) {
  try { await fn(); } catch (e) { console.error(`Side-effect ${tag} failed`, e); }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
