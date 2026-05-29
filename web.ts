import { bus } from "./events";
import {
  clusterFailures,
  listRuns,
  loadHints,
  readRun,
  saveHints,
  type FailureCluster,
} from "./logs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const DRAFT_MODEL = process.env.DRAFT_MODEL ?? process.env.MODEL_ID ?? "z-ai/glm-5.1";

console.log(DRAFT_MODEL);

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ECOM trials</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #14181d;
    --panel-2: #1c2228;
    --border: #232a32;
    --fg: #d6dde6;
    --muted: #7b8694;
    --accent: #4fa3ff;
    --ok: #4ade80;
    --warn: #fbbf24;
    --err: #f87171;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    display: grid;
    grid-template-rows: 48px 1fr;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header nav { display: flex; gap: 4px; margin-left: 16px; }
  header nav button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    border-radius: 4px;
  }
  header nav button.active { color: var(--fg); border-color: var(--border); background: var(--panel-2); }
  header .meta { color: var(--muted); font-size: 12px; }
  header .status {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    border: 1px solid var(--border);
  }
  header .status.live { color: var(--ok); border-color: var(--ok); }
  header .status.dead { color: var(--err); border-color: var(--err); }

  .view { display: none; height: 100%; overflow: hidden; }
  .view.active { display: grid; }

  /* Run view */
  #view-run { grid-template-columns: 320px 1fr; }
  #view-run aside {
    border-right: 1px solid var(--border);
    overflow-y: auto;
    background: var(--panel);
  }
  #view-run aside .banner {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
  }
  #view-run aside ol { list-style: none; margin: 0; padding: 0; }
  #view-run aside li {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #view-run aside li.selected { background: var(--panel-2); }
  #view-run aside li:hover { background: #1a1f25; }
  .pill {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .pill.running { color: var(--accent); border-color: var(--accent); }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.fail { color: var(--err); border-color: var(--err); }
  .pill.partial { color: var(--warn); border-color: var(--warn); }
  .pill.na { color: var(--muted); }
  #view-run aside .pill { margin-left: auto; }
  #view-run main { overflow-y: auto; padding: 16px; }
  .instruction {
    color: var(--muted);
    white-space: pre-wrap;
    border-left: 2px solid var(--border);
    padding: 6px 12px;
    margin-bottom: 16px;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; }
  td.tool { color: var(--accent); }
  td.tool.err { color: var(--err); }
  td.tool.done { color: var(--ok); }
  td.lat { color: var(--muted); text-align: right; white-space: nowrap; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .summary {
    margin-top: 16px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel);
  }
  .score-detail { color: var(--muted); margin: 8px 0 0; padding-left: 16px; }
  td.tok { color: var(--muted); text-align: right; white-space: nowrap; font-size: 11px; }
  details.env, details.bootstrap { margin: 8px 0; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
  details.env summary, details.bootstrap summary { cursor: pointer; color: var(--muted); }
  details.boot-item { margin: 4px 0 4px 8px; padding: 4px 6px; border-left: 2px solid var(--border); }
  details.boot-item.err { border-left-color: var(--err); }
  details.boot-item summary { cursor: pointer; color: var(--fg); font-size: 12px; }
  .err-line { color: var(--err); padding: 4px 0; }
  tr.step-detail td { padding: 4px 8px 8px; background: var(--panel); border-bottom: 1px solid var(--border); }
  tr.step-detail details { margin: 4px 0; }
  tr.step-detail summary { cursor: pointer; color: var(--muted); padding: 2px 0; }
  pre.dump { margin: 4px 0; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; font-size: 11px; }
  pre.dump.reasoning { border-left: 3px solid var(--accent); }
  pre.dump.code { color: #c8d4e3; }
  pre.dump.output { color: #aab4be; }
  pre.dump.scratchpad { border-left: 3px solid var(--warn); }
  .refresh-btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer; margin-left: 8px; }
  .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
  .refresh-btn:active { background: var(--panel); }

  /* Runs view */
  #view-runs { grid-template-columns: 1fr; padding: 16px; overflow-y: auto; }
  #view-runs table { font-size: 12px; }
  #view-runs td.runid { color: var(--accent); cursor: pointer; }
  #view-runs td.runid:hover { text-decoration: underline; }

  /* Hints view */
  #view-hints { grid-template-columns: 1fr 360px; }
  #view-hints .editor { display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  #view-hints .editor-bar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  #view-hints .editor-bar button {
    background: var(--accent); color: #061018; border: none;
    padding: 4px 12px; cursor: pointer; font: inherit; border-radius: 4px;
  }
  #view-hints .editor-bar button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  #view-hints .editor-bar .hash { color: var(--muted); font-size: 11px; margin-left: auto; }
  #view-hints textarea {
    flex: 1; background: var(--bg); color: var(--fg); border: none; padding: 12px;
    font: inherit; resize: none; outline: none;
  }
  #view-hints .clusters {
    overflow-y: auto; background: var(--panel);
  }
  #view-hints .clusters h2 {
    margin: 0; padding: 8px 12px; font-size: 11px; text-transform: uppercase;
    color: var(--muted); border-bottom: 1px solid var(--border);
  }
  #view-hints .cluster {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  #view-hints .cluster:hover { background: var(--panel-2); }
  #view-hints .cluster.selected { background: var(--panel-2); border-left: 2px solid var(--accent); }
  #view-hints .cluster .detail { color: var(--fg); margin-bottom: 4px; word-break: break-word; }
  #view-hints .cluster .meta { color: var(--muted); font-size: 11px; }

  .toast {
    position: fixed; bottom: 16px; right: 16px; padding: 8px 12px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--fg); font-size: 12px;
    opacity: 0; transition: opacity 200ms;
  }
  .toast.show { opacity: 1; }
  .toast.err { border-color: var(--err); color: var(--err); }
