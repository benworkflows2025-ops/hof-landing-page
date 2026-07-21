/* Heart Stewardship Checkup v1.0 — report data endpoint.
 * GET ?id=<submission_id> -> loads the stored (immutable) result + the approved
 * content pack from Supabase, assembles the Full Report in the locked order, and
 * returns it as JSON for the report page to render. Never recalculates; reads the
 * stored Final Stage. If the content pack is not fully filled, returns ready:false
 * with the structural facts only (never placeholder prose).
 *
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_KEY
 */
const { assembleReport } = require('./lib/assemble-report.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const id = ((event.queryStringParameters || {}).id || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // 1) the stored, immutable scored result
  const { data: row, error } = await supabase.from('hsc_submissions').select('*').eq('submission_id', id).single();
  if (error || !row) return json(404, { error: 'not_found' });

  // 2) the approved content pack (latest). Absent/partial -> report is "not ready".
  let content = { domains: {}, stages: {}, tie: {}, products: {} };
  try {
    const { data: c } = await supabase.from('hsc_content').select('content').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (c && c.content) content = c.content;
  } catch (e) { /* table may not exist yet -> stays empty -> not ready */ }

  const report = assembleReport(row, content);
  const areasOf = (n) => ((report.sections.find((s) => s.n === n) || {}).items || []).map((i) => i.domain);

  return json(200, {
    submission_id: id,
    stage: report.stage,
    stage_name: report.stage_name,           // '' until copy is loaded -> page falls back to "Stage N"
    recommendation: report.recommendation,
    ready: report.ready,                      // true only when every controlled slot is filled
    priority_type: report.priority_type,
    strength_type: report.strength_type,
    priority_areas: areasOf(5),
    strength_areas: areasOf(4),
    summary: report.ready ? report.summary : null,     // "at a glance" overview, top of report
    sections: report.ready ? report.sections : null,   // full prose only when approved copy is in
  });
};
