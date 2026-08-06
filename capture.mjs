// Fase 1 — Capturador de tráfico de red (Playwright, headless, proxy-aware)
// Uso:
//   npm i playwright-core@1.56.1
//   node capture.mjs https://grupodalvi.com.mx
// Variables opcionales:
//   MAX_PAGES=8            nº máx. de páginas internas a recorrer (def. 8)
//   OUT=network-capture.json  ruta de salida
//   PW_EXECUTABLE=/ruta/chrome  ejecutable de Chromium (si no, autodetecta)
//   HTTPS_PROXY=...        se respeta automáticamente si está definido
//
// Nota de seguridad: el JSON puede contener cookies/tokens en headers de auth.
// No lo subas al repo (añádelo a .gitignore). Los valores reales de auth van a .env.

import { chromium } from 'playwright-core';
import { writeFileSync, existsSync } from 'node:fs';

const START_URL = process.argv[2];
if (!START_URL) { console.error('Falta la URL: node capture.mjs <url>'); process.exit(1); }
const MAX_PAGES = Number(process.env.MAX_PAGES || 8);
const OUT = process.env.OUT || 'network-capture.json';
const origin = new URL(START_URL).origin;

// ---- Autodetección del ejecutable de Chromium (binarios preinstalados) ----
function findChromium() {
  if (process.env.PW_EXECUTABLE) return process.env.PW_EXECUTABLE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const candidates = [
    `${base}/chromium-1194/chrome-linux/chrome`,
    `${base}/chromium_headless_shell-1194/chrome-linux/headless_shell`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined; // deja que Playwright resuelva por PLAYWRIGHT_BROWSERS_PATH
}

// ---- Utilidades de clasificación / normalización ----
const AUTH_HEADERS = ['authorization', 'cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token'];

function classify(url, contentType, isGraphql) {
  const ct = (contentType || '').toLowerCase();
  if (isGraphql) return 'graphql';
  if (ct.includes('text/event-stream') || ct.includes('application/x-ndjson')) return 'stream';
  if (ct.includes('json') || ct.includes('text/') || ct.includes('xml') || ct.includes('javascript') || ct.includes('html') || ct.includes('css')) return 'rest';
  if (ct) return 'binary';
  return 'rest';
}

// Sustituye segmentos que parezcan IDs por :param
function urlTemplate(pathname) {
  return pathname.split('/').map(seg => {
    if (!seg) return seg;
    const isNum = /^\d+$/.test(seg);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg);
    const isHash = /^[0-9a-f]{16,}$/i.test(seg);
    const hasDigits = /\d/.test(seg) && seg.length > 8;
    return (isNum || isUuid || isHash || hasDigits) ? ':param' : seg;
  }).join('/');
}

function detectPagination(u, bodyObj) {
  const qp = [...u.searchParams.keys()];
  const reqParams = qp.filter(k => /^(page|offset|cursor|limit|per_page|pagesize|start)$/i.test(k));
  const responseSignals = [];
  if (bodyObj && typeof bodyObj === 'object') {
    for (const k of ['nextCursor', 'next', 'hasMore', 'has_more', 'nextPage', 'total', 'totalPages']) {
      if (k in bodyObj) responseSignals.push(k);
    }
  }
  let type = 'none';
  if (reqParams.some(p => /cursor/i.test(p))) type = 'cursor';
  else if (reqParams.some(p => /offset|start/i.test(p))) type = 'offset';
  else if (reqParams.some(p => /page/i.test(p))) type = 'page';
  return { type, requestParams: reqParams, responseSignals };
}

function safeJson(text) { try { return JSON.parse(text); } catch { return undefined; } }
function pick(headers, names) {
  const out = [];
  for (const n of names) if (headers[n] !== undefined) out.push(n);
  return out;
}

// ---- Estado de captura (deduplicado, hasta 3 ejemplos) ----
const endpoints = new Map(); // key -> endpoint
const MAX_EXAMPLES = 3;
let authMechanism = 'desconocido';

function keyFor(method, tmpl, kind, gqlName) {
  return kind === 'graphql' && gqlName ? `GQL:${gqlName}` : `${method} ${tmpl}`;
}

