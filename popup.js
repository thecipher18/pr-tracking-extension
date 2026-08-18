'use strict';

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

let settings = {};
let currentTab = 'github';
// ponytail: in-memory cache cleared on refresh; no persistence needed for a popup
const cache = {};

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  settings = await loadSettings();
  initTabs();
  document.getElementById('refresh-btn').addEventListener('click', refresh);
  document.getElementById('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
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

function refresh() {
  delete cache[currentTab];
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  loadTab(currentTab).finally(() => btn.classList.remove('spinning'));
}

function loadTab(name) {
  return name === 'github' ? loadGitHub() : loadJira();
}

// ── GitHub ─────────────────────────────────────────────────────────────────
async function loadGitHub() {
  const pane = document.getElementById('github-pane');

  if (cache.github) { renderPRs(pane, cache.github); return; }

  showLoading(pane);

  if (!settings.githubToken) {
    return showError(pane, 'No GitHub token. <a href="#" class="open-opts">Open Settings →</a>');
  }
  if (!settings.repos?.length) {
    return showEmpty(pane, 'No repos configured. Add them in Settings.');
  }

  try {
    const prs = await fetchAllPRs(settings.repos, settings.githubToken);
    cache.github = prs;
    stampUpdated();
    renderPRs(pane, prs);
  } catch (e) {
    showError(pane, `GitHub error: ${e.message}`);
  }
}

async function fetchAllPRs(repos, token) {
  const results = await Promise.allSettled(
    repos.map(repo => {
      const [owner, name] = repo.split('/');
      return fetchRepoPRs(owner, name, token);
    })
  );
  const prs = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') prs.push(...r.value);
    else console.warn(`fetchRepoPRs(${repos[i]}):`, r.reason.message);
  });
  return prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function fetchRepoPRs(owner, name, token) {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: [OPEN], first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number title url isDraft headRefName
            reviewDecision createdAt updatedAt
            author { login }
            statusCheckRollup { state }
          }
        }
      }
    }
  `;
  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return (data.data?.repository?.pullRequests?.nodes ?? [])
    .map(pr => ({ ...pr, repo: `${owner}/${name}` }));
}

function renderPRs(pane, prs) {
  clearState(pane);
  if (!prs.length) return showEmpty(pane, 'No open PRs found.');
  pane.querySelector('.pr-list').innerHTML = prs.map(prCard).join('');
  pane.querySelectorAll('.open-opts').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); })
  );
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
        ${reviewBadge(pr.reviewDecision)}
        ${ciBadge(pr.statusCheckRollup?.state)}
        ${jiraBadge}
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

  if (cache.jira) { renderTickets(pane, cache.jira); return; }

  showLoading(pane);

  if (!settings.jiraToken || !settings.jiraUrl || !settings.jiraEmail) {
    return showError(pane, 'Jira not configured. <a href="#" class="open-opts">Open Settings →</a>');
  }
  if (!settings.jiraProjects?.length) {
    return showEmpty(pane, 'No Jira projects configured. Add project keys in Settings.');
  }

  try {
    const tickets = await fetchJiraTickets(settings);
    cache.jira = tickets;
    stampUpdated();
    renderTickets(pane, tickets);
  } catch (e) {
    showError(pane, `Jira error: ${e.message}`);
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
  clearState(pane);
  if (!tickets.length) return showEmpty(pane, 'No active tickets found.');
  pane.querySelector('.ticket-list').innerHTML = tickets.map(ticketCard).join('');
  pane.querySelectorAll('.open-opts').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); })
  );
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

function stampUpdated() {
  document.getElementById('last-updated').textContent =
    `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ── UI state helpers ───────────────────────────────────────────────────────
function showLoading(pane) {
  pane.querySelector('.loading').style.display = '';
  pane.querySelector('.error').style.display   = 'none';
  pane.querySelector('.empty').style.display   = 'none';
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
