#!/usr/bin/env node
'use strict';

/**
 * One-shot acceptance service ("verify").
 *
 * Phases:
 *   1. code tests        — node --test over the server test suite (grammar,
 *                          LR(1), the precedence/associativity resolver, the
 *                          stale-response guard, HTTP API)
 *   2. page build check  — run web/build.js and validate emitted artifacts
 *   3. API/HTTP smoke    — against a running app service (APP_URL):
 *        - health endpoint responds ok
 *        - review page is served
 *        - conflict-free grammar: conflict-free analysis, no strategy needed,
 *          resolved table identical to the review table
 *        - + / * ambiguous grammar: minimal 2-level policy (* above +), every
 *          shift/reduce conflict itemised with level/associativity/final action
 *        - ^ recursive grammar: right-associative one-level policy, the
 *          same-priority tie uniquely shifts
 *        - reduce/reduce grammar: first conflict kept, no available strategy
 *        - invalid grammar: located validation errors
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const HEALTH_TIMEOUT_MS = Number(process.env.VERIFY_HEALTH_TIMEOUT_MS || 60000);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function runCmd(name, cmd, args, opts) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', ...opts });
    record(name, true);
    return true;
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
    record(name, false, out.split('\n').slice(-12).join(' | ') || err.message);
    return false;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/healthz`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.status === 'ok') return true;
        lastErr = `unexpected body ${JSON.stringify(body)}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[verify] app at ${APP_URL} did not become healthy: ${lastErr}`);
  return false;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
    return true;
  } catch (err) {
    record(name, false, err.message);
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function postReview(spec) {
  const res = await fetch(`${APP_URL}/api/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  assert(res.status === 200, `POST /api/review -> HTTP ${res.status}`);
  return res.json();
}

function assertConflictEvidence(conflict, expectType) {
  assert(conflict, 'firstConflict missing');
  assert(conflict.type === expectType, `expected ${expectType}, got ${conflict.type}`);
  assert(Number.isInteger(conflict.state) && conflict.state >= 0, 'conflict state missing');
  assert(typeof conflict.lookahead === 'string' && conflict.lookahead.length > 0, 'lookahead missing');
  assert(Array.isArray(conflict.actions) && conflict.actions.length === 2, 'expected exactly two competing actions');
  for (const action of conflict.actions) {
    assert(typeof action.text === 'string' && action.text.length > 0, 'action text missing');
    assert(Array.isArray(action.items) && action.items.length > 0, 'competing items missing');
  }
  assert(conflict.prefix && Array.isArray(conflict.prefix.symbols), 'prefix evidence missing');
  assert(Array.isArray(conflict.prefix.states) && conflict.prefix.states[0] === 0, 'prefix path must start at state 0');
  assert(conflict.prefix.states[conflict.prefix.states.length - 1] === conflict.state,
    'prefix path must end at the conflict state');
  assert(Array.isArray(conflict.stateItems) && conflict.stateItems.length > 0, 'state items missing');
}

function simulatePrefix(analysis, conflict) {
  let s = 0;
  for (const sym of conflict.prefix.symbols) {
    const target = analysis.states[s] && analysis.states[s].transitions[sym];
    assert(target !== undefined, `prefix symbol ${sym} has no transition from state ${s}`);
    s = target;
  }
  assert(s === conflict.state, `prefix evidence lands in state ${s}, expected ${conflict.state}`);
}

async function main() {
  console.log(`[verify] root=${ROOT} app=${APP_URL}`);

  // ---- phase 1: code tests -------------------------------------------------
  runCmd('code tests (node --test)', process.execPath, ['--test', 'server/test/']);

  // ---- phase 2: page build check -------------------------------------------
  const distDir = path.join(ROOT, 'web/dist');
  const built = runCmd('page build (web/build.js --check)', process.execPath,
    ['web/build.js', '--src', 'web/src', '--out', 'web/dist', '--check']);
  if (built) {
    await check('page artifacts present', async () => {
      for (const name of ['index.html', 'app.js', 'styles.css', 'build-info.json']) {
        assert(fs.existsSync(path.join(distDir, name)), `missing dist/${name}`);
      }
      const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
      assert(html.includes('id="grammar-form"'), 'review form missing from built page');
      return 'dist artifacts verified';
    });
  }

  // ---- phase 3: API / HTTP smoke -------------------------------------------
  const healthy = await waitForHealth();
  record('health endpoint responds ok', healthy, healthy ? `${APP_URL}/healthz` : undefined);

  if (healthy) {
    await check('review page served over HTTP', async () => {
      const res = await fetch(`${APP_URL}/`);
      assert(res.status === 200, `GET / -> HTTP ${res.status}`);
      const html = await res.text();
      assert(html.includes('id="grammar-form"'), 'page does not contain the review form');
      for (const asset of ['app.js', 'stale-guard.js', 'styles.css']) {
        const r = await fetch(`${APP_URL}/${asset}`);
        assert(r.status === 200, `GET /${asset} -> HTTP ${r.status}`);
      }
      return 'page and assets reachable';
    });

    await check('conflict-free grammar analysis', async () => {
      const data = await postReview({
        terminals: 'id + * ( )',
        nonterminals: 'E T F',
        start: 'E',
        productions: 'E -> E + T\nE -> T\nT -> T * F\nT -> F\nF -> ( E )\nF -> id',
      });
      assert(data.ok === true, `review failed: ${JSON.stringify(data.errors)}`);
      assert(data.analysis.conflictFree === true, 'expected conflictFree');
      assert(data.analysis.conflictCount === 0, 'expected zero conflicts');
      assert(data.analysis.states.length === 22, `expected 22 canonical states, got ${data.analysis.states.length}`);
      assert(Array.isArray(data.analysis.actionTable), 'action table missing');
      const accepts = data.analysis.actionTable.flatMap((r) => Object.values(r.actions).flat())
        .filter((a) => a.type === 'accept');
      assert(accepts.length === 1, 'expected exactly one accept action');
      // No strategy needed and the resolved table stays identical to review.
      assert(data.analysis.strategy.status === 'unneeded', 'expected no strategy to be needed');
      assert(data.analysis.strategy.tableMatchesReview === true, 'table consistency flag missing');
      assert(
        JSON.stringify(data.analysis.resolvedActionTable.map((r) => r.actions))
          === JSON.stringify(data.analysis.actionTable.map((r) => r.actions)),
        'resolved table must equal the review table when there are no conflicts');
      return `states=${data.analysis.states.length}`;
    });

    await check('+ / * ambiguous grammar: minimal two-level policy itemised per conflict', async () => {
      const data = await postReview({
        terminals: 'id + *',
        nonterminals: 'E',
        start: 'E',
        productions: 'E -> E + E\nE -> E * E\nE -> id',
      });
      assert(data.ok === true, `review failed: ${JSON.stringify(data.errors)}`);
      assert(data.analysis.conflictFree === false, 'expected conflicts');
      const st = data.analysis.strategy;
      assert(st.status === 'resolved', `expected resolved policy, got ${st.status}`);
      assert(st.exact === true, 'policy must be an exact minimum-level solution');
      assert(st.levelCount === 2, `expected 2 levels (* above +), got ${st.levelCount}`);
      assert(st.levels[0].symbols.map((s) => s.symbol).includes('+'), 'level 1 must hold +');
      assert(st.levels[1].symbols.map((s) => s.symbol).includes('*'), 'level 2 must hold *');
      assert(st.conflicts.length === data.analysis.conflictCount, 'every conflict must be itemised');

      const finals = { shift: 0, reduce: 0 };
      for (const c of st.conflicts) {
        assert(c.type === 'shift-reduce', `I${c.state}/${c.lookahead} must be shift/reduce`);
        assert(c.actions.length === 2, 'competing actions must be presented');
        assert(c.resolution.resolvable === true, 'decision must be resolvable');
        assert(['level', 'associativity'].includes(c.resolution.basis), 'decision basis missing');
        assert(c.resolution.precedence.length === 2, 'both precedence operands missing');
        for (const p of c.resolution.precedence) {
          assert(p && Number.isInteger(p.level), 'precedence level missing');
        }
        assert(c.resolution.finalAction, 'final action missing');
        assert(['shift', 'reduce'].includes(c.resolution.finalAction.type), 'bad final action');
        finals[c.resolution.finalAction.type] += 1;
      }
      // Precedence semantics: * vs + => shift (build products); + vs * => reduce.
      const starVsPlus = st.conflicts.find(
        (c) => c.lookahead === '*' && c.resolution.precedence[1].symbol === '+');
      assert(starVsPlus && starVsPlus.resolution.finalAction.type === 'shift', '* above + must shift');
      const plusVsStar = st.conflicts.find(
        (c) => c.lookahead === '+' && c.resolution.precedence[1].symbol === '*');
      assert(plusVsStar && plusVsStar.resolution.finalAction.type === 'reduce', '* above + must reduce on +');
      // Every conflict cell collapses to exactly one action in the resolved table.
      for (const c of st.conflicts) {
        const cell = data.analysis.resolvedActionTable[c.state].actions[c.lookahead];
        assert(Array.isArray(cell) && cell.length === 1, `cell I${c.state}/${c.lookahead} must converge to one action`);
      }
      return `levels=${st.levelCount} shifts=${finals.shift} reduces=${finals.reduce}`;
    });

    await check('^ recursive grammar: right-associative unique tie-break', async () => {
      const data = await postReview({
        terminals: 'id ^',
        nonterminals: 'E',
        start: 'E',
        productions: 'E -> E ^ E\nE -> id',
      });
      assert(data.ok === true, `review failed: ${JSON.stringify(data.errors)}`);
      assert(data.analysis.conflictFree === false, 'expected a conflict');
      const st = data.analysis.strategy;
      assert(st.status === 'resolved', `expected resolved policy, got ${st.status}`);
      assert(st.levelCount === 1, `expected one level, got ${st.levelCount}`);
      assert(st.levels[0].symbols[0].symbol === '^', 'level symbol must be ^');
      assert(st.levels[0].symbols[0].associativity === 'right', '^ must be right-associative');
      assert(st.conflicts.length === 1, 'expected exactly one same-priority conflict');
      const d = st.conflicts[0].resolution;
      assert(d.basis === 'associativity', 'same-level tie must be an associativity decision');
      assert(d.associativity === 'right', '^ must be right-associative');
      assert(d.finalAction.type === 'shift', 'right-associative tie must uniquely shift');
      const cell = data.analysis.resolvedActionTable[st.conflicts[0].state].actions['^'];
      assert(cell.length === 1 && cell[0].type === 'shift', 'resolved cell must be the unique shift');
      return 'right-assoc shift';
    });

    await check('shift/reduce conflict evidence', async () => {
      const data = await postReview({
        terminals: 'id +',
        nonterminals: 'E',
        start: 'E',
        productions: 'E -> E + E\nE -> id',
      });
      assert(data.ok === true, `review failed: ${JSON.stringify(data.errors)}`);
      assert(data.analysis.conflictFree === false, 'expected conflicts');
      const c = data.analysis.firstConflict;
      assertConflictEvidence(c, 'shift-reduce');
      simulatePrefix(data.analysis, c);
      // A lone '+' is a left-associative self-conflict that reduces.
      const st = data.analysis.strategy;
      assert(st.status === 'resolved', 'plus-only grammar must be resolvable');
      assert(st.conflicts.every((d) => d.resolution.finalAction.type === 'reduce'),
        'left-associative + ties must reduce');
      return `state=I${c.state} lookahead=${c.lookahead} actions=${c.actions.map((a) => a.short).join(' vs ')}`;
    });

    await check('reduce/reduce conflict: first conflict kept and no strategy exists', async () => {
      const data = await postReview({
        terminals: 'x',
        nonterminals: 'S A B',
        start: 'S',
        productions: 'S -> A\nS -> B\nA -> x\nB -> x',
      });
      assert(data.ok === true, `review failed: ${JSON.stringify(data.errors)}`);
      assert(data.analysis.conflictFree === false, 'expected conflicts');
      const c = data.analysis.firstConflict;
      assertConflictEvidence(c, 'reduce-reduce');
      simulatePrefix(data.analysis, c);
      const st = data.analysis.strategy;
      assert(st.status === 'unresolvable', 'reduce/reduce must have no available strategy');
      assert(st.levelCount === 0, 'no precedence levels may be emitted for reduce/reduce');
      assert(st.resolvedConflictCount === 0 && st.unresolvedConflictCount === 1, 'counts mismatch');
      const d = st.conflicts[0];
      assert(d.resolution.resolvable === false, 'decision must stay unresolved');
      assert(d.resolution.finalAction === null, 'no final action may be chosen');
      assert(d.actions.length === 2, 'both competing productions must be retained');
      // The unresolved cell keeps BOTH actions: no default shift / prod-order pick.
      const cell = data.analysis.resolvedActionTable[c.state].actions[c.lookahead];
      assert(cell.length === 2, 'unresolved cell must retain both competing actions');
      assert(cell.map((a) => a.short).join(',') === c.actions.map((a) => a.short).join(','),
        'retained actions must match the raw review actions');
      return `state=I${c.state} lookahead=${c.lookahead} actions=${c.actions.map((a) => a.short).join(' vs ')}`;
    });

    await check('invalid grammar is rejected with located errors', async () => {
      const data = await postReview({
        terminals: 'id',
        nonterminals: 'E',
        start: 'E',
        productions: 'E -> Q\nE -> id\nE -> id',
      });
      assert(data.ok === false, 'expected ok=false');
      assert(data.errors.some((e) => e.code === 'undefined-symbol' && e.symbol === 'Q'),
        'undefined-symbol error missing');
      assert(data.errors.some((e) => e.code === 'duplicate-production'),
        'duplicate-production error missing');
      return 'validation errors located';
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[verify] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`[verify] FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
  console.log('[verify] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(`[verify] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
