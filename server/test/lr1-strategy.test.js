'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeGrammar } = require('../src/lr1');
const { parseGrammarSpec } = require('../src/grammar');

function build(spec) {
  const parsed = parseGrammarSpec(spec);
  assert.equal(parsed.ok, true, parsed.errors.map((e) => e.message).join('; '));
  return analyzeGrammar(parsed.grammar);
}

test('+ / * expression grammar yields a minimal two-level strategy (* above +)', () => {
  const a = build({
    terminals: 'id + *',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + E\nE -> E * E\nE -> id',
  });
  assert.equal(a.conflictFree, false);
  assert.equal(a.conflictCount, 4);
  const st = a.strategy;
  assert.equal(st.status, 'resolved');
  assert.equal(st.exact, true);
  assert.equal(st.levelCount, 2, 'minimum number of levels must be 2');
  assert.deepEqual(st.levels.map((l) => l.symbols.map((s) => s.symbol)), [['+'], ['*']]);
  assert.equal(st.unresolvedConflictCount, 0);
  assert.equal(st.conflicts.length, 4);

  // Every itemised decision carries level/associativity and a unique action.
  for (const c of st.conflicts) {
    assert.ok(c.resolution.reasonText.length > 0);
    assert.ok(['level', 'associativity'].includes(c.resolution.basis));
    assert.ok(c.resolution.finalAction);
    assert.equal(c.actions.length, 2);
  }
  // lookahead * vs production + => lookahead higher => shift
  const starShift = st.conflicts.find(
    (c) => c.lookahead === '*' && c.resolution.precedence[1].symbol === '+');
  assert.ok(starShift, 'expected lookahead-* vs production-+ decision');
  assert.equal(starShift.resolution.finalAction.type, 'shift');
  // lookahead + vs production * => production higher => reduce
  const plusReduce = st.conflicts.find(
    (c) => c.lookahead === '+' && c.resolution.precedence[1].symbol === '*');
  assert.ok(plusReduce, 'expected lookahead-+ vs production-* decision');
  assert.equal(plusReduce.resolution.finalAction.type, 'reduce');
});

test('resolved table collapses every + / * conflict cell to a single action', () => {
  const a = build({
    terminals: 'id + *',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + E\nE -> E * E\nE -> id',
  });
  let collapsed = 0;
  let unchanged = 0;
  for (const raw of a.actionTable) {
    const res = a.resolvedActionTable[raw.state];
    for (const t of a.terminals) {
      const rawN = (raw.actions[t] || []).length;
      const resN = (res.actions[t] || []).length;
      if (rawN > 1) {
        assert.equal(resN, 1, `cell I${raw.state}/${t} must collapse to one action`);
        collapsed += 1;
      }
      if (rawN === 1) unchanged += 1;
    }
    assert.deepEqual(raw.gotos, res.gotos);
  }
  assert.equal(collapsed, a.conflictCount);
  assert.ok(unchanged > 0, 'non-conflict cells must be preserved verbatim');
});

test('^ recursive grammar gets a right-associative one-level strategy (shift)', () => {
  const a = build({
    terminals: 'id ^',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E ^ E\nE -> id',
  });
  assert.equal(a.conflictFree, false);
  const st = a.strategy;
  assert.equal(st.status, 'resolved');
  assert.equal(st.levelCount, 1);
  assert.equal(st.levels[0].symbols[0].symbol, '^');
  assert.equal(st.levels[0].symbols[0].associativity, 'right');
  assert.equal(st.conflicts.length, 1);
  const d = st.conflicts[0].resolution;
  assert.equal(d.basis, 'associativity');
  assert.equal(d.associativity, 'right');
  assert.equal(d.finalAction.type, 'shift');
});

test('S -> A | B ; A -> x ; B -> x keeps the first reduce/reduce conflict with no strategy', () => {
  const a = build({
    terminals: 'x',
    nonterminals: 'S A B',
    start: 'S',
    productions: 'S -> A\nS -> B\nA -> x\nB -> x',
  });
  const c = a.firstConflict;
  assert.equal(c.type, 'reduce-reduce');
  assert.equal(c.actions.length, 2);
  assert.ok(c.actions[0].productionText.includes('A -> x'));
  assert.ok(c.actions[1].productionText.includes('B -> x'));

  const st = a.strategy;
  assert.equal(st.status, 'unresolvable');
  assert.equal(st.levelCount, 0);
  assert.equal(st.resolvedConflictCount, 0);
  assert.equal(st.unresolvedConflictCount, 1);
  const d = st.conflicts[0];
  assert.equal(d.resolution.resolvable, false);
  assert.equal(d.resolution.finalAction, null);
  assert.equal(d.resolution.reasonCode, 'reduce-reduce');

  // Unresolved cells keep BOTH competing actions: no default shift, no
  // production-order tie-break.
  const cell = a.resolvedActionTable[c.state].actions[c.lookahead];
  assert.deepEqual(cell.map((x) => x.short), c.actions.map((x) => x.short));
});

test('conflict-free grammar needs no strategy and both tables are identical', () => {
  const a = build({
    terminals: 'id + * ( )',
    nonterminals: 'E T F',
    start: 'E',
    productions: 'E -> E + T\nE -> T\nT -> T * F\nT -> F\nF -> ( E )\nF -> id',
  });
  assert.equal(a.conflictFree, true);
  assert.equal(a.strategy.status, 'unneeded');
  assert.equal(a.strategy.tableMatchesReview, true);
  assert.deepEqual(a.resolvedActionTable, a.actionTable);
});
