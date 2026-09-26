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

  // ---- ACTION table serialization (raw, conflicts preserved) ---------------
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

  // ---- deterministic conflict-resolution strategy --------------------------
  //
  // Every conflict is adjudicated solely from the *lookahead terminal* and the
  // *rightmost terminal of the reduce production's RHS*. No default shift, no
  // production order and no bounded trial-and-error search is used:
  //
  //   * reduce/reduce conflict      -> no strategy can disambiguate it
  //                                   (precedence is a terminal property and
  //                                    both actions are reduces);
  //   * reduce production has no    -> undecidable (no terminal to compare);
  //     rightmost terminal
  //   * shift/reduce with both      -> compare precedence levels; the side
  //     terminals present              with the higher level wins; equal
  //                                   level is settled by associativity
  //                                   (`^` right-assoc => shift; every other
  //                                   terminal left-assoc => reduce).
  //
  // Levels are *inferred* rather than guessed: the conflict evidence induces
  // ordering constraints (the reduce terminal must outrank the lookahead, or
  // vice versa). We first minimize the number of levels, then break the
  // remaining symmetry with the stable terminal declaration order (later
  // declarations bind tighter) and the fixed associativity convention, so the
  // same grammar always yields the same unique solution.
  const RIGHT_ASSOC = new Set(['^']);
  const assocOf = (t) => (RIGHT_ASSOC.has(t) ? 'right' : 'left');

  // Rightmost terminal occurrence in a production RHS (undefined for
  // terminal-free productions such as A -> B C or A -> ε).
  function rightmostTerminal(rhs) {
    for (let k = rhs.length - 1; k >= 0; k -= 1) {
      if (T.has(rhs[k])) return rhs[k];
    }
    return undefined;
  }

  // Build one adjudication record per conflict (state, lookahead).
  const decisions = conflicts.map((c) => {
    const shiftEntry = c.entries.find((e) => e.action.type === 'shift');
    const reduceEntries = c.entries.filter((e) => e.action.type === 'reduce');
    const base = {
      state: c.state,
      lookahead: c.lookahead,
      prefix: (() => {
        const p = prefixTo(c.state);
        return { symbols: p.symbols, states: p.states, text: p.symbols.join(' ') };
      })(),
      stateItems: states[c.state].map((it) => ({
        prod: it.prod,
        dot: it.dot,
        la: it.la,
        kernel: it.dot > 0 || it.prod === 0,
        text: itemText(it),
      })),
    };

    if (!shiftEntry || reduceEntries.length === 0) {
      // Pure reduce/reduce (or any non shift/reduce combination): precedence of
      // terminals cannot choose between two reductions.
      const pair = c.entries.slice(0, 2);
      return {
        ...base,
        kind: 'reduce-reduce',
        resolvable: false,
        reason: 'reduce-reduce',
        reasonText: '归约/归约冲突：两项竞争动作都是归约，终结符优先级与结合性无法在两条产生式间作出裁决，不存在可用稳定策略。',
        actions: pair.map((e) => ({
          ...describeAction(e.action),
          items: e.items.map((it) => ({ prod: it.prod, dot: it.dot, la: it.la, text: itemText(it) })),
        })),
      };
    }

    if (reduceEntries.length > 1) {
      // One shift competes against two (or more) reductions: the reductions
      // themselves form a reduce/reduce conflict that no terminal precedence
      // can adjudicate, so the whole cell is unresolvable.
      const pair = reduceEntries.slice(0, 2);
      return {
        ...base,
        kind: 'reduce-reduce',
        resolvable: false,
        reason: 'reduce-reduce',
        reasonText: '该展望符下同格存在两个归约动作（归约/归约竞争），终结符优先级与结合性无法在两条产生式间作出裁决，不存在可用稳定策略。',
        actions: pair.map((e) => ({
          ...describeAction(e.action),
          items: e.items.map((it) => ({ prod: it.prod, dot: it.dot, la: it.la, text: itemText(it) })),
        })),
      };
    }

    const reduceEntry = reduceEntries.slice().sort(compareActions)[0];
    const reduceAction = reduceEntry.action;
    const prod = productions[reduceAction.production];
    const op = rightmostTerminal(prod.rhs);
    const lookahead = c.lookahead;
    const competitors = [shiftEntry, reduceEntry].map((e) => ({
      ...describeAction(e.action),
      items: e.items.map((it) => ({ prod: it.prod, dot: it.dot, la: it.la, text: itemText(it) })),
    }));

    if (op === undefined) {
      return {
        ...base,
        kind: 'shift-reduce',
        resolvable: false,
        reason: 'no-terminal',
        reasonText: `移进/归约冲突：归约产生式 "${prod.lhs} -> ${prod.rhs.length ? prod.rhs.join(' ') : 'ε'}" 右部不含任何终结符，无法取其最右终结符与展望符 ${lookahead} 比较，不存在可用稳定策略。`,
        reduceTerminal: null,
        shiftTerminal: lookahead,
        actions: competitors,
      };
    }

    return {
      ...base,
      kind: 'shift-reduce',
      resolvable: true,
      reason: null,
      reduceTerminal: op,
      shiftTerminal: lookahead,
      reduceProduction: prod.index,
      reduceProductionText: `${prod.lhs} -> ${prod.rhs.length ? prod.rhs.join(' ') : 'ε'}`,
      actions: competitors,
    };
  });

  // A strategy exists only when *every* conflict is individually resolvable.
  const strategyPossible = decisions.length > 0 && decisions.every((d) => d.resolvable);

  // ---- infer precedence levels from the conflict evidence ------------------
  //
  // The stable selection rule has two lexicographic objectives, in order:
  //   1. minimize the number of precedence levels (层);
  //   2. break symmetry with the terminal declaration order and the fixed
  //      associativity encoding.
  //
  // Terminal encoding (yacc convention): a terminal's precedence rank is its
  // position in the declared terminal list — a later declaration binds tighter.
  // Associativity is a property of the terminal itself: `^` is right-associative,
  // every other terminal is left-associative.
  //
  // For a shift/reduce conflict with reduce terminal `op` (the production's
  // rightmost terminal) and lookahead `la`:
  //   * op and la identical      -> associativity alone decides (right =>
  //                                 shift, left => reduce), no ordering needed;
  //   * otherwise the declaration order already fixes which side is tighter.
  // Two terminals may share one level whenever the associativity tie-break on
  // the lookahead produces the *same* winner as their declared ordering; only
  // when the winners differ is a strict boundary forced. Every forced edge runs
  // from a later-declared terminal to an earlier one, so the graph is acyclic
  // by construction and a unique minimal layering always exists.
  let levels = [];           // [{level, terminals:[...]}] tightest first
  let levelAssignments = {}; // terminal -> level number
  const strategyNotes = [];

  if (strategyPossible) {
    const relevant = new Set();
    for (const d of decisions) {
      relevant.add(d.shiftTerminal);
      relevant.add(d.reduceTerminal);
    }

    // Strict requirements: edge v -> u means "v must bind strictly tighter than
    // u" (v is declared later than u).
    const tighterEdges = new Map(); // v -> Set(u)
    const addEdge = (v, u) => {
      if (!tighterEdges.has(v)) tighterEdges.set(v, new Set());
      tighterEdges.get(v).add(u);
    };

    for (const d of decisions) {
      const la = d.shiftTerminal;
      const op = d.reduceTerminal;
      if (op === la) continue; // associativity settles same-terminal races
      const opRank = termOrder.get(op);
      const laRank = termOrder.get(la);
      const [later, earlier] = laRank > opRank ? [la, op] : [op, la];
      // Winner under distinct levels: the tighter (later) terminal's side wins.
      const distinctWinner = later === la ? 'shift' : 'reduce';
      // Winner when merged into one level: associativity of the lookahead.
      const tiedWinner = assocOf(la) === 'right' ? 'shift' : 'reduce';
      if (distinctWinner !== tiedWinner) addEdge(later, earlier);
    }

    // Longest strict chain below a terminal = its (0-based) precedence rank.
    // Equal ranks collapse into one level: this is the minimum layering that
    // satisfies every forced edge.
    const memo = new Map();
    const depth = (t) => {
      if (memo.has(t)) return memo.get(t);
      let d = 0;
      for (const u of tighterEdges.get(t) || []) d = Math.max(d, depth(u) + 1);
      memo.set(t, d);
      return d;
    };
    const byDepth = new Map();
    for (const t of relevant) {
      const d = depth(t);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(t);
    }
    // depth 0 is the weakest; present tightest first so level 1 binds hardest.
    levels = [...byDepth.keys()]
      .sort((a, b) => b - a)
      .map((d, i) => ({
        level: i + 1,
        terminals: byDepth.get(d).sort(byTermOrder).map((t) => ({ symbol: t, associativity: assocOf(t) })),
      }));
    for (const g of levels) for (const t of g.terminals) levelAssignments[t.symbol] = g.level;
  }

  // ---- finalize each decision: level, associativity, winning action --------
  const resolution = {
    needed: conflicts.length > 0,
    possible: strategyPossible,
    levels: [],
    decisions: [],
    notes: strategyNotes,
  };

  if (conflicts.length === 0) {
    resolution.summary = '文法无冲突，无需任何优先级/结合性策略，动作表保持与复核一致。';
  } else if (!strategyPossible) {
    const rr = decisions.some((d) => d.kind === 'reduce-reduce');
    resolution.summary = rr
      ? '存在归约/归约冲突（或终结符信息不足的移进/归约冲突），优先级与结合性只能裁决移进与归约之间的竞争，不存在可用稳定策略。'
      : '冲突证据对终结符优先级提出了无法同时满足的要求，不存在可用稳定策略。';
  }

  if (strategyPossible) {
    resolution.levels = levels;
    for (const d of decisions) {
      const laLevel = levelAssignments[d.shiftTerminal];
      const opLevel = levelAssignments[d.reduceTerminal];
      const assoc = assocOf(d.shiftTerminal);
      let winner;
      let rule;
      if (opLevel < laLevel) {
        winner = 'reduce';
        rule = `归约终结符 ${d.reduceTerminal}（第 ${opLevel} 层）优先级高于展望符 ${d.shiftTerminal}（第 ${laLevel} 层），归约取胜。`;
      } else if (opLevel > laLevel) {
        winner = 'shift';
        rule = `展望符 ${d.shiftTerminal}（第 ${laLevel} 层）优先级高于归约终结符 ${d.reduceTerminal}（第 ${opLevel} 层），移进取胜。`;
      } else if (assoc === 'right') {
        winner = 'shift';
        rule = d.shiftTerminal === d.reduceTerminal
          ? `展望符与归约终结符同为 ${d.shiftTerminal}（第 ${laLevel} 层），右结合使同优先级竞争唯一落定为移进。`
          : `${d.shiftTerminal} 与 ${d.reduceTerminal} 同处第 ${laLevel} 层，同优先级竞争按展望符 ${d.shiftTerminal} 的右结合规则落定为移进。`;
      } else {
        winner = 'reduce';
        rule = d.shiftTerminal === d.reduceTerminal
          ? `展望符与归约终结符同为 ${d.shiftTerminal}（第 ${laLevel} 层），左结合使同优先级竞争唯一落定为归约。`
          : `${d.shiftTerminal} 与 ${d.reduceTerminal} 同处第 ${laLevel} 层，同优先级竞争按展望符 ${d.shiftTerminal} 的左结合规则落定为归约。`;
      }
      const winningAction = d.actions.find((x) => x.type === winner);
      resolution.decisions.push({
        state: d.state,
        lookahead: d.lookahead,
        kind: d.kind,
        reduceTerminal: d.reduceTerminal,
        shiftTerminal: d.shiftTerminal,
        reduceTerminalLevel: opLevel,
        lookaheadLevel: laLevel,
        associativity: assoc,
        winner,
        winnerText: winningAction.text,
        winnerShort: winningAction.short,
        rule,
        prefix: d.prefix,
        actions: d.actions,
        stateItems: d.stateItems,
        reduceProductionText: d.reduceProductionText,
      });
    }
    const lvlText = levels
      .map((g) => {
        const syms = g.terminals.map((t) => t.symbol).join('=');
        return `第${g.level}层(${syms})`;
      })
      .join(' ');
    resolution.summary = `采用 ${levels.length} 层稳定优先级策略（编号越小结合越紧）：${lvlText}；其中 ^ 为右结合，其余终结符为左结合。每个移进/归约冲突均按展望终结符与归约产生式最右终结符的层级裁决，同层按结合性唯一落定。`;
  } else {
    // Surface the first blocking conflict with its competing items intact.
    const blocked = decisions.find((d) => !d.resolvable) || null;
    resolution.firstUnresolved = blocked
      ? {
          state: blocked.state,
          lookahead: blocked.lookahead,
          kind: blocked.kind,
          reason: blocked.reason,
          reasonText: blocked.reasonText,
          actions: blocked.actions,
          stateItems: blocked.stateItems,
          prefix: blocked.prefix,
        }
      : null;
    // Still list every conflict so the audit is item-by-item complete.
    resolution.decisions = decisions.map((d) => ({
      state: d.state,
      lookahead: d.lookahead,
      kind: d.kind,
      resolvable: false,
      reason: d.reason,
      reasonText: d.reasonText,
      actions: d.actions,
      stateItems: d.stateItems,
      prefix: d.prefix,
      reduceTerminal: d.reduceTerminal,
      shiftTerminal: d.shiftTerminal,
    }));
  }

  // ---- resolved ACTION table (only changed where a strategy applies) -------
  const resolvedActionTable = actionTable.map((row) => {
    if (!strategyPossible) return { state: row.state, actions: row.actions, gotos: row.gotos };
    const actions = {};
    const decisionAt = new Map(
      resolution.decisions.filter((dd) => dd.winner).map((dd) => [`${dd.state}:${dd.lookahead}`, dd])
    );
    for (const t of Object.keys(row.actions)) {
      const acts = row.actions[t];
      const dd = acts.length > 1 ? decisionAt.get(`${row.state}:${t}`) : null;
      if (dd) {
        const chosen = acts.find((x) => x.type === dd.winner);
        actions[t] = [chosen];
      } else {
        actions[t] = acts;
      }
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
    resolvedActionTable,
    resolution,
    terminals: [...terminals, END],
    nonterminals,
    conflictFree: conflicts.length === 0,
    conflictCount: conflicts.length,
    firstConflict,
  };
}

module.exports = { analyzeGrammar };
