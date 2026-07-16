/* Heart Stewardship Checkup v1.0 — email capture.
 * Called after the Snapshot. Records the email + consent against the existing
 * submission row (scored fields stay immutable), then hands off to n8n, which
 * pushes the lead + result into GHL and GHL sends the Full Report. Supabase
 * never sends email here.
 *
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_KEY   (already set)
 *       HSC_N8N_WEBHOOK   (n8n webhook that pushes to GHL — add when ready)
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const N8N_WEBHOOK = process.env.HSC_N8N_WEBHOOK;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input;
  try { input = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  const submissionId = String(input.submission_id || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const consent = input.consent === true;
  if (!submissionId) return json(400, { error: 'missing_submission_id' });
  if (!EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' });
  if (!consent) return json(400, { error: 'consent_required' });

  const now = new Date().toISOString();
  let row = null;

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    // Update only the editable capture fields (scored columns are DB-protected).
    const { data, error } = await supabase.from('hsc_submissions')
      .update({ contact_email: email, email_captured: true, email_captured_at: now, consent_status: 'GRANTED', consent_at: now, report_status: 'QUEUED' })
      .eq('submission_id', submissionId)
      .select('submission_id, final_stage, stage_name, priority_domains, strength_domains, recommendation, routing_rule_id, content_version')
      .single();
    if (error) return json(500, { error: 'store_failed', detail: error.message });
    row = data;
  }

  // Hand off to n8n -> GHL for report delivery + nurture. Fire and confirm; on
  // failure we still confirm capture (the row is saved) and mark the report FAILED.
  if (N8N_WEBHOOK) {
    try {
      const resp = await fetch(N8N_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'hsc_email_captured', submission_id: submissionId, email: email, consent_at: now, result: row }),
      });
      if (!resp.ok && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        await supabase.from('hsc_submissions').update({ report_status: 'FAILED' }).eq('submission_id', submissionId);
      }
    } catch (e) { /* swallow: capture already succeeded; report delivery retried out of band */ }
  }

  return json(200, { status: 'CAPTURED', submission_id: submissionId });
};
