'use strict';

/**
 * Grammar spec parsing and validation.
 *
 * Delimiter rules (explicit, documented in README):
 *  - Symbol lists (terminals / non-terminals) are separated by whitespace or commas.
 *  - Each production lives on its own line: `LHS -> RHS`, `LHS ::= RHS` or `LHS → RHS`.
 *  - RHS symbols are separated by whitespace, so multi-character symbols are fine.
 *  - `|` as a standalone token separates alternatives on the RHS.
 *  - An empty RHS, or the token `ε` / `eps`, denotes an empty (epsilon) production.
 *  - Lines whose first non-blank characters are `#` or `//` are comments.
 *  - Reserved markers ($, ε, eps, ->, ::=, →, |) may not be used as symbols.
 */

const END_MARKER = '$';
const EPSILON_TOKENS = new Set(['ε', 'eps']);
const ARROWS = ['::=', '->', '→'];
const RESERVED = new Set([...ARROWS, '|', END_MARKER, ...EPSILON_TOKENS]);

function splitSymbolList(text) {
  return String(text == null ? '' : text)
    .split(/[\s,]+/)
    .filter(Boolean);
}

function findArrow(line) {
  let best = null;
  for (const arrow of ARROWS) {
    const idx = line.indexOf(arrow);
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { index: idx, arrow };
    }
  }
  return best;
}

function makeError(code, message, extra) {
  return Object.assign({ code, message }, extra || {});
}

/**
 * Parse and validate a grammar spec.
 * @param {{terminals:string, nonterminals:string, start:string, productions:string}} spec
 * @returns {{ok:boolean, errors:Array, warnings:Array, grammar:?Object}}
 */
