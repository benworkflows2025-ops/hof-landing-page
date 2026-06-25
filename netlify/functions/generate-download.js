// ============================================================================
// HOF — generate-download
// Called by the n8n "Payment Confirmed" workflow after a successful payment.
// 1) loads the master PDF for the purchased product from Supabase Storage
// 2) stamps the buyer's name + email on every page (pdf-lib)
// 3) uploads the stamped copy to a private bucket
// 4) creates a one-time-ish download token (48h / 2 downloads)
// 5) returns { download_url } for the delivery email
//
// Env required:  SUPABASE_URL, SUPABASE_SERVICE_KEY   (optional: SITE_URL)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = (process.env.SITE_URL || 'https://heartsonfiretv.com').replace(/\/+$/, '');
const FN_SECRET = process.env.HOF_FN_SECRET; // optional: if set, require a matching x-hof-secret header

const STAMPED_BUCKET = 'hof-stamped-pdfs';
const EXPIRY_HOURS = 48;
const MAX_DOWNLOADS = 2;

// Product catalog — keep in sync with the website + supabase-setup.sql.
// `key` = "<bucket>/<path>" for the ORIGINAL master PDF.
const PRODUCTS = {
  'guard-your-heart-book': { title: 'Guard Your Heart', key: 'hof-pdfs/guard-your-heart-book.pdf', reader: true, slug: 'guard-your-heart' }, // digital reader only — no PDF
  'companion-workbook':    { title: 'Guard Your Heart: Companion Reflection Workbook', key: 'hof-pdfs/companion-workbook.pdf', reader: true, slug: 'companion-workbook' }, // digital reader only — no PDF
  'guard-your-heart-bundle': { title: 'Guard Your Heart — Book + Workbook Bundle', reader: true, slug: 'guard-your-heart', bundle: ['guard-your-heart', 'companion-workbook'] }, // one purchase unlocks both readers
  'small-group-guide':     { title: 'Small Group Discussion Guide', key: 'hof-pdfs/small-group-guide.pdf' },
  'thirty-day-journal':    { title: '30-Day Guard Your Heart Journal', key: 'hof-pdfs/thirty-day-journal.pdf' },
  'test-product':          { title: 'HOF Test Product', key: 'hof-pdfs/test-product.pdf' }, // internal $0 system test — remove before launch
};

// Resolve a product by id, or fall back to an exact title match (the checkout
// currently sends the product title, not an id — see SECURE-DELIVERY-SETUP.md).
function resolveProduct({ product_id, product_title }) {
  if (product_id && PRODUCTS[product_id]) return { id: product_id, ...PRODUCTS[product_id] };
  if (product_title) {
    const t = String(product_title).trim().toLowerCase();
    const hit = Object.entries(PRODUCTS).find(([, p]) => p.title.toLowerCase() === t);
    if (hit) return { id: hit[0], ...hit[1] };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'Server not configured (missing Supabase env vars)' });

  // Optional shared-secret gate (only enforced when HOF_FN_SECRET is set in Netlify env)
  if (FN_SECRET) {
    const h = event.headers || {};
    const provided = h['x-hof-secret'] || h['X-Hof-Secret'] || '';
    if (provided !== FN_SECRET) return json(401, { error: 'Unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const buyer_name = String(body.buyer_name || '').trim();
  const buyer_email = String(body.buyer_email || '').trim();
  if (!buyer_email) return json(400, { error: 'buyer_email is required' });

  const product = resolveProduct(body);
  if (!product) return json(400, { error: 'Unknown product', detail: { product_id: body.product_id, product_title: body.product_title } });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // Reader-only products (digital, no PDF download): just mint the in-browser reader access token.
  if (product.reader) {
    const rToken = crypto.randomUUID();
    const rExpires = new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000).toISOString();
    const { error: rErr } = await supabase.from('hof_download_tokens').insert({
      token: rToken,
      buyer_name: buyer_name || 'Customer',
      buyer_email,
      product_id: product.id,
      product_title: product.title,
      pdf_storage_path: 'reader-only',
      expires_at: rExpires,
      max_downloads: MAX_DOWNLOADS,
    });
    if (rErr) return json(502, { error: 'Token creation failed', detail: rErr.message });
    // For a bundle, one token unlocks several books — hand back a link per book.
    const slugs = (product.bundle && product.bundle.length) ? product.bundle : [product.slug || 'guard-your-heart'];
    const reader_urls = slugs.map((s) => `${SITE_URL}/book?key=${rToken}&book=${s}`);
    return json(200, { reader: true, reader_url: reader_urls[0], reader_urls, token: rToken, product_title: product.title });
  }

  // 1) fetch the master PDF
  const [origBucket, ...rest] = product.key.split('/');
  const origPath = rest.join('/');
  const { data: file, error: dlErr } = await supabase.storage.from(origBucket).download(origPath);
  if (dlErr || !file) return json(502, { error: 'Could not load source PDF', detail: dlErr && dlErr.message });
  const srcBytes = new Uint8Array(await file.arrayBuffer());

  // 2) stamp every page
  let stampedBytes;
  try {
    stampedBytes = await stampPdf(srcBytes, buyer_name, buyer_email);
  } catch (e) {
    return json(500, { error: 'PDF stamping failed', detail: e.message });
  }

  // 3) upload the stamped copy
  const token = crypto.randomUUID();
  const stampedPath = `${product.id}/${token}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(STAMPED_BUCKET)
    .upload(stampedPath, Buffer.from(stampedBytes), { contentType: 'application/pdf', upsert: true });
  if (upErr) return json(502, { error: 'Stamped upload failed', detail: upErr.message });

  // 4) create the token row
  const expires_at = new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000).toISOString();
  const { error: insErr } = await supabase.from('hof_download_tokens').insert({
    token,
    buyer_name: buyer_name || 'Customer',
    buyer_email,
    product_id: product.id,
    product_title: product.title,
    pdf_storage_path: stampedPath,
    expires_at,
    max_downloads: MAX_DOWNLOADS,
  });
  if (insErr) return json(502, { error: 'Token creation failed', detail: insErr.message });

  // 5) return the buyer-facing link
  return json(200, {
    download_url: `${SITE_URL}/download?token=${token}`,
    token,
    product_title: product.title,
    expires_at,
  });
};

async function stampPdf(bytes, name, email) {
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const gray = rgb(0.6, 0.6, 0.6); // ~ #999999
  const size = 8;
  const label = `Purchased by: ${name || 'Customer'} | ${email} | Hearts On Fire Network`;
  for (const page of pdf.getPages()) {
    const { width } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, size);
    const x = Math.max(12, (width - textWidth) / 2);
    page.drawText(label, { x, y: 16, size, font, color: gray }); // bottom-center, every page
  }
  return await pdf.save();
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj),
  };
}
