'use strict';

const { parseGrammarSpec } = require('./grammar');
const { analyzeGrammar } = require('./lr1');

/**
 * Run a full grammar review: parse + validate, then canonical LR(1) analysis.
 * @param {{terminals:string, nonterminals:string, start:string, productions:string}} spec
 */
function reviewSpec(spec) {
  const parsed = parseGrammarSpec(spec);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
  }
  const analysis = analyzeGrammar(parsed.grammar);
  return {
    ok: true,
    errors: [],
    warnings: parsed.warnings,
    grammar: {
      terminals: parsed.grammar.terminals,
      nonterminals: parsed.grammar.nonterminals,
      start: parsed.grammar.start,
      augmentedStart: parsed.grammar.augmentedStart,
      endMarker: parsed.grammar.endMarker,
    },
    analysis,
  };
}

module.exports = { reviewSpec };
