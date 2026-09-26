'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConflicts, associativityFor, minimumLevels } = require('../src/resolver');

test('associativity is encoded by terminal identity (exponentiation right, others left)', () => {
  assert.equal(associativityFor('^'), 'right');
  assert.equal(associativityFor('**'), 'right');
  assert.equal(associativityFor('↑'), 'right');
  assert.equal(associativityFor('+'), 'left');
  assert.equal(associativityFor('*'), 'left');
  assert.equal(associativityFor('id'), 'left');
});

test('minimumLevels colours a triangle with exactly three levels', () => {
  const lv = minimumLevels(['+', '*', '-'], [['+', '*'], ['*', '-'], ['+', '-']]);
  assert.deepEqual([...new Set(lv.values())].sort((a, b) => a - b), [1, 2, 3]);
});

test('minimumLevels uses one level per connected edge when bipartite', () => {
  const lv = minimumLevels(['+', '*'], [['+', '*']]);
  assert.deepEqual(lv.get('+'), 1);
  assert.deepEqual(lv.get('*'), 2);
});

test('minimumLevels is stable: earlier declared terminal keeps the lower level', () => {
  const a = minimumLevels(['+', '*'], [['+', '*']]);
  const b = minimumLevels(['+', '*'], [['*', '+']]); // edge direction must not matter
  assert.equal(a.get('+'), b.get('+'));
  assert.equal(a.get('*'), b.get('*'));
});

function srConflict(state, lookahead, prodSymbol) {
  return {
    state,
    lookahead,
    candidates: [
      { kind: 'shift', prodIndex: null, symbol: lookahead },
      { kind: 'reduce', prodIndex: 1, symbol: prodSymbol },
    ],
  };
}

test('+ / * cross conflicts need two levels and self conflicts tie left-associative', () => {
  const conflicts = [
    srConflict(5, '+', '+'),
    srConflict(5, '*', '+'),
    srConflict(6, '+', '*'),
    srConflict(6, '*', '*'),
  ];
  const r = resolveConflicts(conflicts, { terminals: ['id', '+', '*', '$'] });
  assert.equal(r.status, 'resolved');
  assert.equal(r.levelCount, 2, 'must minimize to two levels');
  assert.equal(r.levels[0].level, 1);
  assert.equal(r.levels[0].symbols[0].symbol, '+');
  assert.equal(r.levels[1].symbols[0].symbol, '*');

  // la * vs prod + => lookahead higher => shift
  assert.equal(r.decisions[1].winnerIndex, 0);
  assert.equal(r.decisions[1].basis, 'level');
  assert.equal(r.decisions[1].finalAction, 'shift');
  // la + vs prod * => production higher => reduce
  assert.equal(r.decisions[2].winnerIndex, 1);
  assert.equal(r.decisions[2].finalAction, 'reduce');
  // same-level ties resolved left-associatively => reduce
  assert.equal(r.decisions[0].basis, 'associativity');
  assert.equal(r.decisions[0].associativity, 'left');
  assert.equal(r.decisions[0].finalAction, 'reduce');
  assert.equal(r.decisions[3].finalAction, 'reduce');
});

test('^ self conflict is uniquely settled right-associatively (shift)', () => {
  const r = resolveConflicts([srConflict(4, '^', '^')], { terminals: ['id', '^', '$'] });
  assert.equal(r.status, 'resolved');
  assert.equal(r.levelCount, 1, 'a single operator needs only one level');
  const d = r.decisions[0];
  assert.equal(d.basis, 'associativity');
  assert.equal(d.associativity, 'right');
  assert.equal(d.winnerIndex, 0);
  assert.equal(d.finalAction, 'shift');
  assert.ok(d.reasonText.includes('右结合'));
});

test('reduce/reduce conflict keeps competing actions and reports no strategy', () => {
  const conflicts = [{
    state: 4,
    lookahead: '$',
    candidates: [
      { kind: 'reduce', prodIndex: 2, symbol: 'x' },
      { kind: 'reduce', prodIndex: 3, symbol: 'x' },
    ],
  }];
  const r = resolveConflicts(conflicts, { terminals: ['x', '$'] });
  assert.equal(r.status, 'unresolvable');
  assert.equal(r.levelCount, 0);
  assert.equal(r.decisions[0].resolvable, false);
  assert.equal(r.decisions[0].winnerIndex, null);
  assert.equal(r.decisions[0].reasonCode, 'reduce-reduce');
});

test('empty conflict list reports that no strategy is needed', () => {
  const r = resolveConflicts([], { terminals: ['id', '$'] });
  assert.equal(r.status, 'unneeded');
  assert.deepEqual(r.decisions, []);
  assert.equal(r.levelCount, 0);
});
