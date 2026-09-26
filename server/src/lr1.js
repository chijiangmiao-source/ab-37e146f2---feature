'use strict';

/**
 * Canonical LR(1) construction: nullable, FIRST, closure, goto, item-set
 * collection with stable (deterministic) numbering, ACTION/GOTO tables and
 * deterministic first-conflict reporting with verifiable prefix evidence.
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
    const types = pair.map((e) => e.action.type);
    const type =
      types.includes('shift') && types.includes('reduce')
        ? 'shift-reduce'
        : types.every((t) => t === 'reduce')
          ? 'reduce-reduce'
          : types.join('-');
    const prefix = prefixTo(c.state);
    firstConflict = {
      type,
      state: c.state,
      lookahead: c.lookahead,
      actions: pair.map((e) => ({
        ...describeAction(e.action),
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

  // ---- serialize ------------------------------------------------------------
  const actionTable = tables.map((row) => {
    const actions = {};
    for (const t of [...row.cells.keys()].sort(byTermOrder)) {
      actions[t] = row.cells
        .get(t)
        .slice()
        .sort(compareActions)
        .map((e) => describeAction(e.action));
    }
    return { state: row.state, actions, gotos: row.gotos };
  });

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
    terminals: [...terminals, END],
    nonterminals,
    conflictFree: conflicts.length === 0,
    conflictCount: conflicts.length,
    firstConflict,
  };
}

module.exports = { analyzeGrammar };
