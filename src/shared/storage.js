/**
 * storage.js — Quản lý dữ liệu lưu trữ của extension
 * Dùng chrome.storage.local cho tất cả dữ liệu
 * v3.1.0: Thêm OTP timing settings
 */

const KEYS = {
  ACCOUNTS: 'accounts',
  SETTINGS: 'settings',
  HOTMAIL_LIST: 'hotmail_list',
  PROXY_LIST: 'proxy_list',
  QUEUE: 'reg_queue',
  STATS: 'stats',
};

// ── Settings mặc định ────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  // Email provider
  emailProvider: 'mailtm',       // 'mailtm' | 'hotmail_dongvan' | 'dongvan_maildomain'
  hotmailApiKey: '',
  hotmailFile: [],               // [{email, password, refreshToken, clientId}]

  // DongVanFB Mail Domain (mail tạm)
  dongvanApiKey: '',             // API key cho dongvanfb.net (dùng chung hotmailApiKey nếu trống)
  dongvanMailType: 'dropmail',   // 'dropmail' | 'mailtm' | '10minutemail'

  // Proxy
  useProxy: false,
  proxyList: [],                 // ['http://ip:port', 'socks5://ip:port:user:pass', ...]
  proxyMode: 'roundrobin',       // 'roundrobin' | 'random'

  // Registration
  numThreads: 2,
  autoTrialPlus: false,
  countryCode: 'US',
  delayMin: 2000,
  delayMax: 5000,

  // Trial Plus
  // FIX v1.3.1: Dùng BIN 6 chữ số — generateCardFromBin() sẽ tự gen số thẻ đầy đủ + Luhn check digit
  trialBinList: [
    '411111',
    '550000',
    '378282',
    '625814',
  ],

  // Captcha bypass
  captchaService: 'none',
  captchaApiKey: '',

  // Retry
  trialMaxRetry: 10,

  // OTP Timing (v3.1.0)
  otpInitialWait: 3000,       // Chờ ban đầu trước khi poll OTP lần đầu (ms)
  otpPollInterval: 2500,      // Khoảng cách giữa các lần poll (ms)
  otpResendWait: 5000,        // Chờ sau khi click Gửi lại email (ms)
  otpMaxPolls: 30,            // Số lần poll tối đa mỗi attempt
  otpPollsBeforeResend: 8,    // Số lần poll trước khi tự động resend
};

// ── Accounts ─────────────────────────────────────────────────────────

export async function getAccounts() {
  const data = await chrome.storage.local.get(KEYS.ACCOUNTS);
  return data[KEYS.ACCOUNTS] || [];
}

export async function saveAccount(account) {
  const accounts = await getAccounts();
  const existing = accounts.findIndex(a => a.email === account.email);
  if (existing >= 0) {
    accounts[existing] = { ...accounts[existing], ...account };
  } else {
    accounts.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      createdAt: new Date().toISOString(),
      ...account,
    });
  }
  await chrome.storage.local.set({ [KEYS.ACCOUNTS]: accounts });
  return accounts;
}

export async function deleteAccount(id) {
  const accounts = await getAccounts();
  const filtered = accounts.filter(a => a.id !== id);
  await chrome.storage.local.set({ [KEYS.ACCOUNTS]: filtered });
  return filtered;
}

export async function clearAccounts() {
  await chrome.storage.local.set({ [KEYS.ACCOUNTS]: [] });
}

// ── Settings ─────────────────────────────────────────────────────────

export async function getSettings() {
  const data = await chrome.storage.local.get(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(data[KEYS.SETTINGS] || {}) };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const merged = { ...current, ...settings };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: merged });
  return merged;
}

// ── Queue ─────────────────────────────────────────────────────────────

export async function getQueue() {
  const data = await chrome.storage.local.get(KEYS.QUEUE);
  return data[KEYS.QUEUE] || [];
}

export async function setQueue(queue) {
  await chrome.storage.local.set({ [KEYS.QUEUE]: queue });
}

export async function addToQueue(task) {
  const queue = await getQueue();
  queue.push({ id: Date.now(), ...task, status: 'pending' });
  await setQueue(queue);
}

export async function updateQueueItem(id, updates) {
  const queue = await getQueue();
  const idx = queue.findIndex(t => t.id === id);
  if (idx >= 0) {
    queue[idx] = { ...queue[idx], ...updates };
    await setQueue(queue);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────

export async function getStats() {
  const data = await chrome.storage.local.get(KEYS.STATS);
  return data[KEYS.STATS] || { total: 0, success: 0, failed: 0, trialPlus: 0 };
}

export async function incrementStat(key) {
  const stats = await getStats();
  stats[key] = (stats[key] || 0) + 1;
  stats.total = stats.success + stats.failed;
  await chrome.storage.local.set({ [KEYS.STATS]: stats });
  return stats;
}

// ── Export helpers ────────────────────────────────────────────────────

export function accountsToCsv(accounts) {
  const headers = ['Email', 'Mật khẩu ChatGPT', 'Trạng thái', 'Trial+', 'Hotmail Pass', 'Ngày tạo', 'Ghi chú'];
  const rows = accounts.map(a => [
    a.email || '',
    a.chatgptPassword || '',
    a.status || '',
    a.hasTrialPlus ? 'Yes' : 'No',
    a.hotmailPassword || '',
    a.createdAt ? new Date(a.createdAt).toLocaleString('vi-VN') : '',
    a.notes || '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function accountsToTxt(accounts) {
  return accounts
    .filter(a => a.status === 'success')
    .map(a => `${a.email}|${a.chatgptPassword}${a.hasTrialPlus ? '|TRIAL_PLUS' : ''}`)
    .join('\n');
}