</style>
</head>
<body>
<header>
  <h1>ECOM trials</h1>
  <nav>
    <button data-view="run" class="active">Live</button>
    <button data-view="runs">Runs</button>
    <button data-view="hints">Hints</button>
  </nav>
  <span class="meta" id="meta">click Refresh to load…</span>
  <button id="refresh" class="refresh-btn" title="Pull latest events">↻ Refresh</button>
  <span class="status" id="conn">idle</span>
</header>

<div id="view-run" class="view active">
  <aside>
    <div class="banner" id="run-banner">Live run</div>
    <ol id="tasks"></ol>
  </aside>
  <main id="main"><div class="empty">No trial selected.</div></main>
</div>

<div id="view-runs" class="view">
  <table>
    <thead>
      <tr>
        <th>Run</th>
        <th>Started</th>
        <th>Model</th>
        <th>Hints</th>
        <th>Tasks</th>
        <th>Score</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody id="runs-tbody"></tbody>
  </table>
</div>

<div id="view-hints" class="view">
  <div class="editor">
    <div class="editor-bar">
      <button id="hints-save">Save</button>
      <button id="hints-draft" class="secondary" disabled>Draft a rule from selected cluster</button>
      <span class="hash" id="hints-hash"></span>
    </div>
    <textarea id="hints-text" spellcheck="false"></textarea>
  </div>
  <div class="clusters">
    <h2>Failure clusters</h2>
    <div id="clusters-list"><div class="empty">No failures yet.</div></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const state = {
  tab: 'run',
  currentRunId: null,         // null = live; otherwise loaded past run
  benchmarkId: null,
  trials: new Map(),
  selected: null,
  finalPct: null,
  clusters: [],
  selectedCluster: null,
  hintsHash: null,
};

const $ = (id) => document.getElementById(id);

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  })[c]);
}

function pillFor(t) {
  if (t.status === 'done') {
    if (!t.scoreAvailable) return { cls: 'na', text: 'n/a' };
    if (t.score >= 1) return { cls: 'ok', text: t.score.toFixed(2) };
    if (t.score > 0) return { cls: 'partial', text: t.score.toFixed(2) };
    return { cls: 'fail', text: t.score.toFixed(2) };
  }
  if (t.status === 'running') return { cls: 'running', text: 'running' };
  return { cls: 'na', text: 'pending' };
}

function resetRunView() {
  state.trials = new Map();
  state.selected = null;
  state.finalPct = null;
  renderTasks();
  renderMain();
}

