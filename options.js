'use strict';

const KEYS = ['githubToken', 'repos', 'jiraUrl', 'jiraEmail', 'jiraToken', 'jiraProjects'];

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(KEYS, data => {
    if (data.githubToken)   document.getElementById('github-token').value  = data.githubToken;
    if (data.repos)         document.getElementById('repos').value         = data.repos.join('\n');
    if (data.jiraUrl)       document.getElementById('jira-url').value      = data.jiraUrl;
    if (data.jiraEmail)     document.getElementById('jira-email').value    = data.jiraEmail;
    if (data.jiraToken)     document.getElementById('jira-token').value    = data.jiraToken;
    if (data.jiraProjects)  document.getElementById('jira-projects').value = data.jiraProjects.join(', ');
  });

  document.getElementById('save-btn').addEventListener('click', save);
});

function save() {
  const repos = document.getElementById('repos').value
    .split('\n')
    .map(r => r.trim())
    .filter(r => r.includes('/'));

  const jiraProjects = document.getElementById('jira-projects').value
    .split(',')
    .map(p => p.trim().toUpperCase())
    .filter(Boolean);

  const settings = {
    githubToken:   document.getElementById('github-token').value.trim(),
    repos,
    jiraUrl:       document.getElementById('jira-url').value.trim().replace(/\/$/, ''),
    jiraEmail:     document.getElementById('jira-email').value.trim(),
    jiraToken:     document.getElementById('jira-token').value.trim(),
    jiraProjects,
  };

  chrome.storage.sync.set(settings, () => {
    const msg = document.getElementById('save-msg');
    msg.textContent = 'Saved!';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  });
}
