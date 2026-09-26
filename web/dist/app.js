'use strict';

(function () {
  const DRAFT_KEY = 'lr1-review:draft:v1';
  const fields = ['terminals', 'nonterminals', 'start', 'productions'];
  const form = document.getElementById('grammar-form');
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const clearBtn = document.getElementById('clear-btn');
  const exampleBtn = document.getElementById('example-btn');
  const draftHint = document.getElementById('draft-hint');
  const statusRegion = document.getElementById('status-region');

  const errorPanel = document.getElementById('error-panel');
  const errorList = document.getElementById('error-list');
  const warningHeading = document.getElementById('warning-heading');
  const warningList = document.getElementById('warning-list');
  const summaryPanel = document.getElementById('summary-panel');
  const conflictPanel = document.getElementById('conflict-panel');
  const nullableDetails = document.getElementById('nullable-details');
  const nullableFirst = document.getElementById('nullable-first');
  const statesDetails = document.getElementById('states-details');
  const statesEl = document.getElementById('states');
  const tableDetails = document.getElementById('table-details');
  const tableEl = document.getElementById('action-table');

  const EXAMPLE = {
    terminals: 'id + * ( )',
    nonterminals: 'E T F',
    start: 'E',
    productions: ['E -> E + T', 'E -> T', 'T -> T * F', 'T -> F', 'F -> ( E )', 'F -> id'].join('\n'),
  };

  // ---- draft persistence ---------------------------------------------------
  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* corrupt draft: ignore */ }
    return null;
  }
  function saveDraft() {
    const draft = {};
    for (const f of fields) draft[f] = document.getElementById(f).value;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) { /* storage may be unavailable */ }
    draftHint.textContent = '草稿已自动保存于本浏览器';
  }
  function restoreDraft() {
    const draft = loadDraft();
    if (draft) {
      for (const f of fields) if (typeof draft[f] === 'string') document.getElementById(f).value = draft[f];
      draftHint.textContent = '已恢复上次编辑的草稿';
    } else {
      fillForm(EXAMPLE);
      draftHint.textContent = '已填入示例文法，可直接发起复核';
    }
  }
  function fillForm(obj) {
    for (const f of fields) document.getElementById(f).value = obj[f] || '';
  }

  // ---- result versioning: stale results must never overwrite conclusion ----
  let runSeq = 0;          // bumped on submit
  let draftGeneration = 0; // bumped on every draft edit
  let activeController = null;
  let currentView = null;  // {runId, generation, kind} describing what is on screen

  function markStaleIfAny() {
    if (currentView && !currentView.stale && currentView.generation !== draftGeneration) {
      const note = document.createElement('p');
      note.className = 'stale-note';
      note.textContent = '草稿已修改：以下为修改前的过期结果，未用于当前结论。请重新发起复核。';
      statusRegion.prepend(note);
      currentView.stale = true;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) for (const c of [].concat(children)) if (c != null) node.appendChild(c);
    return node;
  }

  function resetResultPanels() {
    for (const p of [errorPanel, summaryPanel, conflictPanel, nullableDetails, statesDetails, tableDetails]) {
      p.hidden = true;
    }
    statusRegion.innerHTML = '';
    errorList.innerHTML = '';
    warningList.innerHTML = '';
    warningHeading.hidden = true;
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    cancelBtn.disabled = !busy;
  }

  // ---- rendering -----------------------------------------------------------
  function renderBanner(kind, text) {
    statusRegion.appendChild(el('div', { class: `banner ${kind}`, role: 'status' }, [document.createTextNode(text)]));
  }

  function renderIssues(list, issues, cls) {
    for (const issue of issues) {
      const li = el('li', { class: cls }, [
        el('span', { class: 'issue-code' }, document.createTextNode(issue.code || '')),
        document.createTextNode(issue.message || ''),
      ]);
      list.appendChild(li);
    }
  }

  function renderSummary(result) {
    const g = result.grammar;
    const a = result.analysis;
    const dl = el('dl', { class: 'kv-grid' });
    const rows = [
      ['终结符', g.terminals.join(' ')],
      ['非终结符', g.nonterminals.join(' ')],
      ['起始符', g.start],
      ['产生式数', String(a.productions.filter((p) => !p.augmented).length)],
      ['项目集数', String(a.states.length)],
      ['结论', a.conflictFree ? '无冲突，文法为 LR(1)' : `检出 ${a.conflictCount} 处冲突`],
    ];
    for (const [k, v] of rows) {
      dl.appendChild(el('dt', null, document.createTextNode(k)));
      dl.appendChild(el('dd', null, document.createTextNode(v)));
    }
    summaryPanel.appendChild(dl);
    summaryPanel.hidden = false;
  }

  function actionBadge(action) {
    if (action.type === 'shift') return el('span', { class: 'badge shift' }, document.createTextNode('移进'));
    if (action.type === 'reduce') return el('span', { class: 'badge reduce' }, document.createTextNode('归约'));
    return el('span', { class: 'badge accept' }, document.createTextNode('接受'));
  }

  function renderConflict(c) {
    const card = el('div', { class: 'conflict-card' });
    const typeLabel = c.type === 'shift-reduce' ? '移进/归约冲突（shift/reduce）'
      : c.type === 'reduce-reduce' ? '归约/归约冲突（reduce/reduce）' : `${c.type} 冲突`;
    card.appendChild(el('h3', null, document.createTextNode(
      `首个冲突（按状态编号、展望符与动作顺序稳定给出）：${typeLabel}`)));
    card.appendChild(el('p', null, document.createTextNode(
      `状态 I${c.state}，展望符 ${c.lookahead}：该输入前缀下两项分析动作彼此矛盾。`)));

    const pair = el('div', { class: 'action-pair' });
    for (const act of c.actions) {
      const box = el('div', { class: 'action-box' });
      box.appendChild(el('h4', null, [
        actionBadge(act),
        document.createTextNode(' '),
        document.createTextNode(act.text),
      ]));
      if (act.productionText) {
        box.appendChild(el('div', { class: 'rule' }, document.createTextNode(`产生式：${act.productionText}`)));
      }
      const ul = el('ul', { class: 'competing-items' });
      for (const it of act.items) ul.appendChild(el('li', null, document.createTextNode(it.text)));
      box.appendChild(ul);
      pair.appendChild(box);
    }
    card.appendChild(pair);

    // Verifiable prefix evidence
    const ev = el('div', { class: 'prefix-evidence' });
    ev.appendChild(el('h4', null, document.createTextNode('可核查的前缀证据')));
    ev.appendChild(el('div', null, document.createTextNode(
      `从初始状态 I0 出发，沿符号串转移即达冲突状态 I${c.state}：`)));
    const statesText = c.prefix.states.map((s) => `I${s}`).join(' → ');
    const symbols = c.prefix.symbols.length ? c.prefix.symbols.join(' ') : '（空前缀）';
    ev.appendChild(el('div', { class: 'path' }, document.createTextNode(`${statesText}`)));
    ev.appendChild(el('div', { class: 'path' }, document.createTextNode(`读入前缀：${symbols}；再读入展望符 ${c.lookahead}`)));
    card.appendChild(ev);

    // Full state item listing
    const stateList = el('ul', { class: 'state-items' });
    for (const it of c.stateItems) {
      const li = el('li', { class: it.kernel ? 'kernel' : '' }, document.createTextNode(it.text));
      stateList.appendChild(li);
    }
    card.appendChild(el('h4', null, document.createTextNode(`状态 I${c.state} 的全部 LR(1) 项目（粗体为核项目）`)));
    card.appendChild(stateList);

    conflictPanel.appendChild(card);
    conflictPanel.hidden = false;
  }

  function renderNullableFirst(a) {
    nullableFirst.innerHTML = '';
    const table = el('table');
    const thead = el('thead', null, el('tr', null, [
      el('th', null, document.createTextNode('非终结符')),
      el('th', null, document.createTextNode('Nullable')),
      el('th', null, document.createTextNode('FIRST')),
    ]));
    const tbody = el('tbody');
    for (const n of a.nonterminals) {
      tbody.appendChild(el('tr', null, [
        el('td', { class: 'sym' }, document.createTextNode(n)),
        el('td', null, document.createTextNode(a.nullable.includes(n) ? '是' : '否')),
        el('td', null, document.createTextNode(a.first[n] && a.first[n].length ? a.first[n].join(' ') : '∅')),
      ]));
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    nullableFirst.appendChild(table);
    nullableDetails.hidden = false;
  }

  function renderStates(a) {
    statesEl.innerHTML = '';
    for (const st of a.states) {
      const card = el('div', { class: 'state-card', id: `state-${st.id}` });
      card.appendChild(el('h4', null, document.createTextNode(`I${st.id}`)));
      const ul = el('ul');
      for (const it of st.items) {
        ul.appendChild(el('li', { class: it.kernel ? 'kernel' : '' }, document.createTextNode(it.text)));
      }
      card.appendChild(ul);
      const gotos = Object.entries(st.transitions)
        .map(([sym, target]) => `${sym} → I${target}`)
        .join('　');
      if (gotos) card.appendChild(el('div', { class: 'gotos' }, document.createTextNode(`goto：${gotos}`)));
      statesEl.appendChild(card);
    }
    statesDetails.hidden = false;
  }

  function renderActionTable(a) {
    tableEl.innerHTML = '';
    const terminals = a.terminals;
    const nonterminals = a.nonterminals;
    const table = el('table');
    const thead = el('thead');
    const headRow = el('tr', null, [el('th', null, document.createTextNode('状态'))]);
    for (const t of terminals) headRow.appendChild(el('th', null, document.createTextNode(t)));
    for (const n of nonterminals) headRow.appendChild(el('th', null, document.createTextNode(n)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const row of a.actionTable) {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'state-head' }, document.createTextNode(`I${row.state}`)));
      for (const t of terminals) {
        const td = el('td');
        const acts = (row.actions[t] || []);
        if (acts.length > 1) {
          td.appendChild(el('span', { class: 'act conflict' },
            document.createTextNode(acts.map((x) => x.short).join(' / '))));
        } else if (acts.length === 1) {
          const x = acts[0];
          const cls = x.type === 'shift' ? 's' : x.type === 'reduce' ? 'r' : 'acc';
          td.appendChild(el('span', { class: `act ${cls}` }, document.createTextNode(x.short)));
        }
        tr.appendChild(td);
      }
      for (const n of nonterminals) {
        const td = el('td');
        if (row.gotos[n] != null) {
          td.appendChild(el('span', { class: 'act' }, document.createTextNode(String(row.gotos[n]))));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableEl.appendChild(table);
    tableDetails.hidden = false;
  }

  function renderResult(result, runId, generation) {
    resetResultPanels();
    currentView = { runId, generation, stale: false };

    if (!result.ok) {
      renderBanner('error', '文法校验未通过，请修正下列问题后重新复核。');
      renderIssues(errorList, result.errors, 'error');
      if (result.warnings && result.warnings.length) {
        warningHeading.hidden = false;
        renderIssues(warningList, result.warnings, 'warning');
      }
      errorPanel.hidden = false;
      return;
    }

    const a = result.analysis;
    if (a.conflictFree) {
      renderBanner('ok', `复核通过：该文法为 LR(1) 文法，共 ${a.states.length} 个项目集，无移进/归约或归约/归约冲突。`);
    } else {
      renderBanner('conflict', `复核未通过：动作表存在 ${a.conflictCount} 处冲突，已定位首个冲突及其前缀证据。`);
    }
    renderSummary(result);
    if (result.warnings && result.warnings.length) {
      warningHeading.hidden = false;
      renderIssues(warningList, result.warnings, 'warning');
      errorPanel.hidden = false;
    }
    if (!a.conflictFree && a.firstConflict) renderConflict(a.firstConflict);
    renderNullableFirst(a);
    renderStates(a);
    renderActionTable(a);
  }

  // ---- submission / cancellation -------------------------------------------
  async function submitReview() {
    saveDraft();
    const spec = {};
    for (const f of fields) spec[f] = document.getElementById(f).value;
    const runId = ++runSeq;
    const generation = draftGeneration;
    activeController = new AbortController();
    setBusy(true);
    // Keep the previous conclusion on screen while computing; only clear a
    // prior staleness marker (a draft edit during the run re-adds it).
    const oldNote = statusRegion.querySelector('.stale-note');
    if (oldNote) oldNote.remove();
    if (currentView) currentView.stale = false;
    const computing = el('div', { class: 'banner info', id: 'computing-banner' },
      document.createTextNode('正在构造规范 LR(1) 项目集…'));
    statusRegion.appendChild(computing);
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spec),
        signal: activeController.signal,
      });
      const data = await res.json();
      // Stale guard: a cancelled or superseded / edited-draft result must not
      // overwrite the current conclusion.
      if (runId !== runSeq || generation !== draftGeneration) {
        return;
      }
      renderResult(data, runId, generation);
    } catch (err) {
      if (err.name === 'AbortError') return; // explicit cancellation
      if (runId !== runSeq || generation !== draftGeneration) return;
      resetResultPanels();
      renderBanner('error', `复核请求失败：${escapeHtml(err.message)}`);
    } finally {
      computing.remove();
      if (runId === runSeq) {
        activeController = null;
        setBusy(false);
      }
    }
  }

  // ---- events ---------------------------------------------------------------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitReview();
  });
  cancelBtn.addEventListener('click', () => {
    if (activeController) activeController.abort();
    runSeq += 1; // invalidate any in-flight response
    activeController = null;
    setBusy(false);
    resetResultPanels();
    renderBanner('info', '计算已取消，草稿保留未改动。');
    currentView = null;
  });
  clearBtn.addEventListener('click', () => {
    for (const f of fields) document.getElementById(f).value = '';
    saveDraft();
    document.getElementById('terminals').focus();
  });
  exampleBtn.addEventListener('click', () => {
    fillForm(EXAMPLE);
    saveDraft();
  });
  for (const f of fields) {
    document.getElementById(f).addEventListener('input', () => {
      draftGeneration += 1;
      saveDraft();
      markStaleIfAny();
    });
  }

  restoreDraft();
})();
