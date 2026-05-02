/**
 * content.js — Tự động điều khiển form đăng ký ChatGPT
 *
 * v3.1.0 Optimizations:
 * - OTP: Giảm initial wait 10s → 3s, poll interval 5s → 2.5s, resend wait 15s → 5s
 * - OTP: Thêm polls-before-resend logic (poll 8 lần trước khi resend)
 * - OTP: Fast fill OTP thay vì humanType (tiết kiệm 1-2s)
 * - OTP: Các tham số timing có thể cấu hình qua Settings
 * - OTP: Không break ngay khi lỗi tạm thời, tiếp tục poll
 * - OTP: Giảm spam log (chỉ log mỗi 3 lần poll)
 *
 * v2.0 Fixes:
 * - OTP retry loop: đọc code → nhập → xác nhận → nếu sai → đọc lại → xóa code cũ → nhập code mới → xác nhận (lặp)
 * - Lưu acc chỉ khi thực sự đã tạo thành công (kiểm tra URL + DOM)
 * - Ổn định autoDetect, xử lý edge cases
 *
 * States:
 *   INIT         → Trang chatgpt.com, tìm nút Sign up
 *   EMAIL        → Form email đã xuất hiện, nhập email
 *   PASSWORD     → Form password, nhập password
 *   OTP          → Trang OTP, nhập mã (có retry loop)
 *   PROFILE      → Form tên + ngày sinh
 *   DONE         → Đăng ký xong
 *   TRIAL        → Đang làm Trial Plus
 */

