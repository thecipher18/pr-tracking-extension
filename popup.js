'use strict';

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

let settings = {};
let currentTab = 'github';
let allPRs = [];
let allTickets = [];
let prCursors = {}; // { "owner/repo": endCursor } for repos with more pages
let selectedRepo = '';

const STALE_MS = 30 * 60 * 1000;

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  settings = await loadSettings();
  initTabs();
  document.getElementById('refresh-btn').addEventListener('click', refresh);
  document.getElementById('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('gh-search').addEventListener('input', applyPRFilter);
  document.getElementById('author-filter').addEventListener('change', applyPRFilter);
  document.getElementById('gh-assignee-filter').addEventListener('change', applyPRFilter);
  document.getElementById('gh-status-filter').addEventListener('change', applyPRFilter);
  document.getElementById('jira-search').addEventListener('input', applyTicketFilter);
  document.getElementById('assignee-filter').addEventListener('change', applyTicketFilter);
  document.getElementById('jira-status-filter').addEventListener('change', applyTicketFilter);
  loadTab(currentTab);
});

// ── Tabs ───────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      if (name === currentTab) return;
      currentTab = name;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.getElementById('github-pane').style.display = name === 'github' ? 'block' : 'none';
      document.getElementById('jira-pane').style.display   = name === 'jira'   ? 'block' : 'none';
      loadTab(name);
    });
  });
}

async function refresh() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  const key = currentTab === 'github' ? 'gh_prs' : 'jira_tickets';
  await sessionDel(key);
  await loadTab(currentTab);
  btn.classList.remove('spinning');
}

function loadTab(name) {
  return name === 'github' ? loadGitHub() : loadJira();
}

// ── GitHub ─────────────────────────────────────────────────────────────────
async function loadGitHub() {
  const pane = document.getElementById('github-pane');
  const cached = await sessionGet('gh_prs');
  if (cached) {
    renderPRs(pane, cached.data);
    stampUpdated(cached.time);
    if (Date.now() - cached.time > STALE_MS) fetchGitHub(pane, true);
  } else {
    showLoading(pane);
    await fetchGitHub(pane, false);
  }
}

async function fetchGitHub(pane, silent) {
  if (!settings.githubToken) {
    if (!silent) showError(pane, 'No GitHub token. <a href="#" class="open-opts">Open Settings →</a>');
    return;
  }
  if (!settings.repos?.length) {
    if (!silent) showEmpty(pane, 'No repos configured. Add them in Settings.');
    return;
  }
  try {
    const { prs, nextCursors } = await fetchAllPRs(settings.repos, settings.githubToken);
    prCursors = nextCursors;
    await sessionSet('gh_prs', prs);
    stampUpdated(Date.now());
    renderPRs(pane, prs);
  } catch (e) {
    if (!silent) showError(pane, `GitHub error: ${e.message}`);
  }
}

async function loadMorePRs() {
  const btn = document.getElementById('gh-load-more').querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const repos = Object.keys(prCursors);
    const { prs: next, nextCursors } = await fetchAllPRs(repos, settings.githubToken, prCursors);
    prCursors = nextCursors;
    allPRs = [...allPRs, ...next].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    await sessionSet('gh_prs', allPRs);
    renderPRs(document.getElementById('github-pane'), allPRs);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Load more';
  }
}

async function fetchAllPRs(repos, token, cursors = {}) {
  const results = await Promise.allSettled(
    repos.map(repo => {
      const [owner, name] = repo.split('/');
      return fetchRepoPRs(owner, name, token, cursors[repo] ?? null);
    })
  );
  const prs = [];
  const nextCursors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      prs.push(...r.value.nodes.map(pr => ({ ...pr, repo: repos[i] })));
      if (r.value.pageInfo.hasNextPage) nextCursors[repos[i]] = r.value.pageInfo.endCursor;
    } else {
      console.warn(`fetchRepoPRs(${repos[i]}):`, r.reason.message);
    }
  });
  return {
    prs: prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    nextCursors,
  };
}

