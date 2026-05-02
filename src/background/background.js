/**
 * background.js — Service Worker chính của extension
 * Điều phối: dùng tab hiện tại, giao task cho content script, nhận kết quả, lưu tài khoản
 *
 * v3.1 Changes:
 * - Truyền OTP timing settings từ storage vào jobInfo cho content script
 *
 * v3.0 Changes:
 * - Tích hợp 3 email provider: MailTm, HotmailDongVan (viết lại), DongVanMailDomain (mới)
 * - HotmailDongVanProvider giờ dùng getDongVanFB_OTP() mới với retry + fallback
 * - DongVanMailDomainProvider hỗ trợ tạo mail tạm qua dongvanfb.net
 * - handleGetOtp() hỗ trợ cả 3 provider
 * - spawnNextJob() hỗ trợ cả 3 provider
 *
 * v1.3.1 Fixes (giữ nguyên):
 * - Fix race condition trong waitForTabComplete()
 * - Tăng retry limit từ 10 lên 15 cho handleStartTrial
 */

import { getSettings, saveAccount, incrementStat, getQueue, setQueue } from '../shared/storage.js';
import { MailTmProvider, HotmailDongVanProvider, DongVanMailDomainProvider } from '../shared/email_providers.js';
import { generatePassword, generateName, generateBirthday, sleep, randomDelay, parseProxy } from '../shared/utils.js';

// ── State ─────────────────────────────────────────────────────────────

const state = {
  isRunning: false,
  activeJobs: new Map(),   // tabId → jobInfo
  queue: [],
  completedCount: 0,
  successCount: 0,
  failedCount: 0,
  totalCount: 0,
  proxyIndex: 0,
  hotmailProvider: null,       // HotmailDongVanProvider instance
  dongvanMailProvider: null,    // DongVanMailDomainProvider instance (mới)
  settings: null,
  originTabId: null,
};

