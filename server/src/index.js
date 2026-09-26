'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { reviewSpec } = require('./review');

const MAX_BODY = 1024 * 1024; // 1 MiB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveWebDir() {
  if (process.env.WEB_DIR) return path.resolve(process.env.WEB_DIR);
  const dist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  return path.resolve(__dirname, '../../web/src');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, webDir, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(webDir, rel));
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(options) {
  const webDir = (options && options.webDir) || resolveWebDir();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if ((pathname === '/healthz' || pathname === '/health') && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (pathname === '/api/review') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, errors: [{ code: 'method-not-allowed', message: 'use POST' }] });
        return;
      }
      let spec;
      try {
        const raw = await readBody(req);
        spec = JSON.parse(raw || '{}');
      } catch (err) {
        sendJson(res, 400, { ok: false, errors: [{ code: 'bad-request', message: `请求体不是合法 JSON：${err.message}` }] });
        return;
      }
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        sendJson(res, 400, { ok: false, errors: [{ code: 'bad-request', message: '请求体必须是 JSON 对象' }] });
        return;
      }
      const result = reviewSpec({
        terminals: String(spec.terminals == null ? '' : spec.terminals),
        nonterminals: String(spec.nonterminals == null ? '' : spec.nonterminals),
        start: String(spec.start == null ? '' : spec.start),
        productions: String(spec.productions == null ? '' : spec.productions),
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, webDir, pathname);
      return;
    }

    sendJson(res, 404, { ok: false, errors: [{ code: 'not-found', message: 'not found' }] });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, () => {
    console.log(`lr1-review server listening on :${port}`);
  });
}

module.exports = { createServer, resolveWebDir };