async function fetchRepoPRs(owner, name, token, cursor) {
  const query = `
    query($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: [OPEN], first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number title url isDraft headRefName
            reviewDecision createdAt updatedAt
            author { login }
            assignees(first: 5) { nodes { login } }
            statusCheckRollup { state }
          }
        }
      }
    }
  `;
  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, cursor } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  const pr = data.data?.repository?.pullRequests;
  return { nodes: pr?.nodes ?? [], pageInfo: pr?.pageInfo ?? { hasNextPage: false } };
}

function prStatus(pr) {
  if (pr.isDraft) return 'Draft';
  return { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes Requested', REVIEW_REQUIRED: 'Review Required' }[pr.reviewDecision] ?? 'No Reviews';
}

function renderRepoTabs(prs) {
  const repos = [...new Set(prs.map(p => p.repo))].sort();
  const bar = document.getElementById('repo-tabs');
  if (!repos.length) { bar.style.display = 'none'; return; }
  if (!selectedRepo) selectedRepo = repos[0];
  bar.style.display = 'flex';
  bar.innerHTML = ['', ...repos].map(repo => {
    const label = repo === '' ? 'All' : repo.split('/')[1];
    const count = repo === '' ? prs.length : prs.filter(p => p.repo === repo).length;
    const active = selectedRepo === repo ? ' active' : '';
    return `<button class="repo-pill${active}" data-repo="${esc(repo)}">${esc(label)} <span class="pill-count">${count}</span></button>`;
  }).join('');
  bar.querySelectorAll('.repo-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedRepo = btn.dataset.repo;
      renderRepoTabs(allPRs);
      applyPRFilter();
    });
  });
}

function renderPRs(pane, prs) {
  allPRs = prs;
  clearState(pane);
  renderRepoTabs(prs);
  populateSelect(document.getElementById('author-filter'),
    new Set(prs.map(p => p.author?.login).filter(Boolean)), 'All authors');
  populateSelect(document.getElementById('gh-assignee-filter'),
    new Set(prs.flatMap(p => p.assignees?.nodes?.map(a => a.login) ?? []).filter(Boolean)), 'All assignees');
  populateSelect(document.getElementById('gh-status-filter'),
    new Set(prs.map(prStatus)), 'All statuses');
  document.getElementById('github-filter').style.display = prs.length ? '' : 'none';
  const loadMore = document.getElementById('gh-load-more');
  if (Object.keys(prCursors).length) {
    loadMore.innerHTML = '<button class="load-more-btn">Load more</button>';
    loadMore.querySelector('button').addEventListener('click', loadMorePRs);
  } else {
    loadMore.innerHTML = '';
  }
  applyPRFilter();
}

function applyPRFilter() {
  const pane     = document.getElementById('github-pane');
  const q        = document.getElementById('gh-search').value.toLowerCase();
  const author   = document.getElementById('author-filter').value;
  const assignee = document.getElementById('gh-assignee-filter').value;
  const status   = document.getElementById('gh-status-filter').value;
  const filtered = allPRs
    .filter(p => !selectedRepo || p.repo === selectedRepo)
    .filter(p => !q            || p.title.toLowerCase().includes(q) || String(p.number).includes(q))
    .filter(p => !author       || p.author?.login === author)
    .filter(p => !assignee     || p.assignees?.nodes?.some(a => a.login === assignee))
    .filter(p => !status       || prStatus(p) === status);
  if (!filtered.length) { showEmpty(pane, 'No PRs match the selected filters.'); return; }
  clearState(pane);
  pane.querySelector('.pr-list').innerHTML = filtered.map(prCard).join('');
}

