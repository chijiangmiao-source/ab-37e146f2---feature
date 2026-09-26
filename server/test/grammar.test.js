'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGrammarSpec } = require('../src/grammar');

const base = {
  terminals: 'id + ( )',
  nonterminals: 'E',
  start: 'E',
  productions: 'E -> E + id\nE -> id',
};

test('parses a well-formed grammar', () => {
  const r = parseGrammarSpec(base);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.grammar.productions.length, 2);
  assert.deepEqual(r.grammar.productions[0].rhs, ['E', '+', 'id']);
  assert.equal(r.grammar.augmentedStart, "E'");
});

test('comma-separated symbol lists are accepted', () => {
  const r = parseGrammarSpec({ ...base, terminals: 'id, +, (, )', nonterminals: 'E,' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.grammar.terminals, ['id', '+', '(', ')']);
});

test('empty productions: blank RHS, ε and eps all mean epsilon', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S A B C',
    start: 'S',
    productions: 'S -> A B C\nA ->\nB -> ε\nC -> eps',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const empties = r.grammar.productions.filter((p) => p.rhs.length === 0);
  assert.equal(empties.length, 3);
});

test('epsilon token cannot be mixed with other symbols', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S',
    start: 'S',
    productions: 'S -> ε a',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'epsilon-mixed'));
});

test('alternatives with | expand to multiple productions', () => {
  const r = parseGrammarSpec({
    terminals: 'a b',
    nonterminals: 'S',
    start: 'S',
    productions: 'S -> a | b |',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.grammar.productions.length, 3);
  assert.deepEqual(r.grammar.productions.map((p) => p.rhs), [['a'], ['b'], []]);
});

test('multi-character symbols and recursion parse fine', () => {
  const r = parseGrammarSpec({
    terminals: 'IF THEN ELSE ENDIF LPAREN RPAREN',
    nonterminals: 'Stmt Expr',
    start: 'Stmt',
    productions: [
      'Stmt -> IF Expr THEN Stmt ENDIF',
      'Stmt -> IF Expr THEN Stmt ELSE Stmt ENDIF',
      'Expr -> LPAREN Expr RPAREN',
      'Expr -> IF', // IF is declared terminal; recursion via Stmt/Expr cycle above
    ].join('\n'),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.grammar.productions[0].rhs.length, 5);
});

test('comment lines and blank lines are ignored', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S',
    start: 'S',
    productions: '# leading comment\n\n// another comment\nS -> a\n   # indented comment',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.grammar.productions.length, 1);
});

test('undefined reference is located with line and symbol', () => {
  const r = parseGrammarSpec({
    terminals: 'id +',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> E + T',
  });
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => e.code === 'undefined-symbol');
  assert.ok(err, 'expected undefined-symbol error');
  assert.equal(err.symbol, 'T');
  assert.equal(err.line, 1);
});

test('illegal symbols (reserved markers) are rejected', () => {
  const r = parseGrammarSpec({
    terminals: 'id $',
    nonterminals: 'E',
    start: 'E',
    productions: 'E -> id',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'illegal-symbol' && e.symbol === '$'));
});

test('terminal used as LHS is rejected', () => {
  const r = parseGrammarSpec({
    terminals: 'id',
    nonterminals: 'E',
    start: 'E',
    productions: 'id -> id',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'lhs-not-nonterminal'));
});

test('duplicate productions are located with both lines', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S',
    start: 'S',
    productions: 'S -> a\nS -> a',
  });
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => e.code === 'duplicate-production');
  assert.ok(err, 'expected duplicate-production error');
  assert.equal(err.line, 2);
  assert.equal(err.firstLine, 1);
});

test('duplicate declarations are rejected', () => {
  const r = parseGrammarSpec({
    terminals: 'a a',
    nonterminals: 'S',
    start: 'S',
    productions: 'S -> a',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate-declaration'));
});

test('symbol declared as both terminal and non-terminal is rejected', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S a',
    start: 'S',
    productions: 'S -> a',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'declaration-conflict'));
});

test('unreachable start rule: start symbol without productions', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S A',
    start: 'S',
    productions: 'A -> a',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'unreachable-start'));
});

test('unreachable non-terminal is reported as warning, not error', () => {
  const r = parseGrammarSpec({
    terminals: 'a b',
    nonterminals: 'S A',
    start: 'S',
    productions: 'S -> a\nA -> b',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.code === 'unreachable-nonterminal' && w.symbol === 'A'));
});

test('missing arrow is reported per line', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S',
    start: 'S',
    productions: 'S a',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'missing-arrow' && e.line === 1));
});

test('start symbol must be a declared non-terminal', () => {
  const r = parseGrammarSpec({ ...base, start: 'Q' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'start-not-nonterminal'));
});

test('arrow forms ::= and → are accepted', () => {
  const r = parseGrammarSpec({
    terminals: 'a',
    nonterminals: 'S',
    start: 'S',
    productions: 'S ::= a\nS → a',
  });
  // second production duplicates the first
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate-production'));
});
