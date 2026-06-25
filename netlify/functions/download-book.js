// ============================================================================
// HOF — download-book
// Lets an UNLOCKED buyer download their book as a PDF (the green A4 edition),
// stamped with their name + email on every page so a shared copy traces back.
//   POST { key, email, book } -> validates token+email+product, fetches the
//   master green PDF from the private hof-pdfs bucket, stamps it, returns it.
//
// Env required:  SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PDF_BUCKET = 'hof-pdfs';

const BOOKS = {
  'guard-your-heart':   { file: 'guard-your-heart-green.pdf',   products: ['guard-your-heart-book', 'guard-your-heart-bundle'], name: 'Guard Your Heart.pdf' },
  'companion-workbook': { file: 'companion-workbook-green.pdf', products: ['companion-workbook', 'guard-your-heart-bundle'],     name: 'Guard Your Heart - Companion Workbook.pdf' },
};
const norm = (s) => String(s || '').trim().toLowerCase();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) {}
  const key = String(b.key || '').trim();
  const email = norm(b.email);
  const book = BOOKS[String(b.book || 'guard-your-heart')];

  if (!book) return json(404, { error: 'unknown_book' });
  if (!key) return json(401, { error: 'no_key' });
  if (!email) return json(401, { error: 'no_email' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'not_configured' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: row, error } = await supabase
    .from('hof_download_tokens').select('buyer_name, buyer_email, product_id').eq('token', key).maybeSingle();
  if (error) return json(500, { error: 'lookup_failed' });
  if (!row) return json(403, { error: 'invalid_key' });
  if (book.products.indexOf(row.product_id) === -1) return json(403, { error: 'wrong_product' });
  if (norm(row.buyer_email) !== email) return json(403, { error: 'email_mismatch' });

  const { data: file, error: dErr } = await supabase.storage.from(PDF_BUCKET).download(book.file);
  if (dErr || !file) return json(502, { error: 'content_unavailable' });
  const bytes = new Uint8Array(await file.arrayBuffer());

  let out;
  try { out = await stamp(bytes, row.buyer_name || 'Reader', row.buyer_email); }
  catch (e) { return json(500, { error: 'stamp_failed', detail: e.message }); }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + book.name + '"',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: Buffer.from(out).toString('base64'),
    isBase64Encoded: true,
  };
};

async function stamp(bytes, name, email) {
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const label = 'Licensed to ' + name + '   |   ' + email;
  const pages = pdf.getPages();
  for (let i = 1; i < pages.length; i++) { // skip the cover (page 0)
    const pg = pages[i];
    const { width } = pg.getSize();
    const sz = 7.5;
    const w = font.widthOfTextAtSize(label, sz);
    pg.drawText(label, { x: (width - w) / 2, y: 20, size: sz, font, color: rgb(0.62, 0.69, 0.66), opacity: 0.85 });
  }
  return await pdf.save();
}

function json(s, o) {
  return { statusCode: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) };
}
