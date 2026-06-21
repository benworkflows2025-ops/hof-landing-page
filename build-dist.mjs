// build-dist.mjs — assemble the Netlify publish folder ("dist/") from source.
// Netlify runs this on every deploy (see netlify.toml). Pages go to the dist
// root so Netlify serves clean URLs (/resources -> resources.html, etc.).
import { rmSync, mkdirSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1) all marketing/app pages -> dist root (clean URLs + /download + 404)
const pagesDir = join(ROOT, 'pages');
let pages = 0;
for (const f of readdirSync(pagesDir)) {
  if (f.endsWith('.html')) { cpSync(join(pagesDir, f), join(DIST, f)); pages++; }
}

// 2) images (placeholder covers, etc.)
if (existsSync(join(ROOT, 'img'))) {
  cpSync(join(ROOT, 'img'), join(DIST, 'img'), { recursive: true });
}

console.log(`dist/ built: ${pages} pages + img -> [${readdirSync(DIST).join(', ')}]`);