function parseGrammarSpec(spec) {
  const errors = [];
  const warnings = [];
  spec = spec || {};

  // ---- declarations -------------------------------------------------------
  const terminals = splitSymbolList(spec.terminals);
  const nonterminals = splitSymbolList(spec.nonterminals);
  const startText = String(spec.start == null ? '' : spec.start).trim();
  const startTokens = splitSymbolList(spec.start);

  const terminalSet = new Set();
  const nonterminalSet = new Set();

  const checkDeclaration = (symbol, kind, set) => {
    if (RESERVED.has(symbol)) {
      errors.push(makeError('illegal-symbol', `保留记号 "${symbol}" 不能用作${kind}符号`, { symbol }));
      return false;
    }
    if (set.has(symbol)) {
      errors.push(makeError('duplicate-declaration', `${kind}符号 "${symbol}" 被重复声明`, { symbol }));
      return false;
    }
    return true;
  };

  for (const t of terminals) {
    if (checkDeclaration(t, '终结', terminalSet)) terminalSet.add(t);
  }
  for (const n of nonterminals) {
    if (checkDeclaration(n, '非终结', nonterminalSet)) nonterminalSet.add(n);
  }
  for (const t of terminalSet) {
    if (nonterminalSet.has(t)) {
      errors.push(makeError('declaration-conflict', `符号 "${t}" 同时被声明为终结符与非终结符`, { symbol: t }));
    }
  }

  if (terminalSet.size === 0) {
    errors.push(makeError('empty-terminals', '终结符集合为空'));
  }
  if (nonterminalSet.size === 0) {
    errors.push(makeError('empty-nonterminals', '非终结符集合为空'));
  }

  // ---- start symbol -------------------------------------------------------
  let start = null;
  if (startTokens.length === 0) {
    errors.push(makeError('missing-start', '未给出起始符'));
  } else if (startTokens.length !== 1) {
    errors.push(makeError('bad-start', `起始符必须是单个符号，实际为 "${startText}"`));
  } else {
    start = startTokens[0];
    if (RESERVED.has(start)) {
      errors.push(makeError('illegal-symbol', `保留记号 "${start}" 不能用作起始符`, { symbol: start }));
    } else if (!nonterminalSet.has(start)) {
      errors.push(makeError('start-not-nonterminal', `起始符 "${start}" 不是已声明的非终结符`, { symbol: start }));
    }
  }

  // ---- productions --------------------------------------------------------
  const productions = [];
  const seenProductions = new Map(); // key -> first line
  const lines = String(spec.productions == null ? '' : spec.productions).split(/\r?\n/);
  const allSymbols = new Set([...terminalSet, ...nonterminalSet]);

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('#') || line.startsWith('//')) return;

    const arrow = findArrow(line);
    if (!arrow) {
      errors.push(makeError('missing-arrow', `第 ${lineNo} 行缺少产生式箭头（->、::= 或 →）`, { line: lineNo }));
      return;
    }

    const lhsText = line.slice(0, arrow.index).trim();
    const rhsText = line.slice(arrow.index + arrow.arrow.length).trim();

    const lhsTokens = lhsText.split(/\s+/).filter(Boolean);
    if (lhsTokens.length !== 1) {
      errors.push(makeError('bad-lhs', `第 ${lineNo} 行左部必须是单个非终结符，实际为 "${lhsText || '(空)'}"`, { line: lineNo }));
      return;
    }
    const lhs = lhsTokens[0];
    if (RESERVED.has(lhs)) {
      errors.push(makeError('illegal-symbol', `第 ${lineNo} 行左部使用了保留记号 "${lhs}"`, { line: lineNo, symbol: lhs }));
      return;
    }
    if (!nonterminalSet.has(lhs)) {
      const code = terminalSet.has(lhs) ? 'lhs-not-nonterminal' : 'undefined-symbol';
      const msg = terminalSet.has(lhs)
        ? `第 ${lineNo} 行左部 "${lhs}" 是终结符，不能作为产生式左部`
        : `第 ${lineNo} 行左部 "${lhs}" 未声明为非终结符`;
      errors.push(makeError(code, msg, { line: lineNo, symbol: lhs }));
      return;
    }

    // Split RHS into alternatives on a standalone `|` token.
    const rhsTokens = rhsText ? rhsText.split(/\s+/).filter(Boolean) : [];
    const alternatives = [[]];
    for (const tok of rhsTokens) {
      if (tok === '|') alternatives.push([]);
      else alternatives[alternatives.length - 1].push(tok);
    }

    for (const alt of alternatives) {
      let rhs = alt;
      if (alt.length === 1 && EPSILON_TOKENS.has(alt[0])) {
        rhs = [];
      } else if (alt.some((t) => EPSILON_TOKENS.has(t))) {
        errors.push(makeError('epsilon-mixed', `第 ${lineNo} 行空产生式记号 ε/eps 不能与其他符号混用`, { line: lineNo }));
        continue;
      }

      let valid = true;
      for (const sym of rhs) {
        if (RESERVED.has(sym)) {
          errors.push(makeError('illegal-symbol', `第 ${lineNo} 行右部使用了保留记号 "${sym}"`, { line: lineNo, symbol: sym }));
          valid = false;
        } else if (!allSymbols.has(sym)) {
          errors.push(makeError('undefined-symbol', `第 ${lineNo} 行右部符号 "${sym}" 未在终结符/非终结符中声明`, { line: lineNo, symbol: sym }));
          valid = false;
        }
      }
      if (!valid) continue;

      const key = `${lhs} -> ${rhs.join(' ')}`;
      if (seenProductions.has(key)) {
        errors.push(makeError(
          'duplicate-production',
          `第 ${lineNo} 行产生式 "${key || lhs + ' -> ε'}" 与第 ${seenProductions.get(key)} 行重复`,
          { line: lineNo, firstLine: seenProductions.get(key) }
        ));
        continue;
      }
      seenProductions.set(key, lineNo);
      productions.push({ lhs, rhs, line: lineNo });
    }
  });

  if (productions.length === 0 && errors.length === 0) {
    errors.push(makeError('no-productions', '没有可用的产生式'));
  }

  // ---- reachability -------------------------------------------------------
  if (start && productions.length > 0) {
    const prodsByLhs = new Map();
    for (const p of productions) {
      if (!prodsByLhs.has(p.lhs)) prodsByLhs.set(p.lhs, []);
      prodsByLhs.get(p.lhs).push(p);
    }

    if (!prodsByLhs.has(start)) {
      errors.push(makeError(
        'unreachable-start',
        `起始符 "${start}" 没有任何产生式，起始规则不可达`,
        { symbol: start }
      ));
    }

    // Non-terminals reachable from the start symbol.
    const reachable = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const A = queue.shift();
      for (const p of prodsByLhs.get(A) || []) {
        for (const sym of p.rhs) {
          if (nonterminalSet.has(sym) && !reachable.has(sym)) {
            reachable.add(sym);
            queue.push(sym);
          }
        }
      }
    }
    for (const n of nonterminalSet) {
      if (!reachable.has(n)) {
        warnings.push(makeError('unreachable-nonterminal', `非终结符 "${n}" 从起始符不可达`, { symbol: n }));
      } else if (!prodsByLhs.has(n)) {
        errors.push(makeError('missing-productions', `非终结符 "${n}" 没有产生式`, { symbol: n }));
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings, grammar: null };
  }

  // Fresh augmented start symbol that cannot collide with user symbols.
  let augmentedStart = `${start}'`;
  while (allSymbols.has(augmentedStart)) augmentedStart += "'";

  const indexed = productions.map((p, i) => ({
    index: i + 1,
    lhs: p.lhs,
    rhs: p.rhs,
    line: p.line,
    text: `${p.lhs} -> ${p.rhs.length ? p.rhs.join(' ') : 'ε'}`,
  }));

  return {
    ok: true,
    errors: [],
    warnings,
    grammar: {
      terminals: [...terminalSet],
      nonterminals: [...nonterminalSet],
      start,
      augmentedStart,
      endMarker: END_MARKER,
      productions: indexed,
    },
  };
}

module.exports = { parseGrammarSpec, END_MARKER, EPSILON_TOKENS, RESERVED };
