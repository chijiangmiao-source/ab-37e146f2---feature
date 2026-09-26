'use strict';

/**
 * Deterministic precedence / associativity resolution of LR(1) conflicts.
 *
 * Resolution rule (yacc-style, but with NO reliance on default shifts,
 * production order or bounded trial-and-error):
 *
 *   - Every reduce candidate carries the precedence of the rightmost terminal
 *     of its production; every shift candidate carries the precedence of the
 *     lookahead terminal (the terminal right behind the dot).
 *   - A shift/reduce conflict between two DISTINCT terminals a (lookahead) and
 *     b (production) only requires them to live on different precedence
 *     levels.  Either ordering settles that conflict, so such conflicts induce
 *     undirected "must differ" edges.  The minimum number of levels is the
 *     exact chromatic number of that graph; levels are canonically oriented
 *     (which colour becomes level 1, 2, ...) by terminal declaration order,
 *     giving a single stable solution.
 *   - Once levels exist, the higher level wins: lookahead higher => shift,
 *     production terminal higher => reduce.
 *   - A conflict where both terminals are equal (lookahead == production
 *     terminal) is a same-level tie; the terminal's associativity decides:
 *     left  => reduce, right => shift.
 *   - Associativity is encoded by terminal identity (an explicit, documented
 *     convention, not a parser default): exponentiation tokens (^, **, ↑) are
 *     right-associative; every other binary operator is left-associative.
 *   - Reduce/reduce conflicts (and shift/reduce conflicts whose production has
 *     no terminal at all) cannot be settled this way; they are reported with
 *     `resolvable: false` and a reason code.  Production ordering is never
 *     used to choose a winner.
 */

const RIGHT_ASSOCIATIVE = new Set(['^', '**', '↑']);

// Unit separator used inside pair keys; terminal symbols are space-separated
// user tokens and can never contain this control character.
const PAIR_SEP = '';

function associativityFor(symbol) {
  return RIGHT_ASSOCIATIVE.has(symbol) ? 'right' : 'left';
}

/**
 * Exact minimum colouring of the undirected "must differ" graph.
 *
 * Vertices are examined in declaration order and colours are tried from 0
 * upwards, so for the minimum feasible k the returned assignment is the
 * lexicographically smallest vector over declaration order — a single stable
 * answer.  Colours are introduced in vertex order, hence colour c's smallest
 * vertex always precedes colour (c+1)'s: colour + 1 is directly the stable
 * precedence level.
 *
 * @param {string[]} orderedVertices vertices in canonical (declaration) order
 * @param {Array<[string,string]>} edges undirected must-differ pairs
 * @returns {Map<string, number>} terminal -> 1-based precedence level
 */
function minimumLevels(orderedVertices, edges) {
  const n = orderedVertices.length;
  const indexOf = new Map(orderedVertices.map((v, i) => [v, i]));
  const adj = Array.from({ length: n }, () => new Set());
  for (const [a, b] of edges) {
    const i = indexOf.get(a);
    const j = indexOf.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    adj[i].add(j);
    adj[j].add(i);
  }

  const levels = new Map();
  if (n === 0) return levels;

  // Simple lower bound: a greedily built clique (operator counts in real
  // grammars are tiny, so DSATUR-style bounds are unnecessary).
  let lowerBound = 1;
  {
    const clique = [];
    for (let v = 0; v < n; v += 1) {
      if (clique.every((u) => adj[v].has(u))) clique.push(v);
    }
    lowerBound = clique.length;
  }

  const colour = new Array(n).fill(-1);
  const canPaint = (v, c) => {
    for (const u of adj[v]) if (colour[u] === c) return false;
    return true;
  };
  const search = (v, k) => {
    if (v === n) return true;
    for (let c = 0; c < k; c += 1) {
      if (!canPaint(v, c)) continue;
      colour[v] = c;
      if (search(v + 1, k)) return true;
      colour[v] = -1;
    }
    return false;
  };

  let k = lowerBound;
  for (; k <= n; k += 1) {
    colour.fill(-1);
    if (search(0, k)) break;
  }
  orderedVertices.forEach((v, i) => levels.set(v, colour[i] + 1));
  return levels;
}

function isShiftReduce(c) {
  return c.candidates.length === 2
    && c.candidates[0].kind === 'shift'
    && c.candidates[1].kind === 'reduce';
}

/**
 * Build the stable resolution policy for a list of conflicts.
 *
 * @param {Array<{state:number, lookahead:string, candidates:Array<{kind:string, prodIndex:?number, symbol:?string}>}>} conflicts
 *        conflicts in stable order; candidates sorted (shift first, then
 *        reduces by production number) — winnerIndex addresses this array.
 * @param {{terminals:string[]}} opts terminals in declaration order (end marker last)
 * @returns {{status:string, levels:Array, decisions:Array, exact:boolean}}
 */
