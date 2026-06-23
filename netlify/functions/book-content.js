// ============================================================================
// HOF — book-content
// Gated content for the in-browser book reader.
//   POST { key, email, book } ->
//     validates the buyer's access token (key) AND that the email matches the
//     email used at checkout, then returns the book JSON. Reading is persistent
//     (no expiry / no download-count) — once bought, they can re-read anytime.
//
// The book content lives in a PRIVATE Supabase bucket (never in the public
// page or repo), so a shared link without the matching email gets nothing.
//
// Env required:  SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOOKS_BUCKET = 'hof-books';

// slug -> content file in the bucket + the product id(s) that grant access
const BOOKS = {
  'guard-your-heart': { file: 'guard-your-heart.json', products: ['guard-your-heart-book'] },
};

const norm = (s) => String(s || '').trim().toLowerCase();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const key = String(body.key || '').trim();
  const email = norm(body.email);
  const book = BOOKS[String(body.book || 'guard-your-heart')];

  if (!book) return json(404, { error: 'unknown_book' });
  if (!key) return json(401, { error: 'no_key' });
  if (!email) return json(401, { error: 'no_email' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'not_configured' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // 1) validate the access token + email + product
  const { data: row, error } = await supabase
    .from('hof_download_tokens')
    .select('buyer_name, buyer_email, product_id')
    .eq('token', key)
    .maybeSingle();
  if (error) return json(500, { error: 'lookup_failed' });
  if (!row) return json(403, { error: 'invalid_key' });
  if (book.products.indexOf(row.product_id) === -1) return json(403, { error: 'wrong_product' });
  if (norm(row.buyer_email) !== email) return json(403, { error: 'email_mismatch' });

  // 2) fetch the gated content from the private bucket
  const { data: file, error: dErr } = await supabase.storage.from(BOOKS_BUCKET).download(book.file);
  if (dErr || !file) return json(502, { error: 'content_unavailable' });
  let content;
  try { content = JSON.parse(await file.text()); } catch (e) { return json(500, { error: 'bad_content' }); }

  return json(200, {
    ok: true,
    licensed_to: { name: row.buyer_name || 'Reader', email: row.buyer_email },
    book: content,
  });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj),
  };
}