function renderTasks() {
  const ol = $('tasks');
  const items = [...state.trials.values()];
  ol.innerHTML = '';
  for (const t of items) {
    const li = document.createElement('li');
    if (state.selected === t.taskId) li.classList.add('selected');
    const p = pillFor(t);
    li.innerHTML = '<span>' + t.taskId + '</span><span class="pill ' + p.cls + '">' + p.text + '</span>';
    li.addEventListener('click', () => { state.selected = t.taskId; renderTasks(); renderMain(); });
    ol.appendChild(li);
  }
}

function renderMain() {
  const main = $('main');
  if (!state.selected) {
    main.innerHTML = '<div class="empty">No trial selected.</div>';
    return;
  }
  const t = state.trials.get(state.selected);
  if (!t) return;
  const parts = [];
  if (t.instruction) parts.push('<div class="instruction">' + escapeHtml(t.instruction) + '</div>');
  if (state.envFlags) {
    const flagPairs = Object.entries(state.envFlags).filter(function(p){ return p[1]; });
    if (flagPairs.length) {
      parts.push('<details class="env"><summary>env flags (' + flagPairs.length + ')</summary><pre>');
      for (const p of flagPairs) parts.push(escapeHtml(p[0] + '=' + p[1]) + '\\n');
      parts.push('</pre></details>');
    }
  }
  // Bootstrap entries (system prompt, initial scratchpad, /docs preload, etc.)
  if (t.bootstraps && t.bootstraps.length) {
    parts.push('<details class="bootstrap"><summary>bootstrap (' + t.bootstraps.length + ')</summary>');
    for (const b of t.bootstraps) {
      const cls = b.ok === false ? 'err' : '';
      parts.push('<details class="boot-item ' + cls + '"><summary>' + escapeHtml(b.tool) + ' (' + (b.outputBytes || (b.output && b.output.length) || 0) + ' B)' + (b.ok === false ? ' ⚠' : '') + '</summary>');
      if (b.errorMessage) parts.push('<div class="err-line">' + escapeHtml(b.errorMessage) + '</div>');
      parts.push('<pre class="dump">' + escapeHtml(typeof b.output === 'string' ? b.output : JSON.stringify(b.output, null, 2)) + '</pre>');
      parts.push('</details>');
    }
    parts.push('</details>');
  }
  if (t.steps.length === 0) {
    parts.push('<div class="empty">Waiting for first step…</div>');
  } else {
    parts.push('<table><thead><tr><th>#</th><th>tool</th><th>plan</th><th>latency</th><th>tok</th></tr></thead><tbody>');
    for (const s of t.steps) {
      const cls = s.ok === false ? 'err' : (s.tool === 'report_completion' ? 'done' : '');
      const tok = s.reasoningTokens != null
        ? (s.reasoningTokens + 'r/' + (s.completionTokens || '?') + 'c')
        : (s.completionTokens != null ? (s.completionTokens + 'c') : '');
      const headRow =
        '<tr class="step-head" data-step="' + s.step + '">' +
        '<td>' + s.step + '</td>' +
        '<td class="tool ' + cls + '">' + escapeHtml(s.tool) + (s.errorMessage ? ' ⚠' : '') + '</td>' +
        '<td>' + escapeHtml(s.planFirst) + (s.errorMessage ? '<div style="color:var(--err);margin-top:4px">' + escapeHtml(s.errorMessage) + '</div>' : '') + '</td>' +
        '<td class="lat">' + s.latencyMs + ' ms</td>' +
        '<td class="tok">' + escapeHtml(tok) + '</td>' +
        '</tr>';
      const detailBits = [];
      if (s.reasoning) detailBits.push('<details open><summary>reasoning (' + s.reasoning.length + ' chars)</summary><pre class="dump reasoning">' + escapeHtml(s.reasoning) + '</pre></details>');
      if (s.code) detailBits.push('<details><summary>code</summary><pre class="dump code">' + escapeHtml(s.code) + '</pre></details>');
      if (s.output) detailBits.push('<details><summary>output</summary><pre class="dump output">' + escapeHtml(s.output) + '</pre></details>');
      if (s.scratchpadAfter !== undefined) detailBits.push('<details><summary>scratchpad after</summary><pre class="dump scratchpad">' + escapeHtml(typeof s.scratchpadAfter === 'string' ? s.scratchpadAfter : JSON.stringify(s.scratchpadAfter, null, 2)) + '</pre></details>');
      const detailRow = detailBits.length
        ? '<tr class="step-detail"><td colspan="5">' + detailBits.join('') + '</td></tr>'
        : '';
      parts.push(headRow + detailRow);
    }
    parts.push('</tbody></table>');
  }
  if (t.status === 'done') {
    const scoreLine = t.scoreAvailable ? 'Score ' + (t.score != null ? t.score.toFixed(2) : '?') : 'Score not available';
    parts.push('<div class="summary"><strong>' + scoreLine + '</strong>');
    if (t.scoreDetail && t.scoreDetail.length) {
      parts.push('<ul class="score-detail">');
      for (const d of t.scoreDetail) parts.push('<li>' + escapeHtml(d) + '</li>');
      parts.push('</ul>');
    }
    parts.push('</div>');
  }
  main.innerHTML = parts.join('');
}