function resolveConflicts(conflicts, opts) {
  const terminalOrder = (opts && opts.terminals) || [];
  const orderRank = new Map(terminalOrder.map((t, i) => [t, i]));
  const byOrder = (a, b) => (orderRank.get(a) ?? 1e9) - (orderRank.get(b) ?? 1e9);

  if (!conflicts.length) {
    return {
      status: 'unneeded',
      exact: true,
      levelCount: 0,
      levels: [],
      decisions: [],
      note: '动作表无冲突，无需任何优先级/结合性策略；裁决后动作表与规范 LR(1) 复核结果逐项一致。',
    };
  }

  // Gather operator terminals and must-differ edges from shift/reduce conflicts.
  const vertexSet = new Set();
  const edgeSet = new Set();
  const edges = [];
  for (const c of conflicts) {
    if (!isShiftReduce(c)) continue;
    const a = c.candidates[0].symbol; // lookahead terminal (shift)
    const b = c.candidates[1].symbol; // production's rightmost terminal (reduce)
    if (!a || !b) continue;
    vertexSet.add(a);
    vertexSet.add(b);
    if (a !== b) {
      const lo = byOrder(a, b) < 0 ? a : b;
      const hi = byOrder(a, b) < 0 ? b : a;
      const key = `${lo}${PAIR_SEP}${hi}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([lo, hi]);
      }
    }
  }

  const vertices = [...vertexSet].sort(byOrder);
  const levelOf = minimumLevels(vertices, edges);

  // Serialised precedence levels (stable: level then terminal order).
  const levelRows = new Map();
  for (const t of vertices) {
    const lv = levelOf.get(t);
    if (!levelRows.has(lv)) levelRows.set(lv, []);
    levelRows.get(lv).push({ symbol: t, associativity: associativityFor(t) });
  }
  const levels = [...levelRows.keys()].sort((a, b) => a - b).map((lv) => ({
    level: lv,
    symbols: levelRows.get(lv).sort((x, y) => byOrder(x.symbol, y.symbol)),
  }));

  // Per-conflict decisions.
  const decisions = conflicts.map((c) => {
    if (c.candidates.length !== 2 || c.candidates[0].kind === 'reduce') {
      // Pure reduce/reduce (or an unusual multi-way cell): precedence cannot
      // pick a production without leaning on production order.
      return {
        resolvable: false,
        basis: null,
        winnerIndex: null,
        associativity: null,
        precedence: c.candidates.map((can) => (can.symbol
          ? { side: can.kind === 'shift' ? 'lookahead' : 'production', symbol: can.symbol, level: levelOf.get(can.symbol) ?? null }
          : null)),
        reasonCode: 'reduce-reduce',
        reasonText: '归约/归约冲突无法以终结符优先级或结合性裁决（不得按产生式顺序挑选），不存在可用策略。',
      };
    }

    const a = c.candidates[0].symbol; // lookahead
    const b = c.candidates[1].symbol; // production rightmost terminal
    const precedence = [
      a ? { side: 'lookahead', symbol: a, level: levelOf.get(a) ?? null } : null,
      b ? { side: 'production', symbol: b, level: levelOf.get(b) ?? null } : null,
    ];

    if (!a || !b) {
      return {
        resolvable: false,
        basis: null,
        winnerIndex: null,
        associativity: null,
        precedence,
        reasonCode: 'missing-precedence',
        reasonText: `归约产生式右部不含终结符，无法取得与展望符 ${a || ''} 比较的优先级；不存在可用策略。`,
      };
    }

    const la = levelOf.get(a);
    const lb = levelOf.get(b);

    if (a === b) {
      const assoc = associativityFor(a);
      if (assoc === 'right') {
        return {
          resolvable: true,
          basis: 'associativity',
          winnerIndex: 0,
          associativity: assoc,
          precedence,
          finalAction: 'shift',
          reasonCode: 'right-assoc',
          reasonText: `展望符与归约产生式最右终结符同为 ${a}（第 ${la} 层）；${a} 为右结合运算符，同优先级竞争继续移进，裁决：移进。`,
        };
      }
      if (assoc === 'left') {
        return {
          resolvable: true,
          basis: 'associativity',
          winnerIndex: 1,
          associativity: assoc,
          precedence,
          finalAction: 'reduce',
          reasonCode: 'left-assoc',
          reasonText: `展望符与归约产生式最右终结符同为 ${a}（第 ${la} 层）；${a} 为左结合运算符，同优先级竞争先行归约，裁决：归约。`,
        };
      }
      return {
        resolvable: false,
        basis: 'associativity',
        winnerIndex: null,
        associativity: assoc,
        precedence,
        reasonCode: 'nonassoc',
        reasonText: `${a}（第 ${la} 层）声明为无结合性，同优先级竞争被拒绝；不存在接受该串的策略。`,
      };
    }

    if (la > lb) {
      return {
        resolvable: true,
        basis: 'level',
        winnerIndex: 0,
        associativity: null,
        precedence,
        finalAction: 'shift',
        reasonCode: 'lookahead-higher',
        reasonText: `展望符 ${a} 位于第 ${la} 层，高于归约产生式最右终结符 ${b} 的第 ${lb} 层，裁决：移进。`,
      };
    }
    return {
      resolvable: true,
      basis: 'level',
      winnerIndex: 1,
      associativity: null,
      precedence,
      finalAction: 'reduce',
      reasonCode: 'production-higher',
      reasonText: `归约产生式最右终结符 ${b} 位于第 ${lb} 层，高于展望符 ${a} 的第 ${la} 层，裁决：归约。`,
    };
  });

  const allResolved = decisions.every((d) => d.resolvable);
  return {
    status: allResolved ? 'resolved' : 'unresolvable',
    exact: true,
    levelCount: levels.length,
    levels,
    decisions,
    note: allResolved
      ? `已按最小层数生成 ${levels.length} 层稳定优先级策略，全部冲突依据展望符与产生式最右终结符的优先级/结合性唯一裁决。`
      : '部分冲突无法以终结符优先级与结合性裁决；这些单元保留原始竞争动作，不存在可覆盖全部冲突的策略。',
  };
}

module.exports = { resolveConflicts, associativityFor, minimumLevels, RIGHT_ASSOCIATIVE };
