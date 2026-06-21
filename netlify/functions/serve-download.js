// ============================================================================
// HOF — serve-download
// Called when a buyer opens their download link.
//   GET ?token=XXX           → validate, increment count, 302-redirect to a
//                              60-second Supabase signed URL (file downloads)
//   GET ?token=XXX&check=1   → validate ONLY (no increment), returns JSON so the
//                              /download page can show "ready" vs an error first
//
// Env required:  SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPPORT_EMAIL = 'support@heartsonfiretv.com';
const STAMPED_BUCKET = 'hof-stamped-pdfs';
const SIGNED_URL_TTL = 60; // seconds

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const token = q.token;
  const isCheck = q.check === '1';

  if (!token) return isCheck ? json(400, { valid: false, reason: 'Missing token' }) : errorPage(400, 'This download link is missing its token.');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return isCheck ? json(500, { valid: false, reason: 'Server not configured' }) : errorPage(500, 'The download service is not configured yet.');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // 1) look up the token
  const { data: row, error } = await supabase
    .from('hof_download_tokens')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) return isCheck ? json(500, { valid: false, reason: 'Lookup failed' }) : errorPage(500, 'Something went wrong. Please try again in a moment.');
  if (!row) return isCheck ? json(404, { valid: false, reason: 'not_found' }) : errorPage(404, 'This download link was not found.');

  // 2) expiry + limit checks
  if (new Date(row.expires_at).getTime() < Date.now())
    return isCheck ? json(200, { valid: false, reason: 'expired' }) : errorPage(410, `This download link has expired. Please contact ${SUPPORT_EMAIL}`);

  if ((row.download_count || 0) >= (row.max_downloads || 2))
    return isCheck ? json(200, { valid: false, reason: 'limit' }) : errorPage(429, `This download link has reached its download limit. Please contact ${SUPPORT_EMAIL}`);

  // 3a) preflight check (no increment)
  if (isCheck) {
    return json(200, {
      valid: true,
      product_title: row.product_title,
      downloads_left: (row.max_downloads || 2) - (row.download_count || 0),
      expires_at: row.expires_at,
    });
  }

  // 3b) real download: increment, sign, redirect
  const { error: updErr } = await supabase
    .from('hof_download_tokens')
    .update({ download_count: (row.download_count || 0) + 1 })
    .eq('token', token);
  if (updErr) return errorPage(500, 'We could not process your download. Please try again.');

  const { data: signed, error: sErr } = await supabase.storage
    .from(STAMPED_BUCKET)
    .createSignedUrl(row.pdf_storage_path, SIGNED_URL_TTL, { download: true });
  if (sErr || !signed) return errorPage(500, 'We could not prepare your file. Please try again.');

  return { statusCode: 302, headers: { Location: signed.signedUrl, 'Cache-Control': 'no-store' }, body: '' };
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

function errorPage(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hearts On Fire Network</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#fdf8ef;color:#1a1410;">
<div style="max-width:460px;margin:0 auto;padding:64px 24px;text-align:center;">
<p style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#1a1410;margin:0 0 4px;">Hearts On Fire</p>
<p style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#0d5b54;font-weight:700;margin:0 0 28px;">Network</p>
<p style="font-size:16px;line-height:1.6;color:#3d3027;">${message}</p>
</div></body></html>`,
  };
}