function ensureTrial(taskId) {
  let t = state.trials.get(taskId);
  if (!t) {
    t = { taskId, steps: [], bootstraps: [], status: 'pending', scoreAvailable: false, scoreDetail: [] };
    state.trials.set(taskId, t);
  }
  if (!t.bootstraps) t.bootstraps = [];
  return t;
}

function handle(ev) {
  if (ev.type === 'run:start') {
    // New run begins — drop any prior trials so we don't double-render
    // events from a previous run still sitting in the bus buffer.
    state.trials = new Map();
    state.finalPct = null;
    state.selected = null;
    state.benchmarkId = ev.benchmarkId;
    state.runId = ev.runId;
    state.envFlags = ev.envFlags || {};
    $('meta').textContent = ev.benchmarkId + ' · ' + ev.policy + ' · ' + ev.modelId + ' · ' + ev.tasks.length + ' tasks';
    for (const t of ev.tasks) ensureTrial(t.taskId);
    renderTasks();
  } else if (ev.type === 'trial:start') {
    const t = ensureTrial(ev.taskId);
    t.trialId = ev.trialId;
    t.instruction = ev.instruction;
    t.status = 'running';
    if (!state.selected) state.selected = ev.taskId;
    renderTasks();
    renderMain();
  } else if (ev.type === 'bootstrap') {
    const t = ensureTrial(ev.taskId);
    t.bootstraps.push({
      tool: ev.tool, input: ev.input, output: ev.output,
      outputBytes: ev.outputBytes, ok: ev.ok, errorMessage: ev.errorMessage,
    });
    if (state.selected === ev.taskId) renderMain();
  } else if (ev.type === 'step') {
    const t = ensureTrial(ev.taskId);
    t.steps.push({
      step: ev.step, tool: ev.tool, planFirst: ev.planFirst,
      latencyMs: ev.latencyMs, ok: ev.ok, errorMessage: ev.errorMessage,
      code: ev.input && ev.input.code, output: ev.output,
      reasoning: ev.reasoning, reasoningTokens: ev.reasoningTokens,
      completionTokens: ev.completionTokens, promptTokens: ev.promptTokens,
      scratchpadAfter: ev.scratchpadAfter,
    });
    if (state.selected === ev.taskId) renderMain();
  } else if (ev.type === 'trial:end') {
    const t = ensureTrial(ev.taskId);
    t.status = 'done';
    t.scoreAvailable = ev.scoreAvailable;
    if (ev.scoreAvailable) t.score = ev.score;
    if (ev.scoreDetail && ev.scoreDetail.length) t.scoreDetail = ev.scoreDetail;
    renderTasks();
    if (state.selected === ev.taskId) renderMain();
  } else if (ev.type === 'trial:score') {
    // Deferred-scoring landing — overwrites the placeholder from trial:end
    const t = ensureTrial(ev.taskId);
    t.scoreAvailable = true;
    t.score = ev.score;
    if (ev.scoreDetail && ev.scoreDetail.length) t.scoreDetail = ev.scoreDetail;
    renderTasks();
    if (state.selected === ev.taskId) renderMain();
  } else if (ev.type === 'run:end') {
    state.finalPct = ev.finalPct;
    if (ev.finalPct != null) $('meta').textContent += ' · FINAL ' + ev.finalPct.toFixed(2) + '%';
  }
}