function prCard(pr) {
  const jiraKey  = extractJiraKey(pr.title) || extractJiraKey(pr.headRefName);
  const jiraHref = jiraKey && settings.jiraUrl ? `${settings.jiraUrl}/browse/${jiraKey}` : null;
  const jiraBadge = jiraKey
    ? jiraHref
      ? `<a class="badge badge-jira" href="${jiraHref}" target="_blank">${esc(jiraKey)}</a>`
      : `<span class="badge badge-jira">${esc(jiraKey)}</span>`
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="repo-name">${esc(pr.repo)}</span>
        <a class="pr-number" href="${esc(pr.url)}" target="_blank">#${pr.number}</a>
      </div>
      <div class="card-title">
        <a class="pr-title" href="${esc(pr.url)}" target="_blank">${esc(pr.title)}</a>
      </div>
      <div class="card-badges">
        ${pr.isDraft ? '<span class="badge badge-draft">Draft</span>' : '<span class="badge badge-open">Open</span>'}
        ${jiraBadge}
        ${ciBadge(pr.statusCheckRollup?.state)}
        ${reviewBadge(pr.reviewDecision)}
      </div>
      <div class="card-meta">
        <span>@${esc(pr.author?.login ?? 'unknown')}</span>
        <span>${timeAgo(pr.updatedAt)}</span>
      </div>
    </div>`;
}

function reviewBadge(decision) {
  if (!decision) return '<span class="badge badge-warn">No reviews</span>';
  return {
    APPROVED:           '<span class="badge badge-ok">✓ Approved</span>',
    CHANGES_REQUESTED:  '<span class="badge badge-bad">✗ Changes requested</span>',
    REVIEW_REQUIRED:    '<span class="badge badge-warn">Review required</span>',
  }[decision] ?? `<span class="badge badge-warn">${esc(decision)}</span>`;
}

function ciBadge(state) {
  if (!state) return '';
  return {
    SUCCESS:  '<span class="badge badge-ok">✓ CI</span>',
    FAILURE:  '<span class="badge badge-bad">✗ CI</span>',
    ERROR:    '<span class="badge badge-bad">✗ CI</span>',
    PENDING:  '<span class="badge badge-warn">↻ CI</span>',
    EXPECTED: '<span class="badge badge-warn">↻ CI</span>',
  }[state] ?? '';
}

// ── Jira ───────────────────────────────────────────────────────────────────
async function loadJira() {
  const pane = document.getElementById('jira-pane');
  const cached = await sessionGet('jira_tickets');
  if (cached) {
    renderTickets(pane, cached.data);
    stampUpdated(cached.time);
    if (Date.now() - cached.time > STALE_MS) fetchJira(pane, true);
  } else {
    showLoading(pane);
    await fetchJira(pane, false);
  }
}

async function fetchJira(pane, silent) {
  if (!settings.jiraToken || !settings.jiraUrl || !settings.jiraEmail) {
    if (!silent) showError(pane, 'Jira not configured. <a href="#" class="open-opts">Open Settings →</a>');
    return;
  }
  if (!settings.jiraProjects?.length) {
    if (!silent) showEmpty(pane, 'No Jira projects configured. Add project keys in Settings.');
    return;
  }
  try {
    const tickets = await fetchJiraTickets(settings);
    await sessionSet('jira_tickets', tickets);
    stampUpdated(Date.now());
    renderTickets(pane, tickets);
  } catch (e) {
    if (!silent) showError(pane, `Jira error: ${e.message}`);
  }
}

async function fetchJiraTickets({ jiraUrl, jiraEmail, jiraToken, jiraProjects }) {
  const jql = `project in (${jiraProjects.join(',')}) AND statusCategory != Done ORDER BY updated DESC`;
  const fields = 'summary,status,priority,assignee,issuetype,updated';
  const url = `${jiraUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${btoa(`${jiraEmail}:${jiraToken}`)}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.issues ?? [];
}

function renderTickets(pane, tickets) {
  allTickets = tickets;
  clearState(pane);
  populateSelect(document.getElementById('assignee-filter'),
    new Set(tickets.map(t => t.fields.assignee?.displayName).filter(Boolean)), 'All assignees');
  populateSelect(document.getElementById('jira-status-filter'),
    new Set(tickets.map(t => t.fields.status?.name).filter(Boolean)), 'All statuses');
  document.getElementById('jira-filter').style.display = tickets.length ? '' : 'none';
  applyTicketFilter();
}

function applyTicketFilter() {
  const pane     = document.getElementById('jira-pane');
  const q        = document.getElementById('jira-search').value.toLowerCase();
  const assignee = document.getElementById('assignee-filter').value;
  const status   = document.getElementById('jira-status-filter').value;
  const filtered = allTickets
    .filter(t => !q        || t.fields.summary.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
    .filter(t => !assignee || t.fields.assignee?.displayName === assignee)
    .filter(t => !status   || t.fields.status?.name === status);
  if (!filtered.length) { showEmpty(pane, 'No tickets match the selected filters.'); return; }
  clearState(pane);
  pane.querySelector('.ticket-list').innerHTML = filtered.map(ticketCard).join('');
}

function ticketCard(issue) {
  const { key, fields } = issue;
  const url      = `${settings.jiraUrl}/browse/${key}`;
  const status   = fields.status?.name   ?? 'Unknown';
  const priority = fields.priority?.name ?? '';
  const assignee = fields.assignee?.displayName ?? 'Unassigned';
  const type     = fields.issuetype?.name ?? '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="issue-type">${esc(type)}</span>
        <a class="ticket-key" href="${esc(url)}" target="_blank">${esc(key)}</a>
      </div>
      <div class="card-title">
        <a class="ticket-title" href="${esc(url)}" target="_blank">${esc(fields.summary)}</a>
      </div>
      <div class="card-badges">
        ${jiraStatusBadge(status)}
        ${priority ? jiraPriorityBadge(priority) : ''}
        <span class="badge badge-meta">${esc(assignee)}</span>
      </div>
      <div class="card-meta">
        <span>${timeAgo(fields.updated)}</span>
      </div>
    </div>`;
}

function jiraStatusBadge(status) {
  const s = status.toLowerCase();
  let cls = 'badge-warn';
  if (s.includes('progress') || s.includes('review')) cls = 'badge-open';
  if (s.includes('block'))                             cls = 'badge-bad';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function jiraPriorityBadge(priority) {
  const p = priority.toLowerCase();
  let cls = 'badge-warn';
  if (p === 'highest' || p === 'critical') cls = 'badge-bad';
  else if (p === 'high')                   cls = 'badge-bad';
  else if (p === 'low' || p === 'lowest')  cls = 'badge-ok';
  return `<span class="badge ${cls}">${esc(priority)}</span>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function populateSelect(sel, valueSet, placeholder) {
  const current = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    [...valueSet].sort().map(v =>
      `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`
    ).join('');
}

function extractJiraKey(text) {
  if (!text) return null;
  const m = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function stampUpdated(time) {
  document.getElementById('last-updated').textContent =
    `Updated ${new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Session cache (persists while browser open, dies on close) ─────────────
function sessionGet(key) {
  return new Promise(resolve => chrome.storage.session.get(key, d => resolve(d[key] ?? null)));
}
function sessionSet(key, data) {
  return new Promise(resolve => chrome.storage.session.set({ [key]: { data, time: Date.now() } }, resolve));
}
function sessionDel(key) {
  return new Promise(resolve => chrome.storage.session.remove(key, resolve));
}

// ── UI state helpers ───────────────────────────────────────────────────────
function showLoading(pane) {
  pane.querySelector('.loading').style.display = '';
  pane.querySelector('.error').style.display   = 'none';
  pane.querySelector('.empty').style.display   = 'none';
  const filter = pane.querySelector('.filter-bar');
  if (filter) filter.style.display = 'none';
  const repoBar = document.getElementById('repo-tabs');
  if (repoBar) repoBar.style.display = 'none';
  const list = pane.querySelector('.pr-list, .ticket-list');
  if (list) list.innerHTML = '';
}

function clearState(pane) {
  pane.querySelector('.loading').style.display = 'none';
  pane.querySelector('.error').style.display   = 'none';
  pane.querySelector('.empty').style.display   = 'none';
}

function showError(pane, html) {
  clearState(pane);
  const el = pane.querySelector('.error');
  el.innerHTML = html;
  el.style.display = '';
  el.querySelectorAll('.open-opts').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); })
  );
}

function showEmpty(pane, text) {
  clearState(pane);
  const el = pane.querySelector('.empty');
  el.textContent = text;
  el.style.display = '';
}

// ── Storage ────────────────────────────────────────────────────────────────
function loadSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(
      ['githubToken', 'repos', 'jiraUrl', 'jiraEmail', 'jiraToken', 'jiraProjects'],
      resolve
    )
  );
}
