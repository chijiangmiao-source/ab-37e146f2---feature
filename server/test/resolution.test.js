'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeGrammar } = require('../src/lr1');
const { parseGrammarSpec } = require('../src/grammar');

function build(spec) {
  const parsed = parseGrammarSpec(spec);
  assert.equal(parsed.ok, true, parsed.errors.map((e) => e.message).join('; '));
  return analyzeGrammar(parsed.grammar);
}

const PLUS_STAR = {
  terminals: 'id + *',
  nonterminals: 'E',
  start: 'E',
  productions: 'E -> E + E\nE -> E * E\nE -> id',
};

const CARET = {
  terminals: 'id ^',
  nonterminals: 'E',
  start: 'E',
  productions: 'E -> E ^ E\nE -> id',
};

const RR = {
  terminals: 'x',
  nonterminals: 'S A B',
  start: 'S',
  productions: 'S -> A\nS -> B\nA -> x\nB -> x',
};

function countUnresolvedCells(rows) {
  let n = 0;
  for (const row of rows) {
    for (const acts of Object.values(row.actions)) if (acts.length > 1) n += 1;
  }
  return n;
}

test('+/* grammar: a two-level strategy places * tighter than +', () => {
  const a = build(PLUS_STAR);
  assert.equal(a.conflictFree, false);
  const r = a.resolution;
  assert.equal(r.needed, true);
  assert.equal(r.possible, true);
  assert.equal(r.levels.length, 2, 'expected exactly two precedence levels');

  const symsAt = (lvl) => r.levels.find((g) => g.level === lvl).terminals.map((t) => t.symbol);
  assert.deepEqual(symsAt(1), ['*']);
  assert.deepEqual(symsAt(2), ['+']);
  // level numbering: smaller level binds tighter
  assert.ok(r.levels[0].level < r.levels[1].level);
  for (const g of r.levels) {
    for (const t of g.terminals) assert.equal(t.associativity, 'left');
  }
});

test('+/* grammar: every shift/reduce conflict records levels, associativity and a unique final action', () => {
  const a = build(PLUS_STAR);
  const r = a.resolution;
  assert.ok(r.decisions.length >= 4, `expected >=4 decisions, got ${r.decisions.length}`);
  for (const d of r.decisions) {
    assert.equal(d.kind, 'shift-reduce');
    assert.ok(['shift', 'reduce'].includes(d.winner));
    assert.equal(d.associativity, 'left');
    assert.ok(Number.isInteger(d.reduceTerminalLevel));
    assert.ok(Number.isInteger(d.lookaheadLevel));
    assert.ok(d.rule.length > 0);
    // The winning action is one of the two competitors.
    assert.ok(d.actions.some((x) => x.type === d.winner));
  }

  // Adjudication matrix for the classic ambiguous expression grammar:
  //   reduce op + / lookahead +  -> reduce  (same level, left assoc)
  //   reduce op + / lookahead *  -> shift   (* tighter)
  //   reduce op * / lookahead +  -> reduce  (* tighter)
  //   reduce op * / lookahead *  -> reduce  (same level, left assoc)
  const cell = (op, la) =>
    r.decisions.find((d) => d.reduceTerminal === op && d.lookahead === la);
  assert.equal(cell('+', '+').winner, 'reduce');
  assert.equal(cell('+', '*').winner, 'shift');
  assert.equal(cell('*', '+').winner, 'reduce');
  assert.equal(cell('*', '*').winner, 'reduce');
});

test('+/* grammar: the resolved action table is conflict free and replayable', () => {
  const a = build(PLUS_STAR);
  assert.equal(countUnresolvedCells(a.resolvedActionTable), 0);
  // Non-conflicting cells must be carried over unchanged.
  for (const raw of a.actionTable) {
    const resolved = a.resolvedActionTable[raw.state];
    for (const [t, acts] of Object.entries(raw.actions)) {
      if (acts.length === 1) assert.deepEqual(resolved.actions[t], acts);
    }
    assert.deepEqual(resolved.gotos, raw.gotos);
  }
});

test('^ grammar: a single right-associative level settles same-precedence races by shifting', () => {
  const a = build(CARET);
  const r = a.resolution;
  assert.equal(r.possible, true);
  assert.equal(r.levels.length, 1, 'right recursion needs only one level');
  assert.deepEqual(r.levels[0].terminals.map((t) => t.symbol), ['^']);
  assert.equal(r.levels[0].terminals[0].associativity, 'right');
  assert.equal(r.decisions.length, 1);
  const d = r.decisions[0];
  assert.equal(d.lookahead, '^');
  assert.equal(d.reduceTerminal, '^');
  assert.equal(d.reduceTerminalLevel, d.lookaheadLevel);
  assert.equal(d.associativity, 'right');
  assert.equal(d.winner, 'shift', 'same-precedence right-assoc race must shift');
  assert.equal(countUnresolvedCells(a.resolvedActionTable), 0);
});

