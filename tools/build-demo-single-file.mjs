#!/usr/bin/env node
/**
 * Builds a single self-contained HTML file: no server, no fetch, no CORS, no
 * service worker. Open it from file:// or drop it into any sandboxed iframe.
 *
 *   node tools/build-demo-single-file.mjs
 *   → writes forge-infinite-demo.html
 *
 * How it works: each ES module is wrapped in an IIFE that returns its exports,
 * and every `import {…} from './x.js'` becomes a destructure of that IIFE's
 * result. No name collisions, no bundler dependency.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'htdocs');

// dependency order — each module may only import from ones listed before it
// Load order. demo.js must precede api.js because api.js resolves the demo
// engine through a dynamic import (lazy in the source, eager in this bundle).
const ORDER = ['fmt', 'balance', 'juice', 'ui', 'cosmetic', 'demo', 'api', 'store', 'screens', 'main'];

function transform(src) {
  const imports = [];
  const exported = [];
  src = src.replace(/^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (_, a, n) => {
    exported.push(n); return `${a || ''}function ${n}`;
  });
  src = src.replace(/^export\s+const\s+([A-Za-z0-9_$]+)/gm, (_, n) => { exported.push(n); return `const ${n}`; });
  src = src.replace(/^export\s+let\s+([A-Za-z0-9_$]+)/gm, (_, n) => { exported.push(n); return `let ${n}`; });
  src = src.replace(/^export\s*\{([^}]+)\}\s*;?\s*$/gm, (_, list) => {
    for (const part of list.split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) exported.push(n);
    }
    return '';
  });
  src = src.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/([A-Za-z0-9_]+)\.js['"];?\s*$/gm, (_, list, mod) => {
    const pairs = list.split(',').map(p => {
      const t = p.trim(); if (!t) return '';
      const m = t.split(/\s+as\s+/);
      return m.length === 2 ? `${m[0].trim()}: ${m[1].trim()}` : t;
    }).filter(Boolean).join(', ');
    imports.push(mod);
    return `const { ${pairs} } = __fi_${mod}();`;
  });
  src = src.replace(/^import\s+['"]\.\/([A-Za-z0-9_]+)\.js['"];?\s*$/gm, (_, mod) => {
    imports.push(mod); return `__fi_${mod}();`;
  });
  src = src.replace(/await import\(['"]\.\/([A-Za-z0-9_]+)\.js['"]\)/g, (_, mod) => {
    imports.push(mod); return `__fi_${mod}()`;
  });
  const ret = exported.length ? `return { ${[...new Set(exported)].join(', ')} };` : 'return {};';
  return { code: src, imports, ret };
}

const modules = {};
for (const name of ORDER) {
  modules[name] = transform(readFileSync(join(PUB, 'js', name + '.js'), 'utf8'));
}
for (const name of ORDER) {
  for (const dep of modules[name].imports) {
    if (!ORDER.includes(dep)) throw new Error(`${name}.js imports unknown module ${dep}.js`);
    if (ORDER.indexOf(dep) > ORDER.indexOf(name)) {
      throw new Error(`dependency order violated: ${name}.js imports ${dep}.js which comes later`);
    }
  }
}

const balance = readFileSync(join(PUB, 'config', 'balance.json'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');

const body = ORDER.map(name => {
  const m = modules[name];
  return `/* ═══════════ ${name}.js ═══════════ */
let __fi_${name}_cache;
function __fi_${name}() {
  if (__fi_${name}_cache) return __fi_${name}_cache;
  __fi_${name}_cache = (() => {
${m.code}
${m.ret}
  })();
  return __fi_${name}_cache;
}`;
}).join('\n\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=5">
<title>Forge Infinite — single-file demo</title>
<meta name="description" content="Forge Infinite: a free idle forge game. Self-contained single-file demo build.">
<meta name="theme-color" content="#14120F">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex,nofollow">
<style>
${css}
.demo-banner{position:fixed;top:0;left:0;right:0;z-index:300;background:#7C2D12;color:#FFEDD5;
  font:600 11.5px/1.4 system-ui,sans-serif;text-align:center;padding:5px 10px}
#app,#boot{padding-top:26px}
</style>
</head>
<body>
<div class="demo-banner" role="note">SINGLE-FILE DEMO — no server, no network, no accounts. Progress is saved in this browser only.</div>

<div id="boot"><div style="text-align:center">
  <svg class="logo" viewBox="0 0 64 64" aria-hidden="true" style="width:76px;height:76px;margin:0 auto">
    <defs><linearGradient id="bootg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFB020"/><stop offset=".45" stop-color="#FF7A18"/>
      <stop offset="1" stop-color="#C2410C"/></linearGradient></defs>
    <path d="M22 22c-7 0-12 4.5-12 10s5 10 12 10c6 0 9-4 12-8 3 4 6 8 12 8 7 0 12-4.5 12-10s-5-10-12-10c-6 0-9 4-12 8-3-4-6-8-12-8z"
          fill="none" stroke="url(#bootg)" stroke-width="6" stroke-linejoin="round"/>
    <path d="M18 50h28l-4 8H22z" fill="url(#bootg)"/>
  </svg>
  <p>Lighting the forge…</p>
</div></div>

<div id="app" aria-live="polite"></div>
<canvas id="fx" aria-hidden="true"></canvas>
<div id="floaters" aria-hidden="true"></div>
<div id="flash" aria-hidden="true"></div>
<div id="toasts" aria-live="polite"></div>
<div id="modals"></div>

<script id="fi-balance" type="application/json">${balance.replace(/<\/script/gi, '<\\/script')}</script>
<script>
window.FI_DEMO = true;
window.FI_SINGLE_FILE = true;
window.FI_VER = '1.0.0-single';
window.FI_BALANCE = JSON.parse(document.getElementById('fi-balance').textContent);

${body}

__fi_main();
</script>
</body>
</html>
`;
writeFileSync(join(ROOT, 'forge-infinite-demo.html'), html);
console.error(`✅ forge-infinite-demo.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${ORDER.length} modules inlined, zero external requests`);