/* Runs view */
async function loadRuns() {
  const res = await fetch('/api/runs');
  const runs = await res.json();
  const tbody = $('runs-tbody');
  tbody.innerHTML = '';
  for (const r of runs) {
    const scoreVals = Object.values(r.scores);
    const completed = scoreVals.filter((v) => v !== null && v !== undefined).length;
    const finalText = r.finalPct != null ? r.finalPct.toFixed(2) + '%' : '—';
    const started = new Date(r.startedAt).toLocaleString();
    const statusCls = r.status === 'done' ? 'ok' : (r.status === 'incomplete' ? 'partial' : 'running');
    const tr = document.createElement('tr');
    tr.innerHTML = (
      '<td class="runid" data-runid="' + r.runId + '">' + r.runId + '</td>' +
      '<td>' + started + '</td>' +
      '<td>' + escapeHtml(r.modelId ?? '—') + '</td>' +
      '<td>' + escapeHtml((r.hintsHash ?? '').slice(7, 15)) + '</td>' +
      '<td>' + completed + ' / ' + Object.keys(r.scores).length + '</td>' +
      '<td>' + finalText + '</td>' +
      '<td><span class="pill ' + statusCls + '">' + r.status + '</span></td>'
    );
    tr.querySelector('.runid').addEventListener('click', () => loadRunDetail(r.runId));
    tbody.appendChild(tr);
  }
}

async function loadRunDetail(runId) {
  const res = await fetch('/api/runs/' + encodeURIComponent(runId));
  const events = await res.json();
  state.currentRunId = runId;
  resetRunView();
  for (const ev of events) handle(ev);
  $('run-banner').textContent = 'Past run · ' + runId;
  setTab('run');
}

/* Hints view */
async function loadHints() {
  const res = await fetch('/api/hints');
  const { text, hash } = await res.json();
  $('hints-text').value = text;
  state.hintsHash = hash;
  $('hints-hash').textContent = hash;
}

async function saveHintsApi() {
  const text = $('hints-text').value;
  const res = await fetch('/api/hints', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: text });
  if (!res.ok) { toast('Save failed: ' + res.status, true); return; }
  const { hash } = await res.json();
  state.hintsHash = hash;
  $('hints-hash').textContent = hash;
  toast('Hints saved');
}

async function loadClusters() {
  const res = await fetch('/api/failures');
  const clusters = await res.json();
  state.clusters = clusters;
  state.selectedCluster = null;
  $('hints-draft').disabled = true;
  const wrap = $('clusters-list');
  if (clusters.length === 0) { wrap.innerHTML = '<div class="empty">No failures yet.</div>'; return; }
  wrap.innerHTML = '';
  for (const c of clusters) {
    const div = document.createElement('div');
    div.className = 'cluster';
    div.innerHTML = (
      '<div class="detail">' + escapeHtml(c.detail) + '</div>' +
      '<div class="meta">' + c.count + ' occurrences · ' +
      c.taskIds.length + ' tasks · ' +
      c.runIds.length + ' runs</div>'
    );
    div.addEventListener('click', () => {
      state.selectedCluster = c;
      for (const el of wrap.querySelectorAll('.cluster')) el.classList.remove('selected');
      div.classList.add('selected');
      $('hints-draft').disabled = false;
    });
    wrap.appendChild(div);
  }
}

async function draftRule() {
  if (!state.selectedCluster) return;
  $('hints-draft').disabled = true;
  toast('Drafting…');
  try {
    const res = await fetch('/api/draft-hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cluster: state.selectedCluster }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { proposed } = await res.json();
    const ta = $('hints-text');
    ta.value = ta.value.replace(/\\s*$/, '') + '\\n\\n' + proposed + '\\n';
    toast('Rule drafted — review and Save');
  } catch (err) {
    toast('Draft failed: ' + (err.message || err), true);
  } finally {
    $('hints-draft').disabled = false;
  }
}

/* Tabs */
function setTab(name) {
  state.tab = name;
  for (const btn of document.querySelectorAll('header nav button')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === 'view-' + name);
  }
  if (name === 'runs') loadRuns();
  if (name === 'hints') { loadHints(); loadClusters(); }
}

