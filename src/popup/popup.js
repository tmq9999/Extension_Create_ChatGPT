/**
 * popup.js — Logic điều khiển popup UI
 * v3.1: Redesigned UI + OTP timing settings + collapsible sections
 */

import {
  getAccounts, getSettings, saveSettings, deleteAccount, clearAccounts,
  getStats, accountsToCsv, accountsToTxt,
} from '../shared/storage.js';

// ── State ─────────────────────────────────────────────────────────────
let allAccounts = [];
let filteredAccounts = [];
let isRunning = false;

// ── Init ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshDashboard();
  setupTabs();
  setupCollapsibleSections();
  setupEventListeners();
  setupMessageListener();
  await loadLogs();
  await syncStatus();
});

// ── Load logs từ storage (persist khi popup đóng/mở) ────────────────
async function loadLogs() {
  try {
    const { logs = [] } = await chrome.storage.local.get('logs');
    const box = document.getElementById('logBox');
    if (!box || logs.length === 0) return;
    for (const entry of logs) {
      const div = document.createElement('div');
      div.className = `log-entry ${entry.level || ''}`;
      div.textContent = `[${entry.time}] ${entry.text}`;
      box.appendChild(div);
    }
    if (document.getElementById('autoScroll')?.checked) {
      box.scrollTop = box.scrollHeight;
    }
  } catch (_) {}
}

// ── Tab switching ─────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// ── Collapsible sections in Settings ─────────────────────────────────
function setupCollapsibleSections() {
  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const sectionName = header.dataset.section;
      const body = document.getElementById(`section-${sectionName}`);
      if (!body) return;

      const isOpen = header.classList.contains('open');
      if (isOpen) {
        header.classList.remove('open');
        body.classList.remove('open');
      } else {
        header.classList.add('open');
        body.classList.add('open');
      }
    });
  });
}

// ── Event listeners ───────────────────────────────────────────────────
function setupEventListeners() {
  // Search
  document.getElementById('searchInput').addEventListener('input', (e) => {
    filterAccounts(e.target.value);
  });

  // Export
  document.getElementById('btnExportCsv').addEventListener('click', exportCsv);
  document.getElementById('btnExportTxt').addEventListener('click', exportTxt);
  document.getElementById('btnClearAll').addEventListener('click', confirmClearAll);

  // Select all
  document.getElementById('selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.row-check').forEach(cb => cb.checked = e.target.checked);
  });

  // Email provider toggle
  document.getElementById('emailProvider').addEventListener('change', (e) => {
    toggleProviderSections(e.target.value);
  });

  // Proxy toggle
  document.getElementById('useProxy').addEventListener('change', (e) => {
    document.getElementById('proxySection').style.display =
      e.target.checked ? 'flex' : 'none';
  });

  // Start / Stop
  document.getElementById('btnStart').addEventListener('click', startRegistration);
  document.getElementById('btnStop').addEventListener('click', stopRegistration);

  // Trial Plus
  document.getElementById('btnTrialPlus').addEventListener('click', startTrialPlus);

  // Settings save
  document.getElementById('btnSaveSettings').addEventListener('click', saveCurrentSettings);

  // Log clear
  document.getElementById('btnClearLog').addEventListener('click', () => {
    document.getElementById('logBox').innerHTML = '';
    chrome.storage.local.set({ logs: [] }).catch(() => {});
  });
}

/**
 * Toggle hiển thị section phù hợp với provider đã chọn
 */
function toggleProviderSections(provider) {
  const hotmailSection = document.getElementById('hotmailSection');
  const dongvanMailSection = document.getElementById('dongvanMailSection');

  hotmailSection.style.display = 'none';
  dongvanMailSection.style.display = 'none';

  if (provider === 'hotmail_dongvan') {
    hotmailSection.style.display = 'flex';
  } else if (provider === 'dongvan_maildomain') {
    dongvanMailSection.style.display = 'flex';
  }
}

// ── Message listener (nhận update từ background) ──────────────────────
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATUS_UPDATE') {
      updateStatus(msg.state);
      if (msg.log) addLog(msg.log);
      if (msg.newAccount) {
        allAccounts.unshift(msg.newAccount);
        filterAccounts(document.getElementById('searchInput').value);
        updateStats();
      }
    }
  });
}