async function main() {
  const executablePath = findChromium();
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (executablePath) launchOpts.executablePath = executablePath;
  if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY };

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Websockets
  page.on('websocket', ws => {
    const u = new URL(ws.url());
    const tmpl = urlTemplate(u.pathname);
    const key = `WS ${tmpl}`;
    const ep = endpoints.get(key) || {
      id: key, method: 'GET', urlTemplate: tmpl, kind: 'websocket',
      queryParams: {}, requestHeaders: {}, authHeaders: [],
      requestBodyExamples: [], responseStatus: 101, responseHeaders: {},
      responseBodyExamples: [], frames: [], pagination: { type: 'none', requestParams: [], responseSignals: [] },
      notes: 'websocket',
    };
    ws.on('framesent', f => ep.frames.length < 6 && ep.frames.push({ dir: 'sent', payloadExample: String(f.payload).slice(0, 500) }));
    ws.on('framereceived', f => ep.frames.length < 12 && ep.frames.push({ dir: 'received', payloadExample: String(f.payload).slice(0, 500) }));
    endpoints.set(key, ep);
  });

  // Respuestas HTTP
  context.on('response', async (response) => {
    try {
      const request = response.request();
      const method = request.method();
      const u = new URL(response.url());
      if (u.origin !== origin) return; // solo mismo origen (los terceros/estáticos se omiten del cliente)
      const reqHeaders = await request.allHeaders();
      const resHeaders = await response.allHeaders();
      const ct = resHeaders['content-type'] || '';
      const postData = request.postData() || '';
      const isGraphql = /\/graphql/i.test(u.pathname) || /\"operationName\"|\"query\"\s*:/.test(postData);
      const kind = classify(u.href, ct, isGraphql);

      let bodyExample, bodyObj;
      if (kind === 'binary') {
        bodyExample = { _meta: { contentType: ct, contentLength: resHeaders['content-length'] || null } };
      } else {
        try {
          const text = await response.text();
          bodyObj = safeJson(text);
          bodyExample = bodyObj !== undefined ? bodyObj : text.slice(0, 2000);
        } catch { bodyExample = { _meta: { note: 'sin cuerpo o no legible', contentType: ct } }; }
      }

      // detectar mecanismo de auth (best-effort)
      if (reqHeaders['authorization']) authMechanism = /^bearer /i.test(reqHeaders['authorization']) ? 'bearer' : 'apikey';
      else if (reqHeaders['cookie'] && authMechanism === 'desconocido') authMechanism = 'cookie-session';

      let gqlName, gqlBlock;
      if (kind === 'graphql') {
        const pj = safeJson(postData) || {};
        gqlName = pj.operationName || 'anon';
        gqlBlock = { operationName: gqlName, operationType: /mutation/i.test(pj.query || '') ? 'mutation' : 'query', query: (pj.query || '').slice(0, 1500), variables: pj.variables || {} };
      }

      const tmpl = urlTemplate(u.pathname);
      const key = keyFor(method, tmpl, kind, gqlName);
      let ep = endpoints.get(key);
      if (!ep) {
        ep = {
          id: key, method, urlTemplate: tmpl, kind,
          queryParams: Object.fromEntries(u.searchParams),
          requestHeaders: reqHeaders, authHeaders: pick(reqHeaders, AUTH_HEADERS),
          requestBodyExamples: [], responseStatus: response.status(),
          responseHeaders: { 'content-type': ct }, responseBodyExamples: [],
          pagination: detectPagination(u, bodyObj), notes: '',
        };
        if (gqlBlock) ep.graphql = gqlBlock;
        endpoints.set(key, ep);
      }
      if (postData && ep.requestBodyExamples.length < MAX_EXAMPLES) ep.requestBodyExamples.push(safeJson(postData) ?? postData.slice(0, 1000));
      if (ep.responseBodyExamples.length < MAX_EXAMPLES) ep.responseBodyExamples.push(bodyExample);
    } catch { /* best-effort: ignora este response */ }
  });

  // ---- Navegación: home + descubre enlaces del mismo origen ----
  const visited = new Set();
  const capturedSections = [];
  async function visit(url) {
    if (visited.has(url) || visited.size >= MAX_PAGES) return;
    visited.add(url);
    capturedSections.push(url);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1500);
    } catch (e) { console.error('aviso: fallo al cargar', url, e.message); }
  }
  await visit(START_URL);

  // extrae enlaces internos de la home para recorrer secciones reales (no adivina rutas)
  let links = [];
  try {
    links = await page.$$eval('a[href]', as => as.map(a => a.href));
  } catch {}
  const internal = [...new Set(links)]
    .filter(h => { try { return new URL(h).origin === origin; } catch { return false; } })
    .filter(h => !/\.(pdf|jpg|jpeg|png|svg|zip|mp4)(\?|$)/i.test(h));
  for (const h of internal) { if (visited.size >= MAX_PAGES) break; await visit(h); }

  await context.close();
  await browser.close();

  // ---- Ensamblar salida ----
  const out = {
    meta: {
      baseUrl: origin,
      capturedAt: new Date().toISOString(),
      playwrightVersion: '1.56.1',
      browser: 'chromium-1194',
      authMechanism,
      capturedSections,
      notes: `Captura pública headless. ${endpoints.size} endpoints únicos del mismo origen.`,
    },
    endpoints: [...endpoints.values()],
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`OK -> ${OUT}`);
  console.log(`Secciones recorridas: ${capturedSections.length} | Endpoints únicos: ${endpoints.size}`);
  const byKind = {};
  for (const e of out.endpoints) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  console.log('Por tipo:', JSON.stringify(byKind));
  console.log('Con auth:', out.endpoints.filter(e => e.authHeaders.length).length);
}

main().catch(e => { console.error(e); process.exit(1); });
