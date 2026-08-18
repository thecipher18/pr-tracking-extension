'use strict';

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const ALARM = 'pr-jira-refresh';
const INTERVAL_MINUTES = 30;

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: INTERVAL_MINUTES });
  doFetch();
});

chrome.runtime.onStartup.addListener(doFetch);

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) doFetch();
});

async function doFetch() {
  const s = await loadSettings();

  if (s.githubToken && s.repos?.length) {
    try {
      const { prs } = await fetchAllPRs(s.repos, s.githubToken);
      await sessionSet('gh_prs', prs);
    } catch (e) {
      console.warn('Background GitHub fetch:', e.message);
    }
  }

  if (s.jiraToken && s.jiraUrl && s.jiraEmail && s.jiraProjects?.length) {
    try {
      const tickets = await fetchJiraTickets(s);
      await sessionSet('jira_tickets', tickets);
    } catch (e) {
      console.warn('Background Jira fetch:', e.message);
    }
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
  results.forEach((r, i) => {
    if (r.status === 'fulfilled')
      prs.push(...r.value.nodes.map(pr => ({ ...pr, repo: repos[i] })));
  });
  return { prs: prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) };
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
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  const pr = data.data?.repository?.pullRequests;
  return { nodes: pr?.nodes ?? [], pageInfo: pr?.pageInfo ?? { hasNextPage: false } };
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
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  return data.issues ?? [];
}

function sessionSet(key, data) {
  return new Promise(resolve =>
    chrome.storage.session.set({ [key]: { data, time: Date.now() } }, resolve)
  );
}

function loadSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(
      ['githubToken', 'repos', 'jiraUrl', 'jiraEmail', 'jiraToken', 'jiraProjects'],
      resolve
    )
  );
}