// ── Sync status with background ───────────────────────────────────────
async function syncStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (res?.success) updateStatus(res.state);
  } catch (_) {}
}

function updateStatus(state) {
  if (!state) return;
  isRunning = state.isRunning;

  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const startBtn = document.getElementById('btnStart');
  const stopBtn = document.getElementById('btnStop');

  if (state.isRunning) {
    dot.className = 'status-dot running';
    text.textContent = `Running (${state.activeJobs || 0} threads)`;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    const section = document.getElementById('progressSection');
    section.style.display = 'block';
    const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
    document.getElementById('progressBar').style.width = `${pct}%`;
    document.getElementById('progressText').textContent = `${state.completed} / ${state.total}`;
    document.getElementById('progressPercent').textContent = `${pct}%`;
  } else {
    dot.className = 'status-dot';
    text.textContent = 'Ready';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────
async function refreshDashboard() {
  allAccounts = await getAccounts();
  allAccounts.reverse();
  filterAccounts('');
  await updateStats();
}

function filterAccounts(query) {
  const q = query.toLowerCase().trim();
  filteredAccounts = q
    ? allAccounts.filter(a =>
        a.email?.toLowerCase().includes(q) ||
        a.status?.toLowerCase().includes(q)
      )
    : [...allAccounts];
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('accountTableBody');
  if (!filteredAccounts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No accounts yet</td></tr>';
    return;
  }

  tbody.innerHTML = filteredAccounts.map(acc => {
    const statusBadge = acc.status === 'success'
      ? '<span class="badge badge-success">OK</span>'
      : '<span class="badge badge-error">Fail</span>';
    const trialBadge = acc.hasTrialPlus
      ? '<span class="badge badge-plus">Plus</span>'
      : '<span style="color:var(--text-muted)">—</span>';
    const email = escHtml(acc.email || '');
    const pass = escHtml(acc.chatgptPassword || '');

    return `<tr>
      <td><input type="checkbox" class="row-check" data-id="${acc.id}"></td>
      <td title="${email}">${email}</td>
      <td>
        <span class="pass-masked">••••••</span>
        <button class="copy-btn" data-copy="${pass}" title="Copy password">📋</button>
      </td>
      <td>${statusBadge}</td>
      <td>${trialBadge}</td>
      <td>
        <button class="copy-btn" data-copy="${email}" title="Copy email">📧</button>
        <button class="copy-btn delete-btn" data-id="${acc.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join('');

  // Event listeners cho copy và delete
  tbody.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
      const original = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => btn.textContent = original, 1000);
    });
  });

  tbody.querySelectorAll('.delete-btn[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteAccount(btn.dataset.id);
      allAccounts = allAccounts.filter(a => a.id !== btn.dataset.id);
      filterAccounts(document.getElementById('searchInput').value);
      await updateStats();
    });
  });
}

async function updateStats() {
  const stats = await getStats();
  document.getElementById('statTotal').textContent = stats.total || allAccounts.length;
  document.getElementById('statSuccess').textContent = stats.success || allAccounts.filter(a => a.status === 'success').length;
  document.getElementById('statFailed').textContent = stats.failed || allAccounts.filter(a => a.status !== 'success').length;
  document.getElementById('statPlus').textContent = stats.trialPlus || allAccounts.filter(a => a.hasTrialPlus).length;
}

// ── Export ────────────────────────────────────────────────────────────
function exportCsv() {
  if (!allAccounts.length) { alert('No accounts to export!'); return; }
  const csv = accountsToCsv(allAccounts);
  downloadFile(csv, `chatgpt_accounts_${dateStr()}.csv`, 'text/csv');
}

function exportTxt() {
  if (!allAccounts.length) { alert('No accounts to export!'); return; }
  const txt = accountsToTxt(allAccounts);
  downloadFile(txt, `chatgpt_accounts_${dateStr()}.txt`, 'text/plain');
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function confirmClearAll() {
  if (confirm('Delete ALL accounts? This cannot be undone!')) {
    await clearAccounts();
    allAccounts = [];
    filterAccounts('');
    await updateStats();
  }
}

// ── Registration ──────────────────────────────────────────────────────
async function startRegistration() {
  const count = parseInt(document.getElementById('numAccounts').value) || 1;
  const threads = parseInt(document.getElementById('numThreads').value) || 2;
  const emailProvider = document.getElementById('emailProvider').value;
  const useProxy = document.getElementById('useProxy').checked;
  const countryCode = document.getElementById('countryCode').value;

  const settings = {
    emailProvider,
    numThreads: threads,
    useProxy,
    countryCode,
  };

  if (emailProvider === 'hotmail_dongvan') {
    const lines = document.getElementById('hotmailInput').value.trim().split('\n').filter(Boolean);
    if (!lines.length) { alert('Please enter Hotmail list!'); return; }
    settings.hotmailFile = lines.map(line => {
      const parts = line.split('|');
      return { email: parts[0], password: parts[1], refreshToken: parts[2] || '', clientId: parts[3] || '' };
    });
    settings.hotmailApiKey = document.getElementById('hotmailApiKey').value.trim();
  } else if (emailProvider === 'dongvan_maildomain') {
    const apiKey = document.getElementById('dongvanApiKey').value.trim();
    if (!apiKey) { alert('Please enter DongVanFB API Key!'); return; }
    settings.dongvanApiKey = apiKey;
    settings.dongvanMailType = document.getElementById('dongvanMailType').value;
  }

  if (useProxy) {
    const proxyLines = document.getElementById('proxyInput').value.trim().split('\n').filter(Boolean);
    settings.proxyList = proxyLines;
  }

  await saveSettings(settings);

  let originTabId = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) originTabId = activeTab.id;
  } catch (_) {}

  try {
    const res = await chrome.runtime.sendMessage({ type: 'START_REG', count, originTabId });
    if (!res?.success) {
      alert('Error: ' + (res?.error || 'Unknown'));
      return;
    }
  } catch (e) {
    alert('Cannot connect to background: ' + e.message);
    return;
  }

  const providerLabel = {
    mailtm: 'mail.tm',
    hotmail_dongvan: 'Hotmail DV',
    dongvan_maildomain: 'DongVanFB Mail',
  }[emailProvider] || emailProvider;

  addLog(`=== START: ${count} accounts | ${threads} threads ===`, 'info');
  addLog(`Email: ${providerLabel} | Proxy: ${useProxy ? 'Yes' : 'No'}`, 'info');

  // Switch to log tab
  document.querySelector('[data-tab="log"]').click();
}

async function stopRegistration() {
  await chrome.runtime.sendMessage({ type: 'STOP_REG' });
  addLog('=== STOPPED ===', 'warning');
}

// ── Settings ──────────────────────────────────────────────────────────
async function loadSettings() {
  const settings = await getSettings();
  document.getElementById('numThreads').value = settings.numThreads || 2;
  document.getElementById('emailProvider').value = settings.emailProvider || 'mailtm';
  document.getElementById('countryCode').value = settings.countryCode || 'US';
  document.getElementById('useProxy').checked = settings.useProxy || false;
  document.getElementById('delayMin').value = settings.delayMin || 2000;
  document.getElementById('delayMax').value = settings.delayMax || 5000;

  if (settings.proxyList?.length) {
    document.getElementById('proxyInput').value = settings.proxyList.join('\n');
  }
  if (settings.hotmailFile?.length) {
    document.getElementById('hotmailInput').value = settings.hotmailFile
      .map(h => `${h.email}|${h.password}|${h.refreshToken}|${h.clientId}`)
      .join('\n');
  }
  if (settings.trialBinList?.length) {
    document.getElementById('binList').value = settings.trialBinList.join('\n');
  }
  if (settings.hotmailApiKey) {
    document.getElementById('hotmailApiKey').value = settings.hotmailApiKey;
  }
  if (settings.dongvanApiKey) {
    document.getElementById('dongvanApiKey').value = settings.dongvanApiKey;
  }
  if (settings.dongvanMailType) {
    document.getElementById('dongvanMailType').value = settings.dongvanMailType;
  }
  if (settings.captchaService) {
    document.getElementById('captchaService').value = settings.captchaService;
  }
  if (settings.captchaApiKey) {
    document.getElementById('captchaApiKey').value = settings.captchaApiKey;
  }
  if (settings.trialMaxRetry) {
    document.getElementById('trialMaxRetry').value = settings.trialMaxRetry;
  }

  // OTP Timing
  document.getElementById('otpInitialWait').value = settings.otpInitialWait || 3000;
  document.getElementById('otpPollInterval').value = settings.otpPollInterval || 2500;
  document.getElementById('otpResendWait').value = settings.otpResendWait || 5000;
  document.getElementById('otpMaxPolls').value = settings.otpMaxPolls || 30;
  document.getElementById('otpPollsBeforeResend').value = settings.otpPollsBeforeResend || 8;

  // Toggle visibility
  toggleProviderSections(settings.emailProvider || 'mailtm');
  if (settings.useProxy) {
    document.getElementById('proxySection').style.display = 'flex';
  }
}

async function saveCurrentSettings() {
  const settings = {
    numThreads: parseInt(document.getElementById('numThreads').value) || 2,
    delayMin: parseInt(document.getElementById('delayMin').value) || 2000,
    delayMax: parseInt(document.getElementById('delayMax').value) || 5000,
    trialBinList: document.getElementById('binList').value.trim().split('\n').filter(Boolean),
    captchaService: document.getElementById('captchaService').value || 'none',
    captchaApiKey: document.getElementById('captchaApiKey').value.trim(),
    trialMaxRetry: parseInt(document.getElementById('trialMaxRetry').value) || 10,
    // OTP Timing
    otpInitialWait: parseInt(document.getElementById('otpInitialWait').value) || 3000,
    otpPollInterval: parseInt(document.getElementById('otpPollInterval').value) || 2500,
    otpResendWait: parseInt(document.getElementById('otpResendWait').value) || 5000,
    otpMaxPolls: parseInt(document.getElementById('otpMaxPolls').value) || 30,
    otpPollsBeforeResend: parseInt(document.getElementById('otpPollsBeforeResend').value) || 8,
  };
  await saveSettings(settings);

  const msg = document.getElementById('saveMsg');
  msg.style.display = 'block';
  msg.textContent = 'Settings saved!';
  setTimeout(() => msg.style.display = 'none', 2000);
}

// ── Log ───────────────────────────────────────────────────────────────
function addLog(text, level = '') {
  const box = document.getElementById('logBox');
  const div = document.createElement('div');
  div.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString('vi-VN');
  div.textContent = `[${time}] ${text}`;
  box.appendChild(div);

  if (document.getElementById('autoScroll').checked) {
    box.scrollTop = box.scrollHeight;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function escHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return str.replace(/[&<>"]/g, c => map[c]);
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Trial Plus ───────────────────────────────────────────────────────
async function startTrialPlus() {
  const btn = document.getElementById('btnTrialPlus');
  const statusDiv = document.getElementById('trialStatus');
  const statusText = document.getElementById('trialStatusText');
  const countryCode = document.getElementById('countryCode').value;
  const planType = document.getElementById('trialPlanType').value;

  btn.disabled = true;
  btn.classList.add('running');
  btn.textContent = 'Running Trial Plus...';

  statusDiv.style.display = 'block';
  statusDiv.className = 'trial-status running';
  statusText.textContent = `Activating Trial ${planType === 'business' ? 'Business' : 'Plus'} (${countryCode})...`;

  addLog(`[Trial] Starting Trial ${planType === 'business' ? 'Business' : 'Plus'} — ${countryCode}`, 'info');

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'START_TRIAL',
      countryCode,
      planType,
    });

    if (!res?.success) {
      throw new Error(res?.error || 'Cannot start Trial');
    }

    addLog('[Trial] Command sent to active tab', 'info');
    statusText.textContent = 'Trial Plus running on active tab...';

  } catch (e) {
    addLog(`[Trial] Error: ${e.message}`, 'error');
    statusDiv.className = 'trial-status error';
    statusText.textContent = `Error: ${e.message}`;
    btn.disabled = false;
    btn.classList.remove('running');
    btn.textContent = 'Start Trial Plus';
  }
}