// ── Message handler ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START_REG':
          await handleStartReg(msg, sendResponse);
          break;
        case 'STOP_REG':
          handleStopReg(sendResponse);
          break;
        case 'GET_STATUS':
          sendResponse({ success: true, state: getPublicState() });
          break;
        case 'REG_STEP_DONE':
          await handleStepDone(msg, sender.tab?.id, sendResponse);
          break;
        case 'REG_COMPLETE':
          await handleRegComplete(msg, sender.tab?.id, sendResponse);
          break;
        case 'REG_ERROR':
          await handleRegError(msg, sender.tab?.id, sendResponse);
          break;
        case 'GET_OTP':
          await handleGetOtp(msg, sender.tab?.id, sendResponse);
          break;
        case 'GET_JOB':
          handleGetJob(sender.tab?.id, sendResponse);
          break;
        case 'START_TRIAL':
          await handleStartTrial(msg, sender, sendResponse);
          break;
        case 'FILL_STRIPE_FIELD':
          await handleFillStripeField(msg, sender.tab?.id, sendResponse);
          break;
        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (e) {
      console.error('[BG] Error handling message:', e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

// ── Start Registration ────────────────────────────────────────────────

async function handleStartReg(msg, sendResponse) {
  if (state.isRunning) {
    sendResponse({ success: false, error: 'Đang chạy rồi' });
    return;
  }

  const settings = await getSettings();
  state.settings = settings;
  state.isRunning = true;
  state.completedCount = 0;
  state.successCount = 0;
  state.failedCount = 0;
  state.totalCount = msg.count || 1;
  state.proxyIndex = 0;
  state.originTabId = msg.originTabId || null;

  // ── Khởi tạo provider dựa trên emailProvider setting ──
  state.hotmailProvider = null;
  state.dongvanMailProvider = null;

  if (settings.emailProvider === 'hotmail_dongvan') {
    // Mode hotmail: dùng HotmailDongVanProvider (đã viết lại với getDongVanFB_OTP)
    state.hotmailProvider = new HotmailDongVanProvider(
      settings.hotmailFile || [],
      settings.hotmailApiKey || ''
    );
    console.log(`[BG] Khởi tạo HotmailDongVanProvider: ${(settings.hotmailFile || []).length} accounts`);

  } else if (settings.emailProvider === 'dongvan_maildomain') {
    // Mode mail tạm DongVanFB: dùng DongVanMailDomainProvider (mới)
    state.dongvanMailProvider = new DongVanMailDomainProvider(
      settings.dongvanApiKey || settings.hotmailApiKey || '',
      settings.dongvanMailType || 'dropmail'
    );
    console.log(`[BG] Khởi tạo DongVanMailDomainProvider: type=${settings.dongvanMailType || 'dropmail'}`);
  }
  // Nếu emailProvider === 'mailtm' → không cần khởi tạo gì, tạo per-job

  state.queue = Array.from({ length: state.totalCount }, (_, i) => ({
    index: i,
    status: 'pending',
  }));

  sendResponse({ success: true });

  const threads = Math.min(settings.numThreads || 2, state.totalCount);
  for (let t = 0; t < threads; t++) {
    await sleep(t * 800);
    spawnNextJob(t === 0);
  }
}

// ── Stop Registration ─────────────────────────────────────────────────

function handleStopReg(sendResponse) {
  state.isRunning = false;
  state.queue = [];
  for (const [tabId] of state.activeJobs) {
    if (tabId !== state.originTabId) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
  state.activeJobs.clear();
  sendResponse({ success: true });
  broadcastStatus();
}

// ── Spawn next job ────────────────────────────────────────────────────

async function spawnNextJob(useCurrentTab = false) {
  if (!state.isRunning) return;

  const pending = state.queue.find(j => j.status === 'pending');
  if (!pending) return;

  pending.status = 'running';

  try {
    const { firstName, lastName } = generateName();
    const { year, month, day } = generateBirthday();
    const password = generatePassword();

    let emailData;
    const provider = state.settings.emailProvider;

    if (provider === 'hotmail_dongvan' && state.hotmailProvider) {
      // ── Hotmail DongVan ──
      emailData = await state.hotmailProvider.createEmail();

    } else if (provider === 'dongvan_maildomain' && state.dongvanMailProvider) {
      // ── DongVan Mail Domain (mới) ──
      // Mỗi job cần 1 email riêng → tạo instance mới
      const dvProvider = new DongVanMailDomainProvider(
        state.settings.dongvanApiKey || state.settings.hotmailApiKey || '',
        state.settings.dongvanMailType || 'dropmail'
      );
      emailData = await dvProvider.createEmail();
      pending._mailProvider = dvProvider;

    } else {
      // ── MailTm (mặc định) ──
      const mtProvider = new MailTmProvider();
      emailData = await mtProvider.createEmail();
      pending._mailProvider = mtProvider;
    }

    let proxy = null;
    if (state.settings.useProxy && state.settings.proxyList?.length) {
      const list = state.settings.proxyList;
      proxy = list[state.proxyIndex % list.length];
      state.proxyIndex++;
    }

    const jobInfo = {
      index: pending.index,
      email: emailData.email,
      emailPassword: emailData.password,
      chatgptPassword: password,
      firstName,
      lastName,
      birthYear: year,
      birthMonth: month,
      birthDay: day,
      proxy,
      provider: state.settings.emailProvider,
      _hotmailAcc: emailData._hotmailAcc || null,
      _mailProvider: pending._mailProvider || null,
      autoTrialPlus: false,
      countryCode: state.settings.countryCode || 'US',
      startTime: Date.now(),
      // OTP Timing (v3.1.0) — truyền từ settings sang content script
      otpInitialWait: state.settings.otpInitialWait,
      otpPollInterval: state.settings.otpPollInterval,
      otpResendWait: state.settings.otpResendWait,
      otpMaxPolls: state.settings.otpMaxPolls,
      otpPollsBeforeResend: state.settings.otpPollsBeforeResend,
    };

    let tab;

    if (useCurrentTab && state.originTabId) {
      try {
        await chrome.tabs.update(state.originTabId, { url: 'https://chatgpt.com/' });
        tab = await chrome.tabs.get(state.originTabId);
      } catch (e) {
        console.warn('[BG] Tab gốc không tồn tại, mở tab mới');
        tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
      }
    } else {
      tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
    }

    state.activeJobs.set(tab.id, jobInfo);
    pending.tabId = tab.id;
    pending.status = 'running';

    console.log(`[BG] Job #${pending.index + 1} started → tab ${tab.id}, email: ${emailData.email}, provider: ${state.settings.emailProvider}`);
    broadcastStatus();

  } catch (e) {
    console.error(`[BG] spawnNextJob error:`, e);
    pending.status = 'failed';
    state.failedCount++;
    state.completedCount++;
    await incrementStat('failed');

    if (state.completedCount >= state.totalCount) {
      state.isRunning = false;
    } else {
      spawnNextJob(false);
    }
    broadcastStatus();
  }
}

// ── Handle step done ──────────────────────────────────────────────────

async function handleStepDone(msg, tabId, sendResponse) {
  const job = state.activeJobs.get(tabId);
  const logMsg = job ? `[#${job.index + 1}] ${msg.step}` : msg.step;

  console.log(`[BG] Tab ${tabId} step: ${msg.step}`);
  broadcastStatus({ log: logMsg });

  try {
    const { logs = [] } = await chrome.storage.local.get('logs');
    const time = new Date().toLocaleTimeString('vi-VN');
    logs.push({ time, text: logMsg, level: msg.level || '' });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await chrome.storage.local.set({ logs });
  } catch (_) {}

  sendResponse({ success: true });
}

// ── Handle get OTP ────────────────────────────────────────────────────
/**
 * v3.0: Hỗ trợ cả 3 provider:
 *   - hotmail_dongvan   → gọi HotmailDongVanProvider.fetchOtpOnce(hotmailAcc)
 *   - dongvan_maildomain → gọi DongVanMailDomainProvider.fetchOtpOnce() (trên _mailProvider)
 *   - mailtm             → gọi MailTmProvider.fetchOtpOnce() (trên _mailProvider)
 */
async function handleGetOtp(msg, tabId, sendResponse) {
  const job = state.activeJobs.get(tabId);
  if (!job) {
    console.error(`[BG] FETCH_OTP: Job not found for tab ${tabId}`);
    sendResponse({ success: false, otp: null, error: 'Job not found' });
    return;
  }

  console.log(`[BG] FETCH_OTP request: tab=${tabId}, email=${job.email}, provider=${job.provider}`);

  try {
    let result;

    if (job.provider === 'hotmail_dongvan' && state.hotmailProvider && job._hotmailAcc) {
      // ── Hotmail DongVan — dùng getDongVanFB_OTP() mới ──
      console.log(`[BG] Gọi HotmailDongVanProvider.fetchOtpOnce()...`);
      result = await state.hotmailProvider.fetchOtpOnce(job._hotmailAcc);

    } else if (job.provider === 'dongvan_maildomain' && job._mailProvider) {
      // ── DongVan Mail Domain — gọi fetchOtpOnce() trên instance per-job ──
      console.log(`[BG] Gọi DongVanMailDomainProvider.fetchOtpOnce()...`);
      const otp = await job._mailProvider.fetchOtpOnce();
      result = { otp: otp || null, error: null };

    } else if (job._mailProvider) {
      // ── MailTm — giữ nguyên logic cũ ──
      console.log(`[BG] Gọi MailTmProvider.fetchOtpOnce()...`);
      const otp = await job._mailProvider.fetchOtpOnce();
      result = { otp: otp || null, error: null };

    } else {
      // ── Không xác định được provider ──
      const reason = !state.hotmailProvider && job.provider === 'hotmail_dongvan'
        ? 'hotmailProvider chưa khởi tạo'
        : !job._hotmailAcc && job.provider === 'hotmail_dongvan'
        ? '_hotmailAcc không tồn tại'
        : !job._mailProvider
        ? '_mailProvider không tồn tại'
        : 'Không xác định provider';
      console.error(`[BG] FETCH_OTP: ${reason}`);
      result = { otp: null, error: reason };
    }

    console.log(`[BG] FETCH_OTP result: otp=${result.otp || 'null'}, error=${result.error || 'none'}`);

    if (result.otp) {
      sendResponse({ success: true, otp: result.otp, error: null });
    } else {
      sendResponse({ success: false, otp: null, error: result.error || null });
    }
  } catch (e) {
    console.error(`[BG] FETCH_OTP error:`, e.message);
    sendResponse({ success: false, otp: null, error: e.message });
  }
}

// ── Handle get job ────────────────────────────────────────────────────

function handleGetJob(tabId, sendResponse) {
  const job = state.activeJobs.get(tabId);
  if (job) {
    sendResponse({ success: true, job: serializeJob(job) });
  } else {
    sendResponse({ success: false, error: 'No job for this tab' });
  }
}

// ── Handle registration complete ──────────────────────────────────────

async function handleRegComplete(msg, tabId, sendResponse) {
  const job = state.activeJobs.get(tabId);
  if (!job) { sendResponse({ success: false }); return; }

  state.activeJobs.delete(tabId);

  const account = {
    email: job.email,
    chatgptPassword: job.chatgptPassword,
    hotmailPassword: job.emailPassword || '',
    status: 'success',
    hasTrialPlus: msg.hasTrialPlus || false,
    notes: msg.notes || '',
    provider: job.provider || 'unknown',
    registeredAt: new Date().toISOString(),
    duration: job.startTime ? Math.round((Date.now() - job.startTime) / 1000) + 's' : '',
  };
  console.log(`[BG] Saving successful account: ${job.email}`);
  await saveAccount(account);
  await incrementStat('success');

  state.successCount++;
  state.completedCount++;

  broadcastStatus({
    log: `[#${job.index + 1}] ✓ THÀNH CÔNG: ${job.email}`,
    newAccount: account,
  });

  if (job._mailProvider?.cleanup) {
    job._mailProvider.cleanup().catch(() => {});
  }

  if (state.completedCount >= state.totalCount) {
    state.isRunning = false;
    broadcastStatus({ log: `=== HOÀN THÀNH: ${state.successCount}/${state.totalCount} thành công ===` });
  } else {
    await sleep(1000);
    spawnNextJob(false);
  }

  sendResponse({ success: true });
}

// ── Handle registration error ─────────────────────────────────────────

async function handleRegError(msg, tabId, sendResponse) {
  const job = state.activeJobs.get(tabId);
  if (!job) { sendResponse({ success: false }); return; }

  state.activeJobs.delete(tabId);
  await incrementStat('failed');

  state.failedCount++;
  state.completedCount++;

  broadcastStatus({
    log: `[#${job.index + 1}] ✗ LỖI: ${msg.error || 'Unknown error'}`,
  });

  if (tabId !== state.originTabId) {
    chrome.tabs.remove(tabId).catch(() => {});
  }

  if (state.completedCount >= state.totalCount) {
    state.isRunning = false;
    broadcastStatus({ log: `=== KẾT THÚC: ${state.successCount}/${state.totalCount} thành công ===` });
  } else {
    await sleep(1000);
    spawnNextJob(false);
  }

  sendResponse({ success: true });
}

// ── Handle Start Trial ────────────────────────────────────────────────

async function handleStartTrial(msg, sender, sendResponse) {
  const settings = await getSettings();

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      sendResponse({ success: false, error: 'Không tìm thấy tab hiện tại' });
      return;
    }

    const tabId = activeTab.id;
    const countryCode = msg.countryCode || settings.countryCode || 'US';
    const planType = msg.planType || 'personal';
    const binList = settings.trialBinList || [];
    const maxRetry = settings.trialMaxRetry || 10;
    const captchaService = settings.captchaService || 'none';
    const captchaApiKey = settings.captchaApiKey || '';

    broadcastStatus({ log: `[Trial] Đang navigate đến trang pricing...` });
    await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/#pricing' });

    await waitForTabComplete(tabId, 30000);

    broadcastStatus({ log: `[Trial] Chờ trang pricing render...` });
    await sleep(3000);

    const trialJob = {
      type: 'EXEC_TRIAL',
      countryCode,
      planType,
      binList,
      maxRetry,
      captchaService,
      captchaApiKey,
    };

    let lastError = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        const pingOk = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
            if (chrome.runtime.lastError) resolve(false);
            else resolve(response?.pong === true || response?.trialReady === true);
          });
        });

        if (!pingOk) {
          throw new Error('Content script chưa sẵn sàng (PING failed)');
        }

        await sleep(attempt <= 2 ? 2000 : 500);

        const res = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, trialJob, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          });
        });

        broadcastStatus({ log: `[Trial] Bắt đầu Trial ${planType === 'business' ? 'Business' : 'Plus'} trên tab ${tabId} (${countryCode})` });
        sendResponse({ success: true });
        return;

      } catch (e) {
        lastError = e;
        console.warn(`[BG] Trial attempt ${attempt}/15: ${e.message}`);
        broadcastStatus({ log: `[Trial] Chờ content script sẵn sàng... (${attempt}/15)` });

        if (attempt < 15) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['src/content/trial.js'],
            });
          } catch (_) {}
          await sleep(2000);
        }
      }
    }

    sendResponse({ success: false, error: `Không thể kết nối content script sau 15 lần thử: ${lastError?.message}` });

  } catch (e) {
    console.error('[BG] handleStartTrial error:', e);
    sendResponse({ success: false, error: e.message });
  }
}

