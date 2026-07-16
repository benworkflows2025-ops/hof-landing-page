/* Heart Stewardship Checkup v1.0 — scoring endpoint.
 * POST answers -> deterministic score (fails closed) -> store as an immutable
 * append-only row in Supabase -> return the SNAPSHOT payload only.
 *
 * The snapshot deliberately carries NO product recommendation (spec S11). The
 * recommendation is computed and stored, but only released by the report step
 * after email capture. Stage interpretation TEXT is controlled copy loaded once
 * the Results/Product-Routing/Funnel source doc arrives; this endpoint returns
 * the structured result the page needs (stage number, name key, priority set).
 *
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_KEY  (already configured in Netlify)
 */
const { scoreAssessment } = require('./lib/hsc-scoring-engine.js');
// @supabase/supabase-js is required lazily (only when actually persisting) so the
// scoring path loads and runs even in environments where it is not installed.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// HOF-controlled Journey availability flag (IC-01). Server-side only, never trusted
// from the browser. Default OFF until the Transformation Journey path is live.
const JOURNEY_AVAILABLE = process.env.HSC_JOURNEY_AVAILABLE === 'true';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) });

function pickAnswers(r) {
  const a = {};
  for (let n = 1; n <= 21; n++) { const k = 'Q' + String(n).padStart(2, '0'); a[k] = r[k]; }
  return a;
}
function domainScores(r) {
  return { D1: r.HSC_V1_D1_SCORE, D2: r.HSC_V1_D2_SCORE, D3: r.HSC_V1_D3_SCORE, D4: r.HSC_V1_D4_SCORE, D5: r.HSC_V1_D5_SCORE, D6: r.HSC_V1_D6_SCORE, D7: r.HSC_V1_D7_SCORE };
}
function newId() {
  try { return require('crypto').randomUUID(); } catch { return 'hsc_' + Date.now() + '_' + Math.round(Math.random() * 1e9); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input;
  try { input = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  // 1) Score deterministically. Fails closed on any missing/invalid item or history conflict.
  // journeyAvailable comes from server config, NOT the request body (anti-tamper).
  const r = scoreAssessment({ answers: input.answers, productHistory: input.productHistory, journeyAvailable: JOURNEY_AVAILABLE });
  if (r.HSC_V1_COMPLETION_STATUS === 'ERROR') return json(400, { status: 'ERROR', reason: r.HSC_V1_ERROR_REASON });

  // 2) Persist as a NEW immutable row (a retake creates a new row; never overwrites a prior one).
  const submissionId = String(input.submission_id || '').trim() || newId();
  const row = {
    submission_id: submissionId,
    completed_at: new Date().toISOString(),
    completion_status: 'COMPLETE',
    answers: pickAnswers(r),
    domain_scores: domainScores(r),
    overall_raw: r.HSC_V1_OVERALL_RAW,
    provisional_stage: r.HSC_V1_PROVISIONAL_STAGE,
    final_stage: r.HSC_V1_FINAL_STAGE,
    stage_name: r.HSC_V1_STAGE_NAME,
    downgrade_flag: r.HSC_V1_DOWNGRADE_FLAG,
    downgrade_reason: r.HSC_V1_DOWNGRADE_REASON,
    lowest_score: r.HSC_V1_LOWEST_SCORE,
    priority_type: r.HSC_V1_PRIORITY_TYPE,
    priority_domains: r.HSC_V1_PRIORITY_DOMAINS,
    highest_score: r.HSC_V1_HIGHEST_SCORE,
    strength_type: r.HSC_V1_STRENGTH_TYPE,
    strength_domains: r.HSC_V1_STRENGTH_DOMAINS,
    product_history: Array.isArray(input.productHistory) ? input.productHistory : [],
    journey_available: r.HSC_V1_JOURNEY_AVAILABLE,
    recommendation: r.HSC_V1_RECOMMENDATION,
    routing_rule_id: r.HSC_V1_ROUTING_RULE_ID,
    report_status: 'NOT_REQUESTED',
    assessment_version: r.HSC_V1_ASSESSMENT_VERSION,
    spec_version: r.HSC_V1_SPEC_VERSION,
    logic_version: r.HSC_V1_LOGIC_VERSION,
    content_version: r.HSC_V1_CONTENT_VERSION,
    source: input.source || null,
    campaign: input.campaign || null,
    utm_source: input.utm_source || null,
    utm_medium: input.utm_medium || null,
    utm_campaign: input.utm_campaign || null,
    payload: r,
  };

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await supabase.from('hsc_submissions').insert(row);
    if (error) return json(500, { status: 'ERROR', error: 'store_failed', detail: error.message });
  } else if (!process.env.HSC_ALLOW_NO_STORE) {
    // Fail closed: never show a result we could not durably persist.
    return json(500, { status: 'ERROR', error: 'not_configured' });
  }

  // 3) SNAPSHOT payload only. No product recommendation here (released in the report after email).
  return json(200, {
    status: 'COMPLETE',
    submission_id: submissionId,
    final_stage: r.HSC_V1_FINAL_STAGE,
    stage_name: r.HSC_V1_STAGE_NAME,
    priority_type: r.HSC_V1_PRIORITY_TYPE,
    priority_domains: r.HSC_V1_PRIORITY_DOMAINS.split(',').filter(Boolean),
    strength_type: r.HSC_V1_STRENGTH_TYPE,
    strength_domains: r.HSC_V1_STRENGTH_DOMAINS.split(',').filter(Boolean),
    // stage_interpretation + snapshot copy are filled from the controlled content pack (pending 3rd source doc)
  });
};
