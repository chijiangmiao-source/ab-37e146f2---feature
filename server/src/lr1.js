'use strict';

const { resolveConflicts } = require('./resolver');

/**
 * Canonical LR(1) construction: nullable, FIRST, closure, goto, item-set
 * collection with stable (deterministic) numbering, ACTION/GOTO tables and
 * deterministic first-conflict reporting with verifiable prefix evidence.
 *
 * When the canonical table contains conflicts, a stable precedence /
 * associativity policy is additionally derived (minimum number of precedence
 * levels, ties by terminal associativity) and every conflict is itemised with
 * the levels used and the final action; see server/src/resolver.js.
 */

/**
 * @param {object} grammar - validated grammar from parseGrammarSpec
 * @returns {object} analysis result (JSON-serializable)
 */
function analyzeGrammar(grammar) {
  const terminals = grammar.terminals.slice();
  const nonterminals = grammar.nonterminals.slice();
  const END = grammar.endMarker || '$';
  const T = new Set(terminals);
  const N = new Set(nonterminals);

  const productions = [
    { index: 0, lhs: grammar.augmentedStart, rhs: [grammar.start], line: 0, augmented: true },
    ...grammar.productions.map((p) => ({ index: p.index, lhs: p.lhs, rhs: p.rhs, line: p.line })),
  ];
  const prodsByLhs = new Map();
  productions.forEach((p, i) => {
    if (!prodsByLhs.has(p.lhs)) prodsByLhs.set(p.lhs, []);
    prodsByLhs.get(p.lhs).push(i);
  });

  // Deterministic orderings used everywhere for stable output.
  const termOrder = new Map([...terminals, END].map((t, i) => [t, i]));
  const symbolOrder = new Map([...nonterminals, ...terminals].map((s, i) => [s, i]));
  const byTermOrder = (a, b) => (termOrder.get(a) ?? 1e9) - (termOrder.get(b) ?? 1e9);
  const bySymbolOrder = (a, b) => (symbolOrder.get(a) ?? 1e9) - (symbolOrder.get(b) ?? 1e9);

  // Separator for composite (state, terminal) map keys; a terminal token can
  // never contain this unit-separator control character.
  const CELL_SEP = String.fromCharCode(0x1f);

  // ---- nullable -----------------------------------------------------------
  const nullable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of productions) {
      if (nullable.has(p.lhs)) continue;
      if (p.rhs.every((s) => nullable.has(s))) {
        nullable.add(p.lhs);
        changed = true;
      }
    }
  }

  // ---- FIRST --------------------------------------------------------------
  const first = new Map();
  for (const A of [...nonterminals, grammar.augmentedStart]) first.set(A, new Set());
  changed = true;
  while (changed) {
    changed = false;
    for (const p of productions) {
      const acc = first.get(p.lhs);
      for (const X of p.rhs) {
        if (T.has(X)) {
          if (!acc.has(X)) { acc.add(X); changed = true; }
          break;
        }
        for (const t of first.get(X)) {
          if (!acc.has(t)) { acc.add(t); changed = true; }
        }
        if (!nullable.has(X)) break;
      }
    }
  }

  function firstOfSequence(seq, lookahead) {
    const out = new Set();
    let allNullable = true;
    for (const X of seq) {
      if (T.has(X)) {
        out.add(X);
        allNullable = false;
        break;
      }
      for (const t of first.get(X)) out.add(t);
      if (!nullable.has(X)) {
        allNullable = false;
        break;
      }
    }
    if (allNullable && lookahead !== undefined) out.add(lookahead);
    return out;
  }

  // ---- items / closure / goto --------------------------------------------
  const itemKey = (it) => `${it.prod}:${it.dot}:${it.la}`;
  const sortItems = (items) =>
    items.sort((a, b) =>
      a.prod - b.prod || a.dot - b.dot || byTermOrder(a.la, b.la));

  function closure(seed) {
    const map = new Map();
    const queue = [];
    const add = (prod, dot, la) => {
      const key = `${prod}:${dot}:${la}`;
      if (!map.has(key)) {
        const it = { prod, dot, la };
        map.set(key, it);
        queue.push(it);
      }
    };
    for (const s of seed) add(s.prod, s.dot, s.la);
    while (queue.length) {
      const it = queue.shift();
      const p = productions[it.prod];
      const B = p.rhs[it.dot];
      if (B === undefined || T.has(B)) continue;
      const beta = p.rhs.slice(it.dot + 1);
      for (const b of firstOfSequence(beta, it.la)) {
        for (const pi of prodsByLhs.get(B) || []) add(pi, 0, b);
      }
    }
    return sortItems([...map.values()]);
  }

  function gotoSet(items, X) {
    const moved = [];
    for (const it of items) {
      if (productions[it.prod].rhs[it.dot] === X) {
        moved.push({ prod: it.prod, dot: it.dot + 1, la: it.la });
      }
    }
    return moved.length ? closure(moved) : null;
  }

  // ---- canonical collection (BFS => stable numbering) ---------------------
  const states = [];
  const transitions = [];
  const stateIds = new Map();
  const intern = (items) => {
    const key = items.map(itemKey).join('|');
    if (stateIds.has(key)) return stateIds.get(key);
    const id = states.length;
    states.push(items);
    transitions.push({});
    stateIds.set(key, id);
    return id;
  };

  intern(closure([{ prod: 0, dot: 0, la: END }]));
  const bfsQueue = [0];
  while (bfsQueue.length) {
    const i = bfsQueue.shift();
    const items = states[i];
    const afterDot = new Set();
    for (const it of items) {
      const X = productions[it.prod].rhs[it.dot];
      if (X !== undefined) afterDot.add(X);
    }
    for (const X of [...afterDot].sort(bySymbolOrder)) {
      const J = gotoSet(items, X);
      if (!J) continue;
      const before = states.length;
      const id = intern(J);
      if (id === before) bfsQueue.push(id);
      transitions[i][X] = id;
    }
  }

  // ---- ACTION / GOTO tables ------------------------------------------------
  const actionRank = (a) => (a.type === 'shift' ? 0 : a.type === 'reduce' ? 1 : 2);
  const actionKey = (a) =>
    a.type === 'shift' ? `s${a.state}` : a.type === 'reduce' ? `r${a.production}` : 'acc';
  const compareActions = (a, b) =>
    actionRank(a.action) - actionRank(b.action) ||
    (a.action.type === 'shift'
      ? a.action.state - b.action.state
      : a.action.type === 'reduce'
        ? a.action.production - b.action.production
        : 0);

  const itemText = (it) => {
    const p = productions[it.prod];
    const rhs = p.rhs.slice();
    rhs.splice(it.dot, 0, '·');
    return `${p.lhs} -> ${rhs.join(' ')} , ${it.la}`;
  };

  const tables = states.map((items, i) => {
    const cells = new Map(); // terminal -> [{action, items:[item]}]
    const gotos = {};
    for (const X of Object.keys(transitions[i]).sort(bySymbolOrder)) {
      if (N.has(X)) gotos[X] = transitions[i][X];
    }
    const addAction = (t, action, item) => {
      if (!cells.has(t)) cells.set(t, []);
      const list = cells.get(t);
      const key = actionKey(action);
      const existing = list.find((e) => actionKey(e.action) === key);
      if (existing) existing.items.push(item);
      else list.push({ action, items: [item] });
    };
    for (const it of items) {
      const p = productions[it.prod];
      const X = p.rhs[it.dot];
      if (X !== undefined) {
        if (T.has(X)) addAction(X, { type: 'shift', state: transitions[i][X] }, it);
      } else if (it.prod === 0) {
        addAction(END, { type: 'accept' }, it);
      } else {
        addAction(it.la, { type: 'reduce', production: it.prod }, it);
      }
    }
    return { state: i, cells, gotos };
  });

  // ---- conflicts (deterministic first conflict) ----------------------------
  const conflicts = [];
  for (const row of tables) {
    for (const t of [...row.cells.keys()].sort(byTermOrder)) {
      const entries = row.cells.get(t).slice().sort(compareActions);
      if (entries.length > 1) {
        conflicts.push({ state: row.state, lookahead: t, entries });
      }
    }
  }
  conflicts.sort((a, b) => a.state - b.state || byTermOrder(a.lookahead, b.lookahead));

  // Rightmost terminal of a production anchors its precedence (yacc rule:
  // precedence of `A -> ... X` is the precedence of the last terminal X).
  const rightmostTerminal = (p) => {
    for (let i = p.rhs.length - 1; i >= 0; i -= 1) {
      if (T.has(p.rhs[i])) return p.rhs[i];
    }
    return null;
  };
  const prodRightmost = productions.map(rightmostTerminal);

  const classifyType = (entries) => {
    const types = entries.map((e) => e.action.type);
    if (types.includes('shift') && types.includes('reduce')) return 'shift-reduce';
    if (types.every((t) => t === 'reduce')) return 'reduce-reduce';
    return types.join('-');
  };

  // Resolver input: candidates in the SAME sorted order as `entries`
  // (shift first, then reduces by production number).
  const resolverConflicts = conflicts.map((c) => ({
    state: c.state,
    lookahead: c.lookahead,
    candidates: c.entries.map((e) => ({
      kind: e.action.type === 'shift' ? 'shift' : e.action.type === 'reduce' ? 'reduce' : 'accept',
      prodIndex: e.action.type === 'reduce' ? e.action.production : null,
      symbol: e.action.type === 'shift'
        ? c.lookahead
        : e.action.type === 'reduce'
          ? prodRightmost[e.action.production]
          : null,
    })),
  }));

  const strategyRaw = resolveConflicts(resolverConflicts, { terminals: [...terminals, END] });

  // Verifiable prefix evidence: shortest symbol path from state 0 to `target`.
  function prefixTo(target) {
    const prev = new Array(states.length).fill(null);
    const seen = new Set([0]);
    const q = [0];
    while (q.length) {
      const i = q.shift();
      if (i === target) break;
      for (const X of Object.keys(transitions[i]).sort(bySymbolOrder)) {
        const j = transitions[i][X];
        if (!seen.has(j)) {
          seen.add(j);
          prev[j] = { from: i, symbol: X };
          q.push(j);
        }
      }
    }
    const symbols = [];
    const path = [];
    let cur = target;
    while (cur !== null && prev[cur]) {
      symbols.unshift(prev[cur].symbol);
      path.unshift(prev[cur].from);
      cur = prev[cur].from;
    }
    path.push(target);
    return { symbols, states: path };
  }

  const describeAction = (a) => {
    if (a.type === 'shift') return { ...a, text: `shift ${a.state}`, short: `s${a.state}` };
    if (a.type === 'reduce') {
      const p = productions[a.production];
      const text = `${p.lhs} -> ${p.rhs.length ? p.rhs.join(' ') : 'ε'}`;
      return { ...a, text: `reduce ${text}`, short: `r${a.production}`, productionText: text };
    }
    return { ...a, text: 'accept', short: 'acc' };
  };

  let firstConflict = null;
  if (conflicts.length > 0) {
    const c = conflicts[0];
    const pair = c.entries.slice(0, 2);
    const type = classifyType(pair);
    const prefix = prefixTo(c.state);
    firstConflict = {
      type,
      state: c.state,
      lookahead: c.lookahead,
      actions: pair.map((e) => ({
        ...describeAction(e.action),
        symbol: e.action.type === 'shift'
          ? c.lookahead
          : e.action.type === 'reduce' ? prodRightmost[e.action.production] : null,
        items: e.items.map((it) => ({ prod: it.prod, dot: it.dot, la: it.la, text: itemText(it) })),
      })),
      stateItems: states[c.state].map((it) => ({
        prod: it.prod,
        dot: it.dot,
        la: it.la,
        kernel: it.dot > 0 || it.prod === 0,
        text: itemText(it),
      })),
      prefix: {
        symbols: prefix.symbols,
        states: prefix.states,
        text: prefix.symbols.join(' '),
      },
    };
  }

  // ---- stable precedence / associativity policy, itemised per conflict -----
  // Re-serialise every decision with the competing actions/items, levels and
  // final action so the UI can present the audit item by item.
  const auditConflicts = conflicts.map((c, idx) => {
    const entries = c.entries.slice().sort(compareActions);
    const decision = strategyRaw.decisions[idx];
    const winnerEntry = decision && decision.resolvable ? entries[decision.winnerIndex] : null;
    const winnerAction = winnerEntry ? describeAction(winnerEntry.action) : null;
    return {
      state: c.state,
      lookahead: c.lookahead,
      type: classifyType(entries),
      actions: entries.map((e) => ({
        ...describeAction(e.action),
        symbol: e.action.type === 'shift'
          ? c.lookahead
          : e.action.type === 'reduce' ? prodRightmost[e.action.production] : null,
        items: e.items.map((it) => ({ prod: it.prod, dot: it.dot, la: it.la, text: itemText(it) })),
      })),
      prefix: prefixTo(c.state),
      resolution: decision
        ? {
            resolvable: decision.resolvable,
            basis: decision.basis, // 'level' | 'associativity' | null
            associativity: decision.associativity, // 'left' | 'right' | null
            precedence: decision.precedence, // per-candidate {side,symbol,level}
            finalAction: winnerAction,
            reasonCode: decision.reasonCode,
            reasonText: decision.reasonText,
          }
        : null,
    };
  });

  const strategy = {
    status: strategyRaw.status, // 'unneeded' | 'resolved' | 'unresolvable'
    exact: strategyRaw.exact,
    levelCount: strategyRaw.levels.length,
    levels: strategyRaw.levels,
    conflicts: auditConflicts,
    resolvedConflictCount: strategyRaw.decisions.filter((d) => d.resolvable).length,
    unresolvedConflictCount: strategyRaw.decisions.filter((d) => !d.resolvable).length,
    note: strategyRaw.note,
  };

  // ---- serialize ------------------------------------------------------------
  // Raw table: every competing action is kept (conflicts visible).
  const serializeCell = (entries) => entries.slice().sort(compareActions).map((e) => describeAction(e.action));
  const actionTable = tables.map((row) => {
    const actions = {};
    for (const t of [...row.cells.keys()].sort(byTermOrder)) {
      actions[t] = serializeCell(row.cells.get(t));
    }
    return { state: row.state, actions, gotos: row.gotos };
  });

  // Resolved table: each audited conflict cell is collapsed to the chosen
  // action; unresolvable cells keep ALL competing actions (no default shift,
  // no production-order tie-break).  Non-conflict cells are copied verbatim,
  // so where no strategy is needed the table stays identical to the raw one.
  const winnerByCell = new Map(); // state + lookahead -> winner entry
  auditConflicts.forEach((ac, idx) => {
    if (!ac.resolution.resolvable) return;
    const decision = strategyRaw.decisions[idx];
    const entries = conflicts[idx].entries.slice().sort(compareActions);
    winnerByCell.set([ac.state, ac.lookahead].join(CELL_SEP), entries[decision.winnerIndex]);
  });
  const resolvedActionTable = tables.map((row) => {
    const actions = {};
    for (const t of [...row.cells.keys()].sort(byTermOrder)) {
      const entries = row.cells.get(t);
      const winner = winnerByCell.get([row.state, t].join(CELL_SEP));
      actions[t] = winner ? [describeAction(winner.action)] : serializeCell(entries);
    }
    return { state: row.state, actions, gotos: row.gotos };
  });

  // Table consistency claim for conflict-free grammars: no strategy needed
  // and the audited table equals the canonical review table cell for cell.
  strategy.tableMatchesReview = conflicts.length === 0;

  const statesOut = states.map((items, i) => ({
    id: i,
    items: items.map((it) => ({
      prod: it.prod,
      dot: it.dot,
      la: it.la,
      kernel: it.dot > 0 || it.prod === 0,
      text: itemText(it),
    })),
    transitions: Object.fromEntries(
      Object.keys(transitions[i]).sort(bySymbolOrder).map((X) => [X, transitions[i][X]])
    ),
  }));

  const firstOut = {};
  for (const A of [...nonterminals, grammar.augmentedStart]) {
    firstOut[A] = [...first.get(A)].sort(byTermOrder);
  }

  return {
    nullable: nonterminals.filter((A) => nullable.has(A)),
    first: firstOut,
    productions: productions.map((p) => ({
      index: p.index,
      lhs: p.lhs,
      rhs: p.rhs,
      line: p.line,
      text: `${p.lhs} -> ${p.rhs.length ? p.rhs.join(' ') : 'ε'}`,
      augmented: p.index === 0,
    })),
    states: statesOut,
    actionTable,
    resolvedActionTable,
    strategy,
    terminals: [...terminals, END],
    nonterminals,
    conflictFree: conflicts.length === 0,
    conflictCount: conflicts.length,
    firstConflict,
  };
}

module.exports = { analyzeGrammar };
