'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createServer } = require('../src/index');

const WEB_SRC = path.resolve(__dirname, '../../web/src');

function withServer(handler) {
  const server = createServer({ webDir: WEB_SRC });
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const port = server.address().port;
      try {
        await handler(port);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, path: p, method, headers: body ? { 'content-type': 'application/json' } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('GET /healthz returns ok JSON', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
  }));

test('POST /api/review analyzes a conflict-free grammar', () =>
  withServer(async (port) => {
    const res = await request(
      port,
      'POST',
      '/api/review',
      JSON.stringify({
        terminals: 'id +',
        nonterminals: 'E',
        start: 'E',
        productions: 'E -> E + id\nE -> id',
      })
    );
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.analysis.conflictFree, true);
  }));

test('POST /api/review returns validation errors for bad grammar', () =>
  withServer(async (port) => {
    const res = await request(
      port,
      'POST',
      '/api/review',
      JSON.stringify({ terminals: 'id', nonterminals: 'E', start: 'E', productions: 'E -> Q' })
    );
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, false);
    assert.ok(data.errors.some((e) => e.code === 'undefined-symbol'));
  }));

test('POST /api/review reports shift/reduce conflict evidence', () =>
  withServer(async (port) => {
    const res = await request(
      port,
      'POST',
      '/api/review',
      JSON.stringify({
        terminals: 'id +',
        nonterminals: 'E',
        start: 'E',
        productions: 'E -> E + E\nE -> id',
      })
    );
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.analysis.firstConflict.type, 'shift-reduce');
  }));

test('malformed JSON body yields 400', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/review', '{not json');
    assert.equal(res.status, 400);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, false);
    assert.ok(data.errors.some((e) => e.code === 'bad-request'));
  }));

test('GET / serves the review page', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /LR/);
  }));