test('S -> A | B; A -> x; B -> x: first reduce/reduce conflict is retained and no strategy exists', () => {
  const a = build(RR);
  const r = a.resolution;
  assert.equal(r.needed, true);
  assert.equal(r.possible, false);
  assert.deepEqual(r.levels, []);
  const u = r.firstUnresolved;
  assert.ok(u, 'firstUnresolved evidence missing');
  assert.equal(u.kind, 'reduce-reduce');
  assert.equal(u.lookahead, '$');
  assert.equal(u.reason, 'reduce-reduce');
  assert.equal(u.actions.length, 2);
  // competing items for both reductions survive
  const texts = u.actions.flatMap((x) => x.items.map((i) => i.text));
  assert.ok(texts.some((t) => t.includes('A -> x ·')));
  assert.ok(texts.some((t) => t.includes('B -> x ·')));
  // actions ordered by production number (A before B)
  assert.ok(u.actions[0].production < u.actions[1].production);
  // prefix evidence replays to the conflict state
  let s = 0;
  for (const sym of u.prefix.symbols) s = a.states[s].transitions[sym];
  assert.equal(s, u.state);
  // Without a strategy the raw (conflicting) table is preserved verbatim.
  assert.equal(countUnresolvedCells(a.resolvedActionTable), 1);
});

test('a shift/reduce conflict whose reduce production has no terminal is unsolvable', () => {
  const a = build({
    terminals: 'a b',
    nonterminals: 'S',
    start: 'S',
    productions: 'S -> S S\nS -> a',
  });
  assert.equal(a.resolution.possible, false);
  assert.equal(a.resolution.firstUnresolved.reason, 'no-terminal');
});

test('conflict-free grammar: no strategy needed and resolved table matches the review table', () => {
  const a = build({
    terminals: 'id + * ( )',
    nonterminals: 'E T F',
    start: 'E',
    productions: 'E -> E + T\nE -> T\nT -> T * F\nT -> F\nF -> ( E )\nF -> id',
  });
  assert.equal(a.conflictFree, true);
  const r = a.resolution;
  assert.equal(r.needed, false);
  assert.equal(r.possible, false);
  assert.deepEqual(r.levels, []);
  assert.match(r.summary, /无需/);
  assert.deepEqual(a.resolvedActionTable, a.actionTable);
});

test('strategy is deterministic (stable) across repeated constructions', () => {
  const sig = (a) => JSON.stringify({
    levels: a.resolution.levels,
    decisions: a.resolution.decisions.map((d) => [d.state, d.lookahead, d.winner, d.rule]),
    resolved: a.resolvedActionTable,
  });
  assert.equal(sig(build(PLUS_STAR)), sig(build(PLUS_STAR)));
  assert.equal(sig(build(CARET)), sig(build(CARET)));
});

test('declaration order encodes precedence: later-declared operator binds tighter', () => {
  // Same operators declared in the opposite order. The stable encoding follows
  // the declaration, so + now binds tighter than *.
  const a = build({
    terminals: 'id * +',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + E\nE -> E * E\nE -> id',
  });
  const r = a.resolution;
  assert.equal(r.possible, true);
  assert.deepEqual(r.levels[0].terminals.map((t) => t.symbol), ['+']);
  assert.deepEqual(r.levels[1].terminals.map((t) => t.symbol), ['*']);
  const cell = (op, la) =>
    r.decisions.find((d) => d.reduceTerminal === op && d.lookahead === la);
  assert.equal(cell('*', '+').winner, 'shift'); // + tighter -> shift the +
  assert.equal(cell('+', '*').winner, 'reduce'); // reducing inner + beats outer *
});

test('mixed ^ and + use associativity to decide equal-level races uniquely', () => {
  const a = build({
    terminals: 'id + ^',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + E\nE -> E ^ E\nE -> id',
  });
  const r = a.resolution;
  assert.equal(r.possible, true);
  // No conflict forces + and ^ apart, so the minimum solution is one level;
  // same-level races are decided purely by the lookahead terminal's associativity.
  assert.equal(r.levels.length, 1);
  const winnerFor = (la) => r.decisions.find((d) => d.lookahead === la).winner;
  assert.equal(winnerFor('+'), 'reduce'); // left-assoc lookahead
  assert.equal(winnerFor('^'), 'shift');  // right-assoc lookahead
});

// The stale-response contract lives in browser code; with no DOM harness in the
// tree we lock its invariants against the source so a regression (rendering a
// superseded/cancelled/edited response) fails the code-test phase.
test('web client never lets a stale or cancelled response overwrite the conclusion', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/app.js'), 'utf8');
  // run id is bumped on submit and on cancel
  assert.match(src, /const runId = \+\+runSeq/);
  assert.match(src, /cancelBtn\.addEventListener\('click'[\s\S]*?runSeq \+= 1/);
  // draft generation is bumped on every edit
  assert.match(src, /addEventListener\('input'[\s\S]*?draftGeneration \+= 1/);
  // the guard runs before any render of the fetched payload
  const guardIdx = src.search(/if \(runId !== runSeq \|\| generation !== draftGeneration\)/);
  const renderIdx = src.indexOf('renderResult(data');
  assert.ok(guardIdx !== -1 && renderIdx !== -1 && guardIdx < renderIdx);
  // abort path must not fall through to rendering
  assert.match(src, /if \(err\.name === 'AbortError'\) return/);
});
