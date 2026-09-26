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

test('expression grammar is conflict free and has canonical 22 LR(1) states', () => {
  const a = build({
    terminals: 'id + * ( )',
    nonterminals: 'E T F',
    start: 'E',
    productions: 'E -> E + T\nE -> T\nT -> T * F\nT -> F\nF -> ( E )\nF -> id',
  });
  assert.equal(a.conflictFree, true);
  assert.equal(a.conflictCount, 0);
  assert.equal(a.states.length, 22);
  assert.equal(a.firstConflict, null);
});

test('nullable computation handles epsilon chains', () => {
  const a = build({
    terminals: 'a',
    nonterminals: 'S A B C',
    start: 'S',
    productions: 'S -> A a\nA -> B C\nB -> ε\nC ->',
  });
  assert.deepEqual(a.nullable.sort(), ['A', 'B', 'C']);
  assert.ok(!a.nullable.includes('S'));
});

test('FIRST sets include epsilon propagation and terminals', () => {
  const a = build({
    terminals: 'a b',
    nonterminals: 'S A B C',
    start: 'S',
    productions: 'S -> A B a\nA -> ε\nA -> a\nB -> ε\nB -> b\nC -> C a | b',
  });
  assert.deepEqual(a.first.A.sort(), ['a']);
  assert.deepEqual(a.first.B.sort(), ['b']);
  // FIRST(S) contains a (from a) and b (via B)
  assert.deepEqual(a.first.S.sort(), ['a', 'b']);
  assert.deepEqual(a.first.C.sort(), ['b']);
});

test('left-recursive grammar with epsilon: nullable FIRST used in closure', () => {
  // A -> A α | ε style with terminal
  const a = build({
    terminals: 'x',
    nonterminals: 'L',
    start: 'L',
    productions: 'L -> L x\nL -> ε',
  });
  assert.equal(a.conflictFree, true);
  assert.deepEqual(a.nullable, ['L']);
  assert.deepEqual(a.first.L, ['x']);
});

test('exactly one accept action on $ in the whole table', () => {
  const a = build({
    terminals: 'id +',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + id\nE -> id',
  });
  let accepts = 0;
  for (const row of a.actionTable) {
    for (const acts of Object.values(row.actions)) {
      if (acts.some((x) => x.type === 'accept')) accepts += 1;
    }
  }
  assert.equal(accepts, 1);
});

test('shift/reduce conflict reports state, lookahead, competing items and prefix', () => {
  const a = build({
    terminals: 'id +',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + E\nE -> id',
  });
  assert.equal(a.conflictFree, false);
  const c = a.firstConflict;
  assert.equal(c.type, 'shift-reduce');
  assert.equal(c.lookahead, '+');
  const types = c.actions.map((x) => x.type).sort();
  assert.deepEqual(types, ['reduce', 'shift']);
  // Both competing items mention E and the + lookahead.
  const allItems = c.actions.flatMap((x) => x.items);
  assert.ok(allItems.some((i) => i.text.includes('E -> E · + E')));
  assert.ok(allItems.some((i) => i.text.includes('E -> E + E ·')));
  // Prefix evidence is a valid transition path from state 0.
  let s = 0;
  for (const sym of c.prefix.symbols) s = a.states[s].transitions[sym];
  assert.equal(s, c.state);
  assert.deepEqual(c.prefix.states[0], 0);
  assert.deepEqual(c.prefix.states[c.prefix.states.length - 1], c.state);
});

test('dangling-else grammar has a shift/reduce conflict on ELSE', () => {
  const a = build({
    terminals: 'IF THEN ELSE e',
    nonterminals: 'S',
    start: 'S',
    productions: 'S -> IF e THEN S\nS -> IF e THEN S ELSE S\nS -> e',
  });
  assert.equal(a.conflictFree, false);
  assert.equal(a.firstConflict.type, 'shift-reduce');
  assert.equal(a.firstConflict.lookahead, 'ELSE');
  // shortest-prefix evidence reaches the conflict state
  let s = 0;
  for (const sym of a.firstConflict.prefix.symbols) s = a.states[s].transitions[sym];
  assert.equal(s, a.firstConflict.state);
});

test('reduce/reduce conflict orders actions by production number', () => {
  const a = build({
    terminals: 'x',
    nonterminals: 'S A B',
    start: 'S',
    productions: 'S -> A\nS -> B\nA -> x\nB -> x',
  });
  assert.equal(a.conflictFree, false);
  const c = a.firstConflict;
  assert.equal(c.type, 'reduce-reduce');
  assert.equal(c.lookahead, '$');
  assert.deepEqual(c.actions.map((x) => x.type), ['reduce', 'reduce']);
  // stable order: smaller production index first
  assert.ok(c.actions[0].production < c.actions[1].production);
  assert.ok(c.actions[0].productionText.includes('A -> x'));
  assert.ok(c.actions[1].productionText.includes('B -> x'));
  // prefix evidence: reading x from state 0 lands in the conflict state
  let s = 0;
  for (const sym of c.prefix.symbols) s = a.states[s].transitions[sym];
  assert.equal(s, c.state);
});

test('state numbering is stable across repeated constructions', () => {
  const spec = {
    terminals: 'id + * ( )',
    nonterminals: 'E T F',
    start: 'E',
    productions: 'E -> E + T\nE -> T\nT -> T * F\nT -> F\nF -> ( E )\nF -> id',
  };
  const a1 = build(spec);
  const a2 = build(spec);
  const sig = (a) =>
    a.states
      .map((s) => s.items.map((i) => i.text).sort().join('&'))
      .join('||');
  assert.equal(sig(a1), sig(a2));
});

test('canonical LR(1) resolves an SLR false conflict via lookaheads (S -> L = R | R)', () => {
  // The classic Dragon-book grammar: SLR reports a shift/reduce conflict on
  // '=' but canonical LR(1) does not, because the reduce item R -> L . in the
  // relevant state does not carry '=' as a lookahead.
  const a = build({
    terminals: '= * id',
    nonterminals: 'S L R',
    start: 'S',
    productions: 'S -> L = R\nS -> R\nL -> * R\nL -> id\nR -> L',
  });
  assert.equal(a.conflictFree, true);
  assert.equal(a.conflictCount, 0);
  assert.equal(a.states.length, 14);
});

test('goto table drives consistent transitions', () => {  const a = build({
    terminals: 'a b',
    nonterminals: 'S A',
    start: 'S',
    productions: 'S -> A a\nA -> b',
  });
  for (const row of a.actionTable) {
    for (const [sym, target] of Object.entries(row.gotos)) {
      assert.ok(a.nonterminals.includes(sym));
      assert.equal(a.states[row.state].transitions[sym], target);
    }
  }
});