/**
 * waitForTabComplete với race condition fix
 */
function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise(resolve => {
    let resolved = false;

    const doResolve = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        doResolve();
      }
    };

    const timer = setTimeout(doResolve, timeout);
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') {
        doResolve();
      }
    });
  });
}

// ── Broadcast status ──────────────────────────────────────────────────

function broadcastStatus(extra = {}) {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    state: getPublicState(),
    ...extra,
  }).catch(() => {});

  if (extra.log) {
    chrome.storage.local.get('logs').then(({ logs = [] }) => {
      const time = new Date().toLocaleTimeString('vi-VN');
      logs.push({ time, text: extra.log, level: extra.level || '' });
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      chrome.storage.local.set({ logs });
    }).catch(() => {});
  }
}

function getPublicState() {
  return {
    isRunning: state.isRunning,
    total: state.totalCount,
    completed: state.completedCount,
    success: state.successCount,
    failed: state.failedCount,
    activeJobs: state.activeJobs.size,
  };
}

function serializeJob(job) {
  const { _mailProvider, ...rest } = job;
  return rest;
}

// ── Tab removed listener ──────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.activeJobs.has(tabId)) {
    const job = state.activeJobs.get(tabId);
    state.activeJobs.delete(tabId);
    console.warn(`[BG] Tab ${tabId} closed unexpectedly (job #${job.index + 1})`);
    state.failedCount++;
    state.completedCount++;
    if (state.completedCount >= state.totalCount) {
      state.isRunning = false;
    } else {
      spawnNextJob(false);
    }
    broadcastStatus();
  }
});

// ── Handle Fill Stripe Field (inject vào Stripe cross-origin iframe) ──────

async function handleFillStripeField(msg, tabId, sendResponse) {
  if (!tabId) { sendResponse({ success: false, error: 'No tabId' }); return; }

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) { sendResponse({ success: false, error: 'No frames' }); return; }

    const stripeFrame = frames.find(f =>
      f.url && (f.url.includes('stripe') || f.url.includes('js.stripe.com'))
    );

    if (!stripeFrame) {
      sendResponse({ success: false, error: 'Stripe frame not found' });
      return;
    }

    const { fieldType, value } = msg;

    const selectorMap = {
      cardNumber: ['input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[placeholder*="0000"]'],
      expiry:     ['input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[placeholder*="MM"]'],
      cvc:        ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="CVC"]'],
    };
    const selectors = selectorMap[fieldType] || [];

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [stripeFrame.frameId] },
      func: (selectors, value) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            el.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeSetter) nativeSetter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      },
      args: [selectors, value],
    });

    sendResponse({ success: true });
  } catch (e) {
    console.warn('[BG] handleFillStripeField error:', e.message);
    sendResponse({ success: false, error: e.message });
  }
}

console.log('[BG] ChatGPT AutoReg Pro v3.1.0 background service worker started');