document.querySelectorAll('header nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    // Clicking back to "Run" tab returns us to the live view — drop the
    // past-run lock and force an immediate poll.
    if (view === 'run' && state.currentRunId) {
      state.currentRunId = null;
      state.lastEventCount = 0;
      $('run-banner').textContent = '';
      resetRunView();
      refreshNow();
    }
    setTab(view);
  });
});
$('hints-save').addEventListener('click', saveHintsApi);
$('hints-draft').addEventListener('click', draftRule);

/* Manual refresh only — no auto-polling. Click Refresh to pull a fresh
   snapshot from the server and replay it into a clean state. */
let refreshing = false;

async function refreshNow() {
  if (refreshing) return;
  if (state.currentRunId) {
    $('conn').textContent = 'past run';
    $('conn').className = 'status';
    return;
  }
  refreshing = true;
  try {
    const res = await fetch('/api/current');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const events = Array.isArray(body) ? body : (body.events || []);
    const wasSelected = state.selected;
    state.trials = new Map();
    state.finalPct = null;
    state.envFlags = null;
    for (const ev of events) handle(ev);
    if (wasSelected && state.trials.has(wasSelected)) state.selected = wasSelected;
    renderTasks();
    renderMain();
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    $('conn').textContent = 'updated ' + hh + ':' + mm + ':' + ss;
    $('conn').className = 'status live';
  } catch (err) {
    console.error(err);
    $('conn').textContent = 'refresh failed';
    $('conn').className = 'status dead';
  } finally {
    refreshing = false;
  }
}

const refreshBtn = document.getElementById('refresh');
if (refreshBtn) refreshBtn.addEventListener('click', refreshNow);

// One initial fetch on page load so the view isn't empty.
refreshNow();
</script>
</body>
</html>`;


async function draftHint(cluster: FailureCluster): Promise<string> {
  if (!OPENROUTER_KEY) {
    throw new Error("OPENROUTER_API_KEY required to draft rules");
  }
  const system = `You write concise, universal rules for an LLM agent's system prompt. Each rule is a single short paragraph in markdown under an H2 heading. Rules must:
- be generalizable to unseen tasks (no task IDs, no specific SKUs)
- describe what the agent should do, with a concrete reason
- avoid restating existing rules
- be tight and copy-editable
Output: the rule only, no preamble, no code fences.`;
  const user = `Failure pattern observed across ${cluster.count} occurrences in ${cluster.taskIds.length} tasks and ${cluster.runIds.length} runs:

> ${cluster.detail}

Write one new system-prompt rule that, if followed, would prevent this failure pattern in any future task. Start with an H2 heading.`;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== "string") throw new Error("no draft content returned");
  return out.trim();
}

async function readBody(req: Request): Promise<string> {
  return await req.text();
}

export function startWebServer(port: number): { url: string; stop: () => void } {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/" || path === "/index.html") {
          return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (path === "/api/current" && req.method === "GET") {
          return Response.json(bus.replay());
        }
        if (path === "/api/runs" && req.method === "GET") {
          return Response.json(listRuns());
        }
        if (path.startsWith("/api/runs/") && req.method === "GET") {
          const runId = decodeURIComponent(path.slice("/api/runs/".length));
          return Response.json(readRun(runId));
        }
        if (path === "/api/hints" && req.method === "GET") {
          const { text, hash } = loadHints();
          return Response.json({ text, hash });
        }
        if (path === "/api/hints" && req.method === "PUT") {
          const text = await readBody(req);
          const { hash } = saveHints(text);
          return Response.json({ hash });
        }
        if (path === "/api/failures" && req.method === "GET") {
          return Response.json(clusterFailures());
        }
        if (path === "/api/draft-hint" && req.method === "POST") {
          const body = (await req.json()) as { cluster?: FailureCluster };
          if (!body?.cluster) return new Response("missing cluster", { status: 400 });
          const proposed = await draftHint(body.cluster);
          return Response.json({ proposed });
        }
        return new Response("Not found", { status: 404 });
      } catch (err) {
        console.error("web error:", err);
        return new Response(
          err instanceof Error ? err.message : String(err),
          { status: 500 },
        );
      }
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