(async function () {
  'use strict';

  // ── Chỉ chạy 1 lần mỗi lần trang load ────────────────────────────
  if (window.__autoRegRunning) return;
  window.__autoRegRunning = true;

  // ── Helpers ────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randomDelay = (min = 800, max = 2500) => sleep(rand(min, max));

  // ── Constants (khai báo sớm để tránh TDZ - Temporal Dead Zone) ────
  const MAX_OTP_RETRIES = 5;

  // ── OTP Timing Config (có thể override từ settings qua job) ────────
  // Các giá trị mặc định đã được tối ưu so với v3.0.0
  let OTP_INITIAL_WAIT = 3000;    // v3.0.0: 10000 → v3.1.0: 3000 (giảm 7s)
  let OTP_POLL_INTERVAL = 2500;   // v3.0.0: 5000  → v3.1.0: 2500 (giảm 2.5s)
  let OTP_RESEND_WAIT = 5000;     // v3.0.0: 15000 → v3.1.0: 5000 (giảm 10s)
  let OTP_MAX_POLLS = 30;         // v3.0.0: 24    → v3.1.0: 30   (tăng số lần poll)
  let OTP_POLLS_BEFORE_RESEND = 8; // Mới: poll 8 lần (20s) trước khi resend

  async function waitFor(selector, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el && el.getBoundingClientRect().width > 0) return el;
      await sleep(300);
    }
    return null;
  }

  async function waitForAny(selectors, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().width > 0) return { el, sel };
      }
      await sleep(300);
    }
    return null;
  }

  /** Nhập text giống người dùng thật — bypass React controlled input */
  async function humanType(el, text) {
    el.focus();
    await sleep(200);

    // Xóa nội dung cũ
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);

    for (const char of text) {
      const delay = rand(60, 140);
      const current = el.value;
      if (nativeSetter) nativeSetter.call(el, current + char);
      else el.value = current + char;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(delay);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
  }

  /** Xóa nội dung input field */
  async function clearInput(el) {
    el.focus();
    await sleep(100);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);
  }

  async function humanClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(200, 500));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(rand(80, 150));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(rand(60, 100));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    await sleep(rand(200, 400));
  }

  function sendBG(type, data = {}) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, ...data }, res => {
          if (chrome.runtime.lastError) resolve({});
          else resolve(res || {});
        });
      } catch (_) { resolve({}); }
    });
  }

  function log(msg) {
    console.log(`[AutoReg] ${msg}`);
    sendBG('REG_STEP_DONE', { step: msg });
  }

  // ── State Machine (lưu vào sessionStorage để survive reload) ──────

  const STATE_KEY = '__autoreg_state__';
  const JOB_KEY = '__autoreg_job__';

  function getState() {
    try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); } catch { return null; }
  }

  function setState(s) {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(s));
  }

  function clearState() {
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(JOB_KEY);
  }

  function getLocalJob() {
    try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null'); } catch { return null; }
  }

  function saveLocalJob(job) {
    const { _mailProvider, ...rest } = job;
    sessionStorage.setItem(JOB_KEY, JSON.stringify(rest));
  }

  // ── Chờ Cloudflare ─────────────────────────────────────────────────

  async function waitCloudflare(timeout = 35000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const title = document.title.toLowerCase();
      if (!title.includes('just a moment') && !title.includes('checking your browser')) return true;
      await sleep(1000);
    }
    return false;
  }

  // ── Entry point ────────────────────────────────────────────────────

  await sleep(1200);

  // Chờ Cloudflare trước khi làm gì
  if (document.title.toLowerCase().includes('just a moment') ||
      document.title.toLowerCase().includes('checking your browser')) {
    log('Chờ Cloudflare...');
    const ok = await waitCloudflare(35000);
    if (!ok) { log('Timeout Cloudflare'); return; }
    log('Cloudflare passed');
    await randomDelay(1500, 2500);
  }

  // Đọc state hiện tại
  let currentState = getState();
  let job = getLocalJob();

  // Nếu chưa có state → lấy job từ background
  if (!currentState) {
    const res = await sendBG('GET_JOB');
    if (!res.success || !res.job) {
      console.log('[AutoReg] Không có job cho tab này');
      return;
    }
    job = res.job;
    saveLocalJob(job);
    currentState = { step: 'INIT' };
    setState(currentState);
    log(`Bắt đầu đăng ký: ${job.email}`);
    // Áp dụng OTP config từ settings nếu có
    if (job.otpInitialWait !== undefined) OTP_INITIAL_WAIT = job.otpInitialWait;
    if (job.otpPollInterval !== undefined) OTP_POLL_INTERVAL = job.otpPollInterval;
    if (job.otpResendWait !== undefined) OTP_RESEND_WAIT = job.otpResendWait;
    if (job.otpMaxPolls !== undefined) OTP_MAX_POLLS = job.otpMaxPolls;
    if (job.otpPollsBeforeResend !== undefined) OTP_POLLS_BEFORE_RESEND = job.otpPollsBeforeResend;
  } else if (!job) {
    const res = await sendBG('GET_JOB');
    if (!res.success || !res.job) {
      log('Mất job data, dừng lại');
      clearState();
      return;
    }
    job = res.job;
    saveLocalJob(job);
  }

  log(`Tiếp tục từ bước: ${currentState.step} | URL: ${window.location.href}`);

  // ── Kiểm tra state có phù hợp với trang hiện tại không ────────────
  const currentUrl = window.location.href;
  const isOnChatGPT = (currentUrl.includes('chatgpt.com') || currentUrl.includes('chat.openai.com'))
                      && !currentUrl.includes('auth.openai.com') && !currentUrl.includes('/auth/');

  const isAuthStep = ['EMAIL', 'PASSWORD', 'OTP', 'PROFILE', 'AUTO_DETECT'].includes(currentState.step);

  if (isOnChatGPT && isAuthStep) {
    const hasAuthForm = document.querySelector(
      'input[type="email"], input[type="password"], input[name="code"], ' +
      'input[autocomplete="new-password"], input[name="name"], [data-type="year"]'
    );
    if (!hasAuthForm) {
      log('Đã quay lại chatgpt.com sau đăng ký → chuyển sang DONE');
      clearState();
      currentState = { step: 'DONE' };
      setState(currentState);
    } else {
      log('Phát hiện form trên chatgpt.com, auto-detect lại...');
      currentState = { step: 'AUTO_DETECT' };
    }
  }

  // Fix: Nếu state='OTP' nhưng đã navigate ra khỏi trang email-verification
  // (ví dụ sang about-you, profile) → chuyển sang AUTO_DETECT để detect đúng bước
  if (currentState.step === 'OTP' && currentUrl.includes('auth.openai.com') &&
      !currentUrl.includes('email-verification')) {
    const hasOtpField = document.querySelector(
      'input[name="code"], input[autocomplete="one-time-code"], input[type="text"][maxlength="1"]'
    );
    if (!hasOtpField) {
      log('State=OTP nhưng không còn ở trang OTP, auto-detect lại...');
      currentState = { step: 'AUTO_DETECT' };
      setState(currentState);
    }
  }

  // ── Dispatch theo state ────────────────────────────────────────────

  try {
    switch (currentState.step) {
      case 'INIT':
        await stepInit(job);
        break;
      case 'EMAIL':
        await stepEmail(job);
        break;
      case 'PASSWORD':
        await stepPassword(job);
        break;
      case 'OTP':
        await stepOtp(job);
        break;
      case 'PROFILE':
        await stepProfile(job);
        break;
      case 'DONE':
        await stepDone(job);
        break;
      case 'TRIAL':
        await stepTrialPlus(job);
        break;
      case 'AUTO_DETECT':
        await autoDetectStep(job);
        break;
      default:
        await autoDetectStep(job);
    }
  } catch (e) {
    console.error('[AutoReg] Error:', e);
    log(`Lỗi: ${e.message}`);
    clearState();
    await sendBG('REG_ERROR', { error: e.message });
  }

  // ══════════════════════════════════════════════════════════════════
  // AUTO DETECT: Dựa vào DOM để biết đang ở bước nào
  // ══════════════════════════════════════════════════════════════════

  async function autoDetectStep(job) {
    log('Auto-detect b\u01b0\u1edbc hi\u1ec7n t\u1ea1i...');
    await randomDelay(1000, 2000);

    const url = window.location.href;
    const isOnAuth = url.includes('auth.openai.com') || url.includes('/auth/');
    const isOnChatGPTMain = (url.includes('chatgpt.com') || url.includes('chat.openai.com')) && !isOnAuth;

    // \u2500\u2500 1. Ki\u1ec3m tra onboarding (\u01b0u ti\u00ean cao nh\u1ea5t) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const bodyText = (document.body.textContent || '').toLowerCase();
    if (bodyText.includes('what brings you') || bodyText.includes('th\u00f4i th\u00fac') ||
        bodyText.includes('how will you use') || bodyText.includes('tell us about')) {
      log('\u0110\u00e3 v\u00e0o ChatGPT th\u00e0nh c\u00f4ng (trang onboarding)!');
      setState({ step: 'DONE' });
      await stepDone(job);
      return;
    }

    // \u2500\u2500 2. N\u1ebfu \u0111ang \u1edf chatgpt.com (KH\u00d4NG ph\u1ea3i auth) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (isOnChatGPTMain) {
      // Ki\u1ec3m tra c\u00f3 modal \u0111\u0103ng nh\u1eadp/\u0111\u0103ng k\u00fd kh\u00f4ng (c\u00f3 \u00f4 email)
      const emailField = document.querySelector(
        'input[type="email"], input[name="email"], input[id="email-input"], ' +
        'input[autocomplete="email"], input[inputmode="email"]'
      );
      if (emailField && emailField.getBoundingClientRect().width > 0) {
        log('Ph\u00e1t hi\u1ec7n form email (modal tr\u00ean chatgpt.com)');
        setState({ step: 'EMAIL' });
        await stepEmail(job);
        return;
      }

      // Kh\u00f4ng c\u00f3 form auth n\u00e0o \u2192 \u0111\u00e3 \u0111\u0103ng k\u00fd xong
      const hasAnyAuthForm = document.querySelector(
        'input[type="email"], input[type="password"], input[name="code"], ' +
        'input[autocomplete="new-password"], input[name="name"], [data-type="year"]'
      );
      if (!hasAnyAuthForm) {
        log('\u0110\u00e3 v\u00e0o ChatGPT th\u00e0nh c\u00f4ng!');
        setState({ step: 'DONE' });
        await stepDone(job);
        return;
      }

      // C\u00f3 form kh\u00e1c (password, name...) tr\u00ean chatgpt.com \u2014 hi\u1ebfm nh\u01b0ng c\u00f3 th\u1ec3
      log('C\u00f3 form auth tr\u00ean chatgpt.com, ch\u1edd redirect sang auth...');
      await sleep(5000);
      // Ki\u1ec3m tra l\u1ea1i sau khi ch\u1edd
      if (window.location.href !== url) {
        await autoDetectStep(job);
        return;
      }
      // V\u1eabn \u1edf chatgpt.com \u2192 th\u1eed detect form
      const pwField2 = document.querySelector('input[type="password"]');
      if (pwField2 && pwField2.getBoundingClientRect().width > 0) {
        setState({ step: 'PASSWORD' });
        await stepPassword(job);
        return;
      }
      // Kh\u00f4ng bi\u1ebft \u2192 ch\u1edd th\u00eam
      await sleep(3000);
      await autoDetectStep(job);
      return;
    }

    // \u2500\u2500 3. \u0110ang \u1edf auth.openai.com \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    // 3a. URL email-verification \u2192 ch\u1eafc ch\u1eafn l\u00e0 trang OTP
    if (url.includes('email-verification')) {
      log('Ph\u00e1t hi\u1ec7n URL email-verification, ch\u1edd \u00f4 OTP...');
      const otpField = await waitForAny([
        'input[name="code"]', 'input[autocomplete="one-time-code"]',
        'input[type="text"][maxlength="1"]',
      ], 10000);
      if (otpField) {
        log('Ph\u00e1t hi\u1ec7n trang OTP (t\u1eeb URL email-verification)');
        setState({ step: 'OTP' });
        await stepOtp(job);
        return;
      }
      // Kh\u00f4ng t\u00ecm th\u1ea5y \u00f4 OTP chu\u1ea9n \u2192 t\u00ecm b\u1ea5t k\u1ef3 input n\u00e0o
      const anyOtpInput = document.querySelector('input:not([type="hidden"]):not([type="checkbox"])');
      if (anyOtpInput && anyOtpInput.getBoundingClientRect().width > 0) {
        log('Ph\u00e1t hi\u1ec7n \u00f4 nh\u1eadp tr\u00ean trang email-verification');
        setState({ step: 'OTP' });
        await stepOtp(job);
        return;
      }
    }

    // 3b. Ki\u1ec3m tra 6 \u00f4 OTP
    const otpInputs = document.querySelectorAll('input[type="text"][maxlength="1"], input[maxlength="1"]');
    if (otpInputs.length >= 6) {
      log('Ph\u00e1t hi\u1ec7n trang OTP (6 \u00f4)');
      setState({ step: 'OTP' });
      await stepOtp(job);
      return;
    }

    // 3c. Ki\u1ec3m tra \u00f4 OTP \u0111\u01a1n (CH\u1ec8 tr\u00ean auth.openai.com)
    const singleOtp = document.querySelector(
      'input[name="code"], input[autocomplete="one-time-code"]'
    );
    if (singleOtp && singleOtp.getBoundingClientRect().width > 0) {
      log('Ph\u00e1t hi\u1ec7n trang OTP (1 \u00f4)');
      setState({ step: 'OTP' });
      await stepOtp(job);
      return;
    }

    // 3d. Ki\u1ec3m tra form password
    const pwField = document.querySelector('input[autocomplete="new-password"], input[type="password"]');
    if (pwField && pwField.getBoundingClientRect().width > 0) {
      log('Ph\u00e1t hi\u1ec7n form password');
      setState({ step: 'PASSWORD' });
      await stepPassword(job);
      return;
    }

    // 3e. Ki\u1ec3m tra form profile
    const nameField = document.querySelector('input[name="name"], input[autocomplete="name"], [data-type="year"]');
    if (nameField && nameField.getBoundingClientRect().width > 0) {
      log('Ph\u00e1t hi\u1ec7n form profile');
      setState({ step: 'PROFILE' });
      await stepProfile(job);
      return;
    }

    // 3f. Ki\u1ec3m tra form email
    const emailField = document.querySelector(
      'input[type="email"], input[name="email"], input[id="email-input"], input[autocomplete="email"]'
    );
    if (emailField && emailField.getBoundingClientRect().width > 0) {
      log('Ph\u00e1t hi\u1ec7n form email');
      setState({ step: 'EMAIL' });
      await stepEmail(job);
      return;
    }

    // \u2500\u2500 4. Kh\u00f4ng nh\u1eadn ra \u2192 ch\u1edd v\u00e0 th\u1eed l\u1ea1i \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    log('Ch\u01b0a nh\u1eadn ra trang, ch\u1edd th\u00eam...');
    await sleep(3000);

    const anyInput = await waitForAny([
      'input[type="email"]', 'input[name="email"]',
      'input[autocomplete="new-password"]', 'input[type="password"]',
      'input[name="code"]', 'input[autocomplete="one-time-code"]',
      'input[type="text"][maxlength="1"]',
      'input[name="name"]', '[data-type="year"]',
    ], 15000);

    if (anyInput) {
      await autoDetectStep(job);
    } else {
      throw new Error('Kh\u00f4ng nh\u1eadn ra b\u01b0\u1edbc hi\u1ec7n t\u1ea1i sau khi ch\u1edd');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // BƯỚC INIT
  // ══════════════════════════════════════════════════════════════════

  async function stepInit(job) {
    const url = window.location.href;

    if (url.includes('auth.openai.com')) {
      await autoDetectStep(job);
      return;
    }

    log('Bước 1: Tìm nút Sign up...');
    await randomDelay(1500, 3000);

    let signupBtn = null;
    signupBtn = document.querySelector('[data-testid="signup-button"], [data-testid="sign-up-button"]');

    if (!signupBtn) {
      for (const el of document.querySelectorAll('button, a')) {
        const text = el.textContent.trim().toLowerCase();
        if (['sign up', 'sign up for free', 'get started', 'create account', 'create free account'].includes(text)) {
          signupBtn = el;
          break;
        }
      }
    }

    if (!signupBtn) {
      signupBtn = document.querySelector('a[href*="signup"], a[href*="sign-up"]');
    }

    if (signupBtn) {
      log('T\u00ecm th\u1ea5y n\u00fat Sign up, click...');
      setState({ step: 'EMAIL' });
      await humanClick(signupBtn);
      await randomDelay(2000, 4000);

      // Sau click Sign up, c\u00f3 th\u1ec3:
      // a. Redirect sang auth.openai.com
      // b) Hi\u1ec7n modal \u0111\u0103ng nh\u1eadp tr\u00ean chatgpt.com
      // Ch\u1edd th\u00eam n\u1ebfu ch\u01b0a th\u1ea5y form email
      const emailField = await waitForAny([
        'input[type="email"]', 'input[name="email"]',
        'input[id="email-input"]', 'input[autocomplete="email"]',
      ], 10000);

      if (emailField) {
        log('\u0110\u00e3 t\u00ecm th\u1ea5y \u00f4 email, b\u1eaft \u0111\u1ea7u nh\u1eadp...');
        await stepEmail(job);
      } else {
        // C\u00f3 th\u1ec3 \u0111\u00e3 redirect ho\u1eb7c trang kh\u00e1c
        await autoDetectStep(job);
      }
    } else {
      log('Không tìm thấy nút Sign up, navigate trực tiếp...');
      setState({ step: 'EMAIL' });
      window.location.href = 'https://auth.openai.com/authorize?client_id=pdlLIX2Y72MIl2rhLhTE9VV9bN9LdLR2&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Fopenai&response_type=code&scope=openid+email+profile+offline_access+model.request+model.read+organization.read+organization.write&prompt=login&screen_hint=signup';
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // BƯỚC EMAIL
  // ══════════════════════════════════════════════════════════════════

  async function stepEmail(job) {
    log('Bước Email: Nhập email...');

    const emailField = await waitFor(
      'input[type="email"], input[name="email"], input[id="email-input"], input[autocomplete="email"]',
      15000
    );
    if (!emailField) throw new Error('Không tìm thấy trường email');

    if (emailField.value && emailField.value.includes('@')) {
      log('Email đã được điền, bỏ qua...');
    } else {
      await humanType(emailField, job.email);
      await randomDelay(800, 1500);
    }

    const continueBtn = document.querySelector('button[type="submit"], button[data-action-button-primary="true"]');
    if (continueBtn && !continueBtn.disabled) {
      await humanClick(continueBtn);
    } else {
      emailField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }

    log('Đã submit email, chờ bước tiếp...');
    // KHOONG set cứng PASSWORD — ChatGPT có thể nhảy thẳng OTP nếu email đã có password từ trước
    setState({ step: 'AUTO_DETECT' });
    await randomDelay(3000, 5000);

    if (document.title.toLowerCase().includes('just a moment')) {
      await waitCloudflare(30000);
      await randomDelay(2000, 3000);
    }

    await autoDetectStep(job);
  }

  // ══════════════════════════════════════════════════════════════════
  // BƯỚC PASSWORD
  // ══════════════════════════════════════════════════════════════════

  async function stepPassword(job) {
    log('Bước Password: Nhập mật khẩu...');

    const pwField = await waitFor(
      'input[autocomplete="new-password"], input[type="password"], input[name="password"]',
      15000
    );
    if (!pwField) throw new Error('Không tìm thấy trường password');

    if (pwField.value && pwField.value.length >= 8) {
      log('Password đã được điền, bỏ qua...');
    } else {
      await humanType(pwField, job.chatgptPassword);
      await randomDelay(800, 1500);
    }

    const continueBtn = document.querySelector('button[type="submit"]');
    if (continueBtn && !continueBtn.disabled) {
      await humanClick(continueBtn);
    } else {
      pwField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }

    log('Đã submit password, chờ bước tiếp...');
    setState({ step: 'OTP' });
    await randomDelay(3000, 5000);

    if (document.title.toLowerCase().includes('just a moment')) {
      await waitCloudflare(30000);
      await randomDelay(2000, 3000);
    }

    await autoDetectStep(job);
  }

  // ══════════════════════════════════════════════════════════════════
  // BƯỚC OTP — CÓ RETRY LOOP
  // Cơ chế: Đọc code → nhập → xác nhận → nếu sai → đọc lại → xóa cũ → nhập mới → xác nhận
  // ══════════════════════════════════════════════════════════════════

  async function stepOtp(job) {
    log('Bước OTP: Bắt đầu lấy và nhập mã xác thực...');
    log(`OTP config: initialWait=${OTP_INITIAL_WAIT}ms, pollInterval=${OTP_POLL_INTERVAL}ms, resendWait=${OTP_RESEND_WAIT}ms, maxPolls=${OTP_MAX_POLLS}, pollsBeforeResend=${OTP_POLLS_BEFORE_RESEND}`);

    // Lưu SET các code ĐÃ THỬ VÀ FAIL (không dùng lại)
    const failedCodes = new Set();

    // ── Chờ ban đầu (giảm từ 10s → 3s mặc định) ──
    log(`Chờ ${OTP_INITIAL_WAIT}ms để email OTP được gửi...`);
    await sleep(OTP_INITIAL_WAIT);

    for (let attempt = 1; attempt <= MAX_OTP_RETRIES; attempt++) {
      const isRetry = attempt > 1;
      log(`OTP attempt ${attempt}/${MAX_OTP_RETRIES}${isRetry ? ' (retry, các code đã fail: ' + [...failedCodes].join(', ') + ')' : ''}...`);

      // Nếu retry: xóa code cũ + click Gửi lại email + chờ ngắn hơn
      if (isRetry) {
        await clearOtpFields();
        log('Xóa code cũ trong ô nhập...');

        // Click "Gửi lại email" / "Resend email"
        const resendLink = Array.from(document.querySelectorAll('a, button, span')).find(el => {
          const t = (el.textContent || '').toLowerCase().trim();
          return t.includes('resend') || t.includes('gửi lại') || t === 'resend email' || t === 'gửi lại email';
        });
        if (resendLink) {
          await humanClick(resendLink);
          log(`Đã click Gửi lại email, chờ ${OTP_RESEND_WAIT}ms...`);
          await sleep(OTP_RESEND_WAIT);
        } else {
          log(`Không tìm thấy nút Gửi lại, chờ ${OTP_RESEND_WAIT}ms...`);
          await sleep(OTP_RESEND_WAIT);
        }
      }

      // ── POLLING LOOP: gọi background nhiều lần, interval ngắn hơn ──
      let otp = null;
      let consecutivePolls = 0; // Đếm số lần poll liên tục trong attempt này

      for (let poll = 1; poll <= OTP_MAX_POLLS; poll++) {
        // Chỉ log mỗi 3 lần poll để giảm spam log
        if (poll === 1 || poll % 3 === 0 || poll === OTP_MAX_POLLS) {
          log(`Đọc OTP lần ${poll}/${OTP_MAX_POLLS}...`);
        }

        const otpRes = await sendBG('GET_OTP', {});

        if (otpRes.otp) {
          // Chỉ bỏ qua nếu code này ĐÃ THỬ VÀ FAIL trước đó
          if (failedCodes.has(otpRes.otp)) {
            log(`Code ${otpRes.otp} đã thử và fail trước đó, chờ code mới...`);
            consecutivePolls++;
          } else {
            log(`CÓ OTP: ${otpRes.otp}`);
            otp = otpRes.otp;
            break;
          }
        } else if (otpRes.error) {
          // Không break ngay khi lỗi — có thể là lỗi tạm thời
          log(`Lỗi tạm: ${otpRes.error}`);
          consecutivePolls++;
        } else {
          consecutivePolls++;
        }

        // Nếu đã poll đủ OTP_POLLS_BEFORE_RESEND lần mà chưa có → break để resend
        if (consecutivePolls >= OTP_POLLS_BEFORE_RESEND && attempt < MAX_OTP_RETRIES) {
          log(`Đã poll ${consecutivePolls} lần không có OTP, chuyển sang resend...`);
          break;
        }

        if (poll < OTP_MAX_POLLS) {
          await sleep(OTP_POLL_INTERVAL);
        }
      }

      if (!otp) {
        if (attempt < MAX_OTP_RETRIES) {
          log(`Không lấy được OTP mới, thử lại lần ${attempt + 1}...`);
          continue;
        }
        throw new Error('Không lấy được OTP sau ' + MAX_OTP_RETRIES + ' lần thử');
      }

      log(`Đã nhận OTP: ${otp}`);
      await sleep(rand(300, 600));

      // 2. Nhập OTP vào form (tối ưu: dùng fast fill)
      const otpFilled = await fillOtpCode(otp);
      if (!otpFilled) {
        throw new Error('Không tìm thấy ô nhập OTP trên trang');
      }

      log('Đã nhập OTP, chờ kết quả xác nhận...');

      // Fix: Chờ và poll kết quả thay vì check 1 lần — cho trang đủ thời gian navigate
      const otpResult = await waitForOtpResult(8000);
      log(`Kết quả check OTP: ${otpResult}`);

      if (otpResult === 'success') {
        log('OTP xác nhận thành công!');
        setState({ step: 'PROFILE' });
        await autoDetectStep(job);
        return;
      }

      if (otpResult === 'error') {
        // Chỉ thêm vào failedCodes khi CHẮC CHẮN là lỗi (có error message rõ ràng)
        failedCodes.add(otp);
        log(`OTP ${otp} sai hoặc hết hạn, thêm vào danh sách fail (attempt ${attempt}/${MAX_OTP_RETRIES})`);
        if (attempt >= MAX_OTP_RETRIES) {
          throw new Error('OTP sai sau ' + MAX_OTP_RETRIES + ' lần thử');
        }
        continue;
      }

      if (otpResult === 'still_on_otp') {
        // Vẫn ở trang OTP nhưng không có lỗi rõ ràng — có thể OTP đúng nhưng trang chưa navigate
        // Không thêm vào failedCodes để có thể thử lại cùng code
        log(`OTP ${otp} chưa xác nhận được (vẫn ở trang OTP), thử lại (attempt ${attempt}/${MAX_OTP_RETRIES})`);
        if (attempt >= MAX_OTP_RETRIES) {
          throw new Error('Không xác nhận được OTP sau ' + MAX_OTP_RETRIES + ' lần thử');
        }
        continue;
      }

      // otpResult === 'unknown' và không còn ở trang OTP → có thể thành công
      log('Không phát hiện lỗi, có thể đã chuyển trang. Kiểm tra bước tiếp...');
      setState({ step: 'PROFILE' });
      await autoDetectStep(job);
      return;
    }
  }

  /**
   * Chờ và poll kết quả OTP — cho trang đủ thời gian navigate/hiển thị lỗi
   * @param {number} timeout - Thời gian tối đa chờ (ms)
   * @returns {Promise<'success'|'error'|'still_on_otp'|'unknown'>}
   */
  async function waitForOtpResult(timeout = 8000) {
    const startUrl = window.location.href;
    const deadline = Date.now() + timeout;
    let lastResult = 'still_on_otp';
    let firstErrorTime = null;
    const ERROR_CONFIRM_DELAY = 3000; // Chờ 3s sau khi thấy error để xác nhận

    // Poll mỗi 500ms, tối đa timeout ms
    while (Date.now() < deadline) {
      // Chờ Cloudflare nếu có
      if (document.title.toLowerCase().includes('just a moment')) {
        await waitCloudflare(30000);
        await randomDelay(1000, 2000);
      }

      // Ʈu tiên: Nếu URL đã thay đổi (navigate ra khỏi email-verification) → thành công
      // Check URL LUÔN TRƯỚC, kể cả khi đã thấy error trước đó
      const currentUrl = window.location.href;
      if (currentUrl !== startUrl && !currentUrl.includes('email-verification')) {
        log(`URL đã thay đổi: ${startUrl} → ${currentUrl}`);
        return 'success';
      }

      lastResult = checkOtpResult();

      // Success → trả về ngay
      if (lastResult === 'success') {
        return 'success';
      }

      // Error → KHÔNG trả về ngay, chờ thêm ERROR_CONFIRM_DELAY
      // để xem URL có thay đổi không (OTP đúng nhưng page chưa navigate)
      if (lastResult === 'error') {
        if (!firstErrorTime) {
          firstErrorTime = Date.now();
          log('Phát hiện error, chờ xác nhận...');
        } else if (Date.now() - firstErrorTime >= ERROR_CONFIRM_DELAY) {
          // Đã thấy error liên tục 3s và URL không thay đổi → lỗi thật
          return 'error';
        }
      } else {
        // Nếu không còn thấy error → reset timer
        firstErrorTime = null;
      }

      await sleep(500);
    }

    // Hết timeout: check lần cuối
    if (window.location.href !== startUrl && !window.location.href.includes('email-verification')) {
      return 'success';
    }

    return lastResult;
  }

  /**
   * Điền OTP vào form (6 ô riêng hoặc 1 ô)
   * @returns {boolean} true nếu điền thành công
   */
  async function fillOtpCode(otp) {
    const separatedInputs = document.querySelectorAll('input[type="text"][maxlength="1"], input[maxlength="1"]');

    if (separatedInputs.length >= 6) {
      // v3.1.0: Giảm delay giữa các ô từ 100-200ms + 150-280ms xuống 40-80ms + 50-100ms
      log('Điền OTP vào 6 ô riêng biệt (fast fill)...');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      for (let i = 0; i < Math.min(6, otp.length); i++) {
        const inp = separatedInputs[i];
        inp.focus();
        await sleep(rand(40, 80));
        if (nativeSetter) nativeSetter.call(inp, otp[i]);
        else inp.value = otp[i];
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: otp[i], bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: otp[i], bubbles: true }));
        await sleep(rand(50, 100));
      }
      await sleep(rand(400, 800));
      // Nhấn Enter ở ô cuối nếu không tự submit
      try {
        separatedInputs[5].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      } catch (_) {}
      return true;

    } else {
      // Tìm ô OTP: ưu tiên selector chính xác, fallback tìm input trên trang email-verification
      let codeField = await waitFor(
        'input[name="code"], input[autocomplete="one-time-code"], ' +
        'input[placeholder*="code" i], input[placeholder*="Mã"]',
        5000
      );
      // Fallback: nếu đang ở trang email-verification, tìm bất kỳ input text nào
      if (!codeField && window.location.href.includes('email-verification')) {
        codeField = document.querySelector(
          'input[type="text"]:not([type="hidden"]):not([type="checkbox"]), ' +
          'input:not([type]):not([type="hidden"]):not([type="checkbox"]):not([type="email"])'
        );
        if (codeField && codeField.getBoundingClientRect().width === 0) codeField = null;
      }
      if (!codeField) return false;

      // v3.1.0: Dùng fast fill thay vì humanType cho OTP
      codeField.focus();
      await sleep(150);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(codeField, otp);
      else codeField.value = otp;
      codeField.dispatchEvent(new Event('input', { bubbles: true }));
      codeField.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(rand(300, 500));

      const submitBtn = document.querySelector('button[type="submit"]');
      if (submitBtn && !submitBtn.disabled) await humanClick(submitBtn);
      else codeField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      return true;
    }
  }

  /**
   * Xóa nội dung các ô OTP (cho retry)
   */
  async function clearOtpFields() {
    const separatedInputs = document.querySelectorAll('input[type="text"][maxlength="1"], input[maxlength="1"]');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    if (separatedInputs.length >= 6) {
      for (let i = 5; i >= 0; i--) {
        const inp = separatedInputs[i];
        inp.focus();
        await sleep(50);
        if (nativeSetter) nativeSetter.call(inp, '');
        else inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(50);
      }
    } else {
      let codeField = document.querySelector(
        'input[name="code"], input[autocomplete="one-time-code"], ' +
        'input[placeholder*="code" i], input[placeholder*="M\u00e3"]'
      );
      // Fallback: t\u00ecm input tr\u00ean trang email-verification
      if (!codeField && window.location.href.includes('email-verification')) {
        codeField = document.querySelector(
          'input[type="text"]:not([type="hidden"]):not([type="checkbox"])'
        );
      }
      if (codeField) {
        await clearInput(codeField);
      }
    }
    await sleep(300);
  }

  /**
   * Kiểm tra kết quả sau khi nhập OTP
   * @returns {'success' | 'error' | 'unknown'}
   */
  function checkOtpResult() {
    const pageText = (document.body.textContent || '').toLowerCase();
    const url = window.location.href;

    // Kiểm tra lỗi OTP — bao gồm tiếng Việt và tiếng Anh
    const errorPatterns = [
      'invalid code', 'incorrect code', 'wrong code',
      'code is incorrect', 'code is invalid', 'code has expired',
      'code expired', 'verification code is invalid',
      'mã không chính xác',
      'mã không hợp lệ',
      'mã đã hết hạn',
      'mã xác thực không hợp lệ',
    ];

    // Check error elements trên DOM — chỉ các selector cụ thể, tránh false positive
    const errorElements = document.querySelectorAll(
      '[data-testid*="error"], .text-red, .text-danger, ' +
      'span[style*="color: red"], span[style*="color:red"], ' +
      'p[style*="color: red"], p[style*="color:red"]'
    );
    let hasVisibleError = false;
    for (const el of errorElements) {
      const t = (el.textContent || '').trim();
      // Chỉ coi là error nếu nội dung liên quan đến OTP/code
      if (t.length > 0 && t.length < 200) {
        const tLower = t.toLowerCase();
        const isOtpError = errorPatterns.some(p => tLower.includes(p));
        if (isOtpError) {
          console.log(`[checkOtp] Error element found: "${t}"`);
          hasVisibleError = true;
        }
      }
    }

    for (const pattern of errorPatterns) {
      if (pageText.includes(pattern)) {
        console.log(`[checkOtp] Matched error pattern: "${pattern}"`);
        return 'error';
      }
    }

    // Nếu có error element visible → coi là lỗi
    if (hasVisibleError) {
      return 'error';
    }

    // Kiểm tra đã chuyển trang (thành công)
    if ((url.includes('chatgpt.com') || url.includes('chat.openai.com')) &&
        !url.includes('auth.openai.com') && !url.includes('/auth/')) {
      return 'success';
    }

    // Kiểm tra đã chuyển sang form profile
    const nameField = document.querySelector('input[name="name"], input[autocomplete="name"]');
    const spinbutton = document.querySelector('[data-type="year"], div[role="spinbutton"]');
    if (nameField || spinbutton) {
      return 'success';
    }

    // Nếu vẫn ở trang email-verification → chưa thành công, coi là đang chờ
    if (url.includes('email-verification')) {
      return 'still_on_otp';
    }

    return 'unknown';
  }

  // ══════════════════════════════════════════════════════════════════
  // BƯỚC PROFILE
  // ══════════════════════════════════════════════════════════════════

  async function sendKeyToSpinbutton(el, char) {
    el.focus();
    await sleep(50);
    el.dispatchEvent(new InputEvent('beforeinput', {
      data: char, inputType: 'insertText', bubbles: true, cancelable: true
    }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), bubbles: true }));
    el.dispatchEvent(new InputEvent('input', {
      data: char, inputType: 'insertText', bubbles: true, cancelable: false
    }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), bubbles: true }));
    await sleep(rand(80, 150));
  }

  async function fillSpinbutton(el, valueStr) {
    el.focus();
    await sleep(200);
    for (const char of valueStr) {
      await sendKeyToSpinbutton(el, char);
    }
    await sleep(200);
  }

  async function fillBirthday(job) {
    const monthStr = String(job.birthMonth).padStart(2, '0');
    const dayStr   = String(job.birthDay).padStart(2, '0');
    const yearStr  = String(job.birthYear);
    const birthdayString = monthStr + dayStr + yearStr;

    log(`Điền ngày sinh: ${monthStr}/${dayStr}/${yearStr}`);

    function findSegments(container) {
      const segs = {};
      for (const t of ['month', 'day', 'year']) {
        const el = container.querySelector(`div[role="spinbutton"][data-type="${t}"]`);
        if (el && el.getBoundingClientRect().width > 0) segs[t] = el;
      }
      if (Object.keys(segs).length === 3) return segs;

      const labelMap = { month: ['month'], day: ['day'], year: ['year'] };
      for (const spin of container.querySelectorAll('div[role="spinbutton"]')) {
        if (!spin.getBoundingClientRect().width) continue;
        const lbl = (spin.getAttribute('aria-label') || '').toLowerCase();
        for (const [t, kws] of Object.entries(labelMap)) {
          if (!(t in segs) && kws.some(k => lbl.includes(k))) segs[t] = spin;
        }
      }
      if (Object.keys(segs).length === 3) return segs;

      const visible = [...container.querySelectorAll('div[role="spinbutton"]')]
        .filter(s => s.getBoundingClientRect().width > 0);
      if (visible.length >= 3) return { month: visible[0], day: visible[1], year: visible[2] };

      return null;
    }

    async function fillSegments(segs) {
      await fillSpinbutton(segs.month, monthStr);
      await sleep(rand(200, 400));
      segs.day.focus();
      await sleep(100);
      await fillSpinbutton(segs.day, dayStr);
      await sleep(rand(200, 400));
      segs.year.focus();
      await sleep(100);
      await fillSpinbutton(segs.year, yearStr);
      await sleep(300);
    }

    // PP1: Container DateField
    const containerSelectors = [
      "div[class*='react-aria-DateField']",
      "div[class*='DateField']",
      "div[id*='birthday' i]",
      "[aria-label*='birthday' i]",
      "[aria-label*='date of birth' i]",
      "div[role='group']",
    ];
    for (const sel of containerSelectors) {
      try {
        for (const container of document.querySelectorAll(sel)) {
          if (!container.getBoundingClientRect().width) continue;
          const segs = findSegments(container);
          if (segs) {
            await fillSegments(segs);
            log('Đã điền ngày sinh (PP1: container)');
            return true;
          }
        }
      } catch (_) {}
    }

    // PP2: Spinbutton toàn trang
    try {
      const allSpins = [...document.querySelectorAll('div[role="spinbutton"]')]
        .filter(s => s.getBoundingClientRect().width > 0);
      if (allSpins.length >= 3) {
        const segs = {};
        for (const spin of allSpins) {
          const dt = spin.getAttribute('data-type') || '';
          const lbl = (spin.getAttribute('aria-label') || '').toLowerCase();
          if (dt === 'month' || lbl.includes('month')) segs.month = segs.month || spin;
          else if (dt === 'day' || lbl.includes('day')) segs.day = segs.day || spin;
          else if (dt === 'year' || lbl.includes('year')) segs.year = segs.year || spin;
        }
        if (Object.keys(segs).length < 3) {
          segs.month = allSpins[0]; segs.day = allSpins[1]; segs.year = allSpins[2];
        }
        await fillSegments(segs);
        log('Đã điền ngày sinh (PP2: spinbutton toàn trang)');
        return true;
      }
    } catch (_) {}

    // PP3: <select> dropdown
    try {
      const selects = [...document.querySelectorAll('select')]
        .filter(s => s.getBoundingClientRect().width > 0);
      if (selects.length >= 3) {
        const MONTHS = ['', 'January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        let mSel, dSel, ySel;
        for (const s of selects) {
          const id = (s.id || '').toLowerCase();
          const nm = (s.name || '').toLowerCase();
          const lbl = (s.getAttribute('aria-label') || '').toLowerCase();
          if (!mSel && (id.includes('month') || nm.includes('month') || lbl.includes('month'))) mSel = s;
          else if (!dSel && (id.includes('day') || nm.includes('day') || lbl.includes('day'))) dSel = s;
          else if (!ySel && (id.includes('year') || nm.includes('year') || lbl.includes('year'))) ySel = s;
        }
        if (!mSel || !dSel || !ySel) { [mSel, dSel, ySel] = selects; }

        const mName = MONTHS[job.birthMonth];
        for (const opt of mSel.options) {
          if (opt.value == job.birthMonth || opt.value == monthStr ||
              opt.text.includes(mName) || opt.text.includes(mName.slice(0,3))) {
            mSel.value = opt.value;
            mSel.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
        await sleep(300);
        for (const opt of dSel.options) {
          if (opt.value == job.birthDay || opt.value == dayStr) {
            dSel.value = opt.value;
            dSel.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
        await sleep(300);
        for (const opt of ySel.options) {
          if (opt.value == yearStr || opt.text == yearStr) {
            ySel.value = opt.value;
            ySel.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
        log('Đã điền ngày sinh (PP3: select dropdown)');
        return true;
      }
    } catch (_) {}

    // PP4: Nhập chuỗi liền vào DateField/group
    try {
      const groupEl = document.querySelector("div[role='group'], div[class*='DateField']");
      if (groupEl && groupEl.getBoundingClientRect().width > 0) {
        groupEl.click();
        await sleep(300);
        const active = document.activeElement;
        for (const char of birthdayString) {
          active.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          active.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
          active.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
          await sleep(rand(80, 140));
        }
        log('Đã điền ngày sinh (PP4: chuỗi liền)');
        return true;
      }
    } catch (_) {}

    // PP5: input[type=date]
    try {
      const dateInput = document.querySelector('input[type="date"]');
      if (dateInput && dateInput.getBoundingClientRect().width > 0) {
        const dateStr = `${yearStr}-${monthStr}-${dayStr}`;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(dateInput, dateStr);
        else dateInput.value = dateStr;
        dateInput.dispatchEvent(new Event('input', { bubbles: true }));
        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
        log('Đã điền ngày sinh (PP5: input date)');
        return true;
      }
    } catch (_) {}

    // PP6: input placeholder MM/DD
    try {
      const placeholderInputs = document.querySelectorAll(
        "input[placeholder*='MM' i], input[placeholder*='DD' i], input[placeholder*='YYYY' i]"
      );
      const visible = [...placeholderInputs].filter(i => i.getBoundingClientRect().width > 0);
      if (visible.length > 0) {
        for (const inp of visible) {
          inp.focus();
          await sleep(200);
          for (const char of birthdayString) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            inp.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            await sleep(rand(80, 140));
          }
        }
        log('Đã điền ngày sinh (PP6: placeholder input)');
        return true;
      }
    } catch (_) {}

    log('Không điền được ngày sinh, thử tiếp tục...');
    return false;
  }

  async function stepProfile(job) {
    log('Bước Profile: Điền thông tin cá nhân...');

    await waitForAny([
      'input[name="name"]', 'input[autocomplete="name"]',
      'input[placeholder*="name" i]', 'input[placeholder*="Full" i]',
      'div[role="spinbutton"]', 'select',
    ], 15000);
    await randomDelay(500, 1000);

    // Điền tên
    const nameField = document.querySelector(
      'input[name="name"], input[autocomplete="name"], input[placeholder*="name" i], input[placeholder*="Full" i]'
    );
    if (nameField && nameField.getBoundingClientRect().width > 0) {
      const fullName = `${job.firstName} ${job.lastName}`;
      await humanType(nameField, fullName);
      await randomDelay(600, 1200);
      log(`Đã nhập tên: ${fullName}`);
    }

    // Điền ngày sinh
    try {
      await fillBirthday(job);
    } catch (e) {
      log(`Lỗi điền ngày sinh (bỏ qua): ${e.message}`);
    }

    await randomDelay(500, 1000);

    // Xử lý checkbox consent
    try {
      const checkboxes = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
        .filter(c => c.getBoundingClientRect().width > 0);
      for (const cb of checkboxes) {
        const isChecked = cb.checked || cb.getAttribute('aria-checked') === 'true';
        if (!isChecked) {
          await humanClick(cb);
          await sleep(200);
        }
      }
    } catch (_) {}

    // Submit
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn && !submitBtn.disabled) {
      await humanClick(submitBtn);
      log('Đã submit thông tin cá nhân');
    }

    setState({ step: 'DONE' });
    await randomDelay(3000, 5000);

    if (document.title.toLowerCase().includes('just a moment')) {
      await waitCloudflare(30000);
      await randomDelay(2000, 3000);
    }

    await checkDone(job);
  }

  // ══════════════════════════════════════════════════════════════════
  // KIỂM TRA KẾT QUẢ — Chỉ lưu acc khi thực sự thành công
  // ══════════════════════════════════════════════════════════════════

  async function checkDone(job) {
    log('Kiểm tra kết quả đăng ký...');

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const url = window.location.href;

      // Kiểm tra nếu đã vào chatgpt.com (không phải auth)
      if ((url.includes('chatgpt.com') || url.includes('chat.openai.com')) &&
          !url.includes('auth.openai.com') && !url.includes('/auth/')) {
        const hasAuthForm = document.querySelector('input[type="email"], input[type="password"], input[name="code"]');
        if (!hasAuthForm) {
          log('✓ Đăng ký thành công! (URL: chatgpt.com, không có form auth)');
          await stepDone(job);
          return;
        }
      }

      // Kiểm tra trang onboarding
      const pageText = (document.body.textContent || '').toLowerCase();
      if (pageText.includes('what brings you') || pageText.includes('thôi thúc') ||
          pageText.includes('how will you use') || pageText.includes('tell us about')) {
        log('✓ Đăng ký thành công (phát hiện trang onboarding)!');
        await stepDone(job);
        return;
      }

      if (pageText.includes("can't create account") || pageText.includes('account already exists')) {
        throw new Error('Email đã tồn tại hoặc không thể tạo tài khoản');
      }
      await sleep(1000);
    }

    if (window.location.href.includes('chatgpt.com') && !window.location.href.includes('auth')) {
      await stepDone(job);
    } else {
      throw new Error('Timeout chờ kết quả đăng ký');
    }
  }

  async function stepDone(job) {
    log('Đăng ký hoàn tất! Lưu tài khoản...');
    clearState();

    // Xử lý trang onboarding
    await handleOnboarding();

    // Gửi REG_COMPLETE → background sẽ lưu account
    await sendBG('REG_COMPLETE', { hasTrialPlus: false });
  }

  async function handleOnboarding() {
    try {
      await sleep(1500);
      const pageText = (document.body.textContent || '').toLowerCase();
      const isOnboarding = pageText.includes('what brings you') ||
                           pageText.includes('thôi thúc') ||
                           pageText.includes('how will you') ||
                           pageText.includes('tell us about');
      if (!isOnboarding) return;

      log('Phát hiện trang onboarding, bỏ qua...');

      let skipBtn = null;
      for (const el of document.querySelectorAll('button, a, span')) {
        const text = el.textContent.trim().toLowerCase();
        if (['skip', 'bỏ qua', 'no thanks', 'không, cảm ơn', 'maybe later'].includes(text)) {
          skipBtn = el.closest('button') || el.closest('a') || el;
          break;
        }
      }

      if (skipBtn) {
        await humanClick(skipBtn);
        log('Đã click bỏ qua onboarding');
        await randomDelay(1500, 3000);
      } else {
        for (const el of document.querySelectorAll('button')) {
          const text = el.textContent.trim().toLowerCase();
          if (['next', 'tiếp theo', 'continue', 'tiếp tục'].includes(text)) {
            log('Tìm thấy nút Tiếp theo nhưng bỏ qua (onboarding không bắt buộc)');
            break;
          }
        }
      }

      // Kiểm tra lại sau khi skip
      await sleep(2000);
      const newPageText = (document.body.textContent || '').toLowerCase();
      if (newPageText.includes('what brings you') || newPageText.includes('thôi thúc')) {
        for (const el of document.querySelectorAll('button, a, span')) {
          const text = el.textContent.trim().toLowerCase();
          if (['skip', 'bỏ qua', 'no thanks'].includes(text)) {
            await humanClick(el.closest('button') || el);
            await randomDelay(1000, 2000);
            break;
          }
        }
      }
    } catch (e) {
      log(`Onboarding handling error (bỏ qua): ${e.message}`);
    }
  }

})();
