/**
 * trial.js — Logic Trial Plus hoàn toàn độc lập
 *
 * v1.3.1 Fixes:
 * - Thêm waitForElement() helper — tránh query DOM quá sớm khi React chưa render
 * - Fix Stripe iframe: dùng chrome.runtime.sendMessage để inject script vào Stripe frame
 *   thông qua FILL_STRIPE_FIELD message (background inject via scripting API với frameId)
 * - Fix generateCardFromBin(): xử lý đúng BIN 6 chữ số, số thẻ đầy đủ, và AMEX (15 chữ số)
 * - Fix generateExpiry(): format MMYY không có khoảng trắng để tương thích Stripe
 * - Fix timing: thêm chờ sau khi click tab "Thẻ" để Stripe iframe render
 * - Fix retry: reset form đúng cách giữa các lần thử
 * - Cải thiện waitForCheckout: chờ Stripe iframe xuất hiện thay vì chỉ chờ URL
 */

(function () {
  'use strict';

  if (window.__trialJsLoaded) return;
  window.__trialJsLoaded = true;

  // ══════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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

  /**
   * FIX: waitForElement — chờ element xuất hiện và visible trong DOM
   * Tránh query DOM quá sớm khi React/SPA chưa render xong
   */
  async function waitForElement(selectors, timeout = 15000) {
    if (typeof selectors === 'string') selectors = [selectors];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el && el.getBoundingClientRect().width > 0) return el;
          }
        } catch (_) {}
      }
      await sleep(300);
    }
    return null;
  }

  /**
   * FIX: waitForElementGone — chờ element biến mất (VD: loading spinner)
   */
  async function waitForElementGone(selector, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (!el || el.getBoundingClientRect().width === 0) return true;
      await sleep(300);
    }
    return false;
  }

  async function humanType(el, text) {
    el.focus();
    await sleep(200);
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

  function setInputValue(el, value) {
    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLElement.prototype, 'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setSelectValue(selectEl, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, 'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(selectEl, value);
    else selectEl.value = value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function findVisibleInput(selectors) {
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) return el;
        }
      } catch (_) {}
    }
    return null;
  }

  function selectDropdownOption(selectEl, targetText) {
    if (!selectEl || selectEl.tagName !== 'SELECT') return false;
    const options = Array.from(selectEl.options);
    const target = targetText.toLowerCase();

    let opt = options.find(o => o.text.toLowerCase() === target || o.value.toLowerCase() === target);
    if (!opt) opt = options.find(o =>
      o.text.toLowerCase().includes(target) || target.includes(o.text.toLowerCase()) ||
      o.value.toLowerCase().includes(target) || target.includes(o.value.toLowerCase())
    );
    if (!opt) {
      const stripped = target.replace(/-?(do|si|gun|gu)$/i, '').trim();
      opt = options.find(o => {
        const t = o.text.toLowerCase().replace(/-?(do|si|gun|gu)$/i, '').trim();
        const v = o.value.toLowerCase().replace(/-?(do|si|gun|gu)$/i, '').trim();
        return t.includes(stripped) || stripped.includes(t) || v.includes(stripped) || stripped.includes(v);
      });
    }
    if (!opt) {
      const valid = options.filter(o => o.value && !o.disabled &&
        !o.text.toLowerCase().includes('select') && !o.text.toLowerCase().includes('choose') &&
        !o.text.toLowerCase().includes('선택') && !o.text.toLowerCase().includes('chọn'));
      if (valid.length > 0) opt = valid[rand(0, valid.length - 1)];
    }
    if (opt) { setSelectValue(selectEl, opt.value); return true; }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  // STRIPE IFRAME HANDLING
  // ══════════════════════════════════════════════════════════════════

  /**
   * FIX: Điền field trong Stripe iframe
   * Stripe Elements render trong cross-origin iframe — không thể truy cập contentDocument.
   * Giải pháp: dùng chrome.scripting.executeScript với frameId (qua background).
   * Background sẽ nhận FILL_STRIPE_FIELD và inject script vào đúng frame.
   */
  async function fillStripeField(fieldType, value) {
    // Tìm Stripe iframe
    const stripeIframes = document.querySelectorAll('iframe[src*="stripe"], iframe[name*="stripe"], iframe[title*="card"], iframe[title*="Secure"]');
    if (stripeIframes.length === 0) {
      log('[Trial] Không tìm thấy Stripe iframe');
      return false;
    }

    // Thử gửi request đến background để inject vào Stripe frame
    const res = await sendBG('FILL_STRIPE_FIELD', {
      fieldType,
      value,
      url: window.location.href,
    });

    if (res.success) {
      log(`[Trial] ✓ Đã điền ${fieldType} qua background (Stripe iframe)`);
      return true;
    }

    // Fallback: thử postMessage đến Stripe iframe (Stripe Elements API)
    for (const iframe of stripeIframes) {
      try {
        iframe.contentWindow.postMessage({
          type: 'stripe_field_fill',
          field: fieldType,
          value: value,
        }, '*');
      } catch (_) {}
    }

    return false;
  }

  /**
   * FIX: Chờ Stripe iframe render xong
   * Stripe iframe load sau khi trang checkout load — cần chờ riêng
   */
  async function waitForStripeIframe(timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        const src = iframe.src || '';
        const name = iframe.name || '';
        const title = (iframe.title || '').toLowerCase();
        if (src.includes('stripe') || src.includes('js.stripe.com') ||
            name.includes('stripe') || title.includes('card') ||
            title.includes('secure') || title.includes('payment')) {
          // Thêm chờ để iframe render nội dung bên trong
          await sleep(1500);
          return iframe;
        }
      }
      // Kiểm tra input thẻ trực tiếp (không qua iframe — một số checkout embed trực tiếp)
      const directInput = findVisibleInput([
        'input[name="cardnumber"]', 'input[autocomplete="cc-number"]',
        'input[placeholder*="Card number"]', 'input[placeholder*="0000"]',
      ]);
      if (directInput) return 'direct';
      await sleep(500);
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  // ADDRESS DATA
  // ══════════════════════════════════════════════════════════════════

  const TRIAL_ADDRESSES = {
    US: [
      { street: '4578 Main St', city: 'Wilmington', state: 'Delaware', zip: '19801' },
      { street: '2910 Oak Ave', city: 'Portland', state: 'Oregon', zip: '97201' },
      { street: '1523 Maple Dr', city: 'Billings', state: 'Montana', zip: '59101' },
      { street: '8732 Cedar Ln', city: 'Manchester', state: 'New Hampshire', zip: '03101' },
      { street: '3201 Park Blvd', city: 'Salem', state: 'Oregon', zip: '97301' },
      { street: '6455 Washington St', city: 'Dover', state: 'Delaware', zip: '19901' },
      { street: '1188 Elm St', city: 'Helena', state: 'Montana', zip: '59601' },
      { street: '9024 Pine Rd', city: 'Nashua', state: 'New Hampshire', zip: '03060' },
    ],
    JP: [
      { street: '1-1-1 Shibuya', city: 'Tokyo', state: 'Tokyo', zip: '150-0002' },
      { street: '2-2-2 Umeda', city: 'Osaka', state: 'Osaka', zip: '530-0001' },
      { street: '3-3-3 Sakae', city: 'Nagoya', state: 'Aichi', zip: '460-0008' },
      { street: '4-4-4 Tenjin', city: 'Fukuoka', state: 'Fukuoka', zip: '810-0001' },
      { street: '5-5-5 Odori', city: 'Sapporo', state: 'Hokkaido', zip: '060-0042' },
      { street: '6-6-6 Kawaramachi', city: 'Kyoto', state: 'Kyoto', zip: '604-8006' },
    ],
    KR: [
      { street: '123 Gangnam-daero', city: 'Seoul', state: 'Seoul', zip: '06130' },
      { street: '456 Haeundae-ro', city: 'Busan', state: 'Busan', zip: '48099' },
      { street: '789 Jungang-daero', city: 'Daegu', state: 'Daegu', zip: '41911' },
      { street: '321 Bupyeong-daero', city: 'Incheon', state: 'Incheon', zip: '21315' },
      { street: '555 Dunsan-daero', city: 'Daejeon', state: 'Daejeon', zip: '35242' },
      { street: '888 Sangmu-daero', city: 'Gwangju', state: 'Gwangju', zip: '61945' },
      { street: '111 Jungang-ro', city: 'Ulsan', state: 'Ulsan', zip: '44677' },
      { street: '222 Jungbu-daero', city: 'Suwon', state: 'Gyeonggi-do', zip: '16514' },
    ],
    GB: [
      { street: '10 Downing Street', city: 'London', state: 'England', zip: 'SW1A 2AA' },
      { street: '221B Baker Street', city: 'London', state: 'England', zip: 'NW1 6XE' },
      { street: '45 Oxford Road', city: 'Manchester', state: 'England', zip: 'M1 4BH' },
    ],
    AU: [
      { street: '100 George Street', city: 'Sydney', state: 'New South Wales', zip: '2000' },
      { street: '200 Collins Street', city: 'Melbourne', state: 'Victoria', zip: '3000' },
      { street: '300 Queen Street', city: 'Brisbane', state: 'Queensland', zip: '4000' },
    ],
    CA: [
      { street: '100 King Street West', city: 'Toronto', state: 'Ontario', zip: 'M5X 1A9' },
      { street: '200 Robson Street', city: 'Vancouver', state: 'British Columbia', zip: 'V6B 1A5' },
      { street: '300 Stephen Avenue', city: 'Calgary', state: 'Alberta', zip: 'T2P 1G7' },
    ],
  };

  const FIRST_NAMES = ['James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles',
    'Mary','Patricia','Jennifer','Linda','Elizabeth','Susan','Jessica','Sarah','Karen','Lisa',
    'Emma','Olivia','Noah','Liam','Sophia','Ava','Isabella','Mia','Charlotte','Amelia'];
  const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Anderson',
    'Thomas','Taylor','Moore','Jackson','Martin','Lee','Thompson','White','Harris','Clark'];

  // ══════════════════════════════════════════════════════════════════
  // CARD GENERATION (FIXED)
  // ══════════════════════════════════════════════════════════════════

  /**
   * FIX: generateCardFromBin — xử lý đúng các loại BIN input:
   * - BIN 6 chữ số: '411111' → gen 16 chữ số
   * - Số thẻ đầy đủ 16 chữ số: '4111111111111111' → lấy 6 chữ số đầu làm BIN, gen 16 chữ số mới
   * - AMEX (bắt đầu bằng 34 hoặc 37): gen 15 chữ số (đúng chuẩn AMEX)
   */
  function generateCardFromBin(binList) {
    const bins = binList?.length ? binList : ['411111'];
    const rawBin = bins[rand(0, bins.length - 1)].replace(/[\s-]/g, '');

    // Lấy 6 chữ số đầu làm BIN thực sự
    const bin = String(rawBin).slice(0, 6);

    // Xác định độ dài thẻ: AMEX (34xx, 37xx) = 15 chữ số, còn lại = 16
    const isAmex = bin.startsWith('34') || bin.startsWith('37');
    const targetLength = isAmex ? 15 : 16;

    // Điền ngẫu nhiên đến targetLength - 1 (để tính check digit)
    let number = bin;
    while (number.length < targetLength - 1) {
      number += rand(0, 9);
    }

    // Tính Luhn check digit
    let sum = 0;
    let alt = true;
    for (let i = number.length - 1; i >= 0; i--) {
      let n = parseInt(number[i]);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    number += (10 - (sum % 10)) % 10;

    return number;
  }

  /**
   * FIX: generateExpiry — trả về cả format MM/YY và MMYY để thử
   * Stripe thường nhận MMYY liền nhau (không có khoảng trắng)
   */
  function generateExpiry() {
    const month = String(rand(1, 12)).padStart(2, '0');
    const year = String(new Date().getFullYear() + rand(2, 5)).slice(-2);
    return {
      formatted: `${month} / ${year}`,  // Có khoảng trắng (cho humanType)
      compact: `${month}${year}`,        // Không khoảng trắng (cho Stripe)
      month,
      year,
    };
  }

  function generateCvc() {
    return String(rand(100, 999));
  }

  function generateBillingName() {
    return `${FIRST_NAMES[rand(0, FIRST_NAMES.length - 1)]} ${LAST_NAMES[rand(0, LAST_NAMES.length - 1)]}`;
  }

  function getRandomAddress(countryCode) {
    const cc = (countryCode || 'US').toUpperCase();
    const addresses = TRIAL_ADDRESSES[cc] || TRIAL_ADDRESSES['US'];
    return addresses[rand(0, addresses.length - 1)];
  }

  // ══════════════════════════════════════════════════════════════════
  // ĐIỀN FORM THẺ (FIXED — xử lý cả direct input và Stripe iframe)
  // ══════════════════════════════════════════════════════════════════

  /**
   * FIX: fillCardField — thử điền field theo thứ tự ưu tiên:
   * 1. Direct input trong document (không qua iframe)
   * 2. Stripe iframe qua background scripting
   * 3. Fallback humanType với các format khác nhau
   */
  async function fillCardField(fieldSelectors, value, fieldName) {
    // Cách 1: Tìm input trực tiếp trong document
    const directInput = findVisibleInput(fieldSelectors);
    if (directInput) {
      await humanType(directInput, value);
      log(`[Trial] ✓ Đã điền ${fieldName} (direct)`);
      return true;
    }

    // Cách 2: Tìm trong tất cả iframe (kể cả same-origin)
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) continue; // cross-origin → skip
        for (const sel of fieldSelectors) {
          const el = doc.querySelector(sel);
          if (el && el.getBoundingClientRect().width > 0) {
            el.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(
              iframe.contentWindow.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeSetter) nativeSetter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            log(`[Trial] ✓ Đã điền ${fieldName} (same-origin iframe)`);
            return true;
          }
        }
      } catch (_) {
        // cross-origin iframe — bỏ qua
      }
    }

    // Cách 3: Thử qua background scripting vào Stripe iframe
    const bgResult = await fillStripeField(fieldName, value);
    if (bgResult) return true;

    log(`[Trial] ✗ Không điền được ${fieldName}`);
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  // CAPTCHA BYPASS
  // ══════════════════════════════════════════════════════════════════

  async function solveHCaptcha(captchaService, captchaApiKey) {
    if (!captchaService || captchaService === 'none' || !captchaApiKey) {
      log('[Trial] Captcha: Không có dịch vụ bypass, chờ user giải thủ công (2 phút)...');
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const textarea = document.querySelector('textarea[name="h-captcha-response"]');
        if (textarea && textarea.value) {
          log('[Trial] Captcha đã được giải thủ công!');
          return true;
        }
        const captchaFrame = document.querySelector('iframe[src*="hcaptcha"]');
        const captchaDiv = document.querySelector('.h-captcha');
        if (!captchaFrame && !captchaDiv) {
          log('[Trial] Captcha dialog đã biến mất (có thể đã giải)');
          return true;
        }
        await sleep(2000);
      }
      log('[Trial] Timeout chờ captcha thủ công');
      return false;
    }

    let sitekey = '';
    const hcaptchaDiv = document.querySelector('[data-sitekey]');
    if (hcaptchaDiv) sitekey = hcaptchaDiv.getAttribute('data-sitekey');
    if (!sitekey) {
      const iframe = document.querySelector('iframe[src*="hcaptcha"]');
      if (iframe) {
        const match = iframe.src.match(/sitekey=([a-f0-9-]+)/i);
        if (match) sitekey = match[1];
      }
    }
    if (!sitekey) {
      log('[Trial] Không tìm thấy hCaptcha sitekey, chờ thủ công 60s...');
      await sleep(60000);
      return false;
    }

    const pageUrl = window.location.href;
    log(`[Trial] Gửi captcha đến ${captchaService} (sitekey: ${sitekey.substring(0, 20)}...)...`);

    try {
      let token = '';

      if (captchaService === 'omocaptcha') {
        const createRes = await fetch('https://omocaptcha.com/api/createTask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: captchaApiKey,
            data: { type_task: 'hCaptchaTask', websiteURL: pageUrl, websiteKey: sitekey }
          })
        });
        const createData = await createRes.json();
        if (!createData.task_id) throw new Error('OMO: Không tạo được task');
        log(`[Trial] OMO task: ${createData.task_id}`);

        for (let i = 0; i < 60; i++) {
          await sleep(3000);
          const r = await fetch('https://omocaptcha.com/api/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: captchaApiKey, task_id: createData.task_id })
          });
          const d = await r.json();
          if (d.status === 'ready' || d.status === 'success') {
            token = d.data?.token || d.solution?.token || d.token || '';
            break;
          }
          if (d.status === 'error' || d.status === 'failed') throw new Error(`OMO: ${d.message || 'Failed'}`);
        }
      } else if (captchaService === '2captcha') {
        const inRes = await fetch(`https://2captcha.com/in.php?key=${captchaApiKey}&method=hcaptcha&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
        const inData = await inRes.json();
        if (inData.status !== 1) throw new Error(`2captcha: ${inData.request}`);
        log(`[Trial] 2captcha task: ${inData.request}`);

        for (let i = 0; i < 60; i++) {
          await sleep(5000);
          const r = await fetch(`https://2captcha.com/res.php?key=${captchaApiKey}&action=get&id=${inData.request}&json=1`);
          const d = await r.json();
          if (d.status === 1) { token = d.request; break; }
          if (d.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha: ${d.request}`);
        }
      } else if (captchaService === 'anticaptcha') {
        const createRes = await fetch('https://api.anti-captcha.com/createTask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: captchaApiKey,
            task: { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: sitekey }
          })
        });
        const createData = await createRes.json();
        if (createData.errorId) throw new Error(`AntiCaptcha: ${createData.errorDescription}`);
        log(`[Trial] AntiCaptcha task: ${createData.taskId}`);

        for (let i = 0; i < 60; i++) {
          await sleep(5000);
          const r = await fetch('https://api.anti-captcha.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: captchaApiKey, taskId: createData.taskId })
          });
          const d = await r.json();
          if (d.status === 'ready') { token = d.solution?.gRecaptchaResponse || d.solution?.token || ''; break; }
          if (d.errorId) throw new Error(`AntiCaptcha: ${d.errorDescription}`);
        }
      }

      if (!token) { log('[Trial] Không nhận được captcha token'); return false; }

      log('[Trial] Đã nhận captcha token, inject vào form...');
      const textarea = document.querySelector('textarea[name="h-captcha-response"]');
      if (textarea) { textarea.value = token; textarea.dispatchEvent(new Event('input', { bubbles: true })); }
      const gTextarea = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (gTextarea) { gTextarea.value = token; gTextarea.dispatchEvent(new Event('input', { bubbles: true })); }
      try {
        if (window.hcaptcha) {
          const widgetId = document.querySelector('.h-captcha')?.getAttribute('data-hcaptcha-widget-id') || '0';
          window.hcaptcha.setResponse(token, widgetId);
        }
      } catch (_) {}
      return true;
    } catch (e) {
      log(`[Trial] Captcha bypass lỗi: ${e.message}`);
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // MAIN TRIAL PLUS FUNCTION
  // ══════════════════════════════════════════════════════════════════

  async function runTrialPlus(trialConfig) {
    const countryCode = (trialConfig.countryCode || 'US').toUpperCase();
    const planType = trialConfig.planType || 'personal';
    const binList = trialConfig.binList || [];
    const maxRetry = trialConfig.maxRetry || 10;
    const captchaService = trialConfig.captchaService || 'none';
    const captchaApiKey = trialConfig.captchaApiKey || '';

    log(`[Trial] Bắt đầu Trial ${planType === 'business' ? 'Business' : 'Plus'} (${countryCode})...`);

    // ============ BƯỚC 1: Chờ pricing load ============
    log('[Trial] Chờ trang pricing load...');

    // FIX: Dùng waitForElement thay vì loop thủ công
    const pricingKeywords = ['Plus', 'Business', 'Free', 'Cá nhân', 'Doanh nghiệp',
      '개인', '비즈니스', 'pricing', '무료 혜택 받기'];

    let pricingLoaded = false;
    for (let i = 0; i < 25; i++) {
      const pageText = document.body?.textContent || '';
      if (pricingKeywords.some(kw => pageText.includes(kw))) {
        pricingLoaded = true;
        break;
      }
      await sleep(1000);
    }

    if (!pricingLoaded) {
      log('[Trial] Pricing không load, thử navigate lại...');
      window.location.href = 'https://chatgpt.com/#pricing';
      await sleep(6000);
    }
    log('[Trial] ✓ Trang pricing đã load');

    // ============ BƯỚC 2: Xóa popup/guide nếu có ============
    log('[Trial] Xóa popup/guide nếu có...');
    const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="닫기"], button[aria-label="Đóng"]');
    if (closeBtn && closeBtn.getBoundingClientRect().width > 0) {
      try { closeBtn.click(); await sleep(500); log('[Trial] Đã đóng popup'); } catch (_) {}
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let clickedAny = false;
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        const text = el.textContent.trim().toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const isGuide = ['next', 'okay', 'done', 'got it', 'close', 'dismiss', 'skip',
          'bỏ qua', 'tiếp theo', 'biết rồi', 'no thanks', 'later', '다음', '확인', '건너뛰기'].includes(text) ||
          ariaLabel.includes('close') || ariaLabel.includes('dismiss');
        const isUpgrade = text.includes('upgrade') || text.includes('plus') || text.includes('trial') ||
          text.includes('nhận') || text.includes('nâng cấp') || text.includes('ưu đãi') ||
          text.includes('혜택') || text.includes('업그레이드');
        if (isGuide && !isUpgrade && el.getBoundingClientRect().width > 0) {
          try { el.click(); clickedAny = true; await sleep(500); } catch (_) {}
        }
      }
      if (!clickedAny) break;
      await sleep(1000);
    }

    // ============ BƯỚC 3: Chọn tab Cá nhân / Doanh nghiệp ============
    const tabLabel = planType === 'business'
      ? ['Doanh nghiệp', 'Business', 'Team', '비즈니스']
      : ['Cá nhân', 'Personal', '개인'];
    log(`[Trial] Chọn tab: ${tabLabel[0]}...`);

    // FIX: Dùng waitForElement để chờ tab xuất hiện
    let tabClicked = false;
    for (let waitTab = 0; waitTab < 5; waitTab++) {
      for (const btn of document.querySelectorAll('button, [role="tab"], div[role="tab"]')) {
        const text = btn.textContent.trim();
        if (tabLabel.some(l => text === l || text.toLowerCase() === l.toLowerCase()) &&
            btn.getBoundingClientRect().width > 0) {
          await humanClick(btn);
          log(`[Trial] ✓ Đã chọn tab "${text}"`);
          tabClicked = true;
          await sleep(2000);
          break;
        }
      }
      if (tabClicked) break;
      await sleep(1000);
    }
    if (!tabClicked) log('[Trial] ⚠ Không tìm thấy tab, có thể đã chọn sẵn');

    // ============ BƯỚC 4: Click nút "Nhận ưu đãi miễn phí" ============
    log('[Trial] Tìm nút nhận ưu đãi...');
    let foundTrialBtn = false;

    const trialBtnTexts = [
      'nhận ưu đãi miễn phí', 'nhận ưu đãi', 'nhận bản dùng thử',
      'start free trial', 'get free trial', 'try free', 'start trial',
      'get plus', 'upgrade to plus', 'try plus free',
      'claim offer', 'get offer',
      '무료 혜택 받기', '무료로 시작', 'plus 시작',
    ];

    // FIX: Retry tìm nút trial — trang SPA có thể render trễ
    for (let btnAttempt = 0; btnAttempt < 5 && !foundTrialBtn; btnAttempt++) {
      // Cách 1: Tìm nút với text cụ thể
      for (const btn of document.querySelectorAll('button, a[role="button"], a')) {
        const text = btn.textContent.trim().toLowerCase();
        if (trialBtnTexts.some(t => text.includes(t)) && btn.getBoundingClientRect().width > 0) {
          btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
          await sleep(500);
          await humanClick(btn);
          log(`[Trial] ✓ Đã click: "${btn.textContent.trim().substring(0, 60)}"`);
          foundTrialBtn = true;
          break;
        }
      }

      // Cách 2: Tìm trong card Plus
      if (!foundTrialBtn) {
        const allDivs = document.querySelectorAll('div, section, article');
        for (const div of allDivs) {
          const t = div.textContent || '';
          const hasTarget = planType === 'business'
            ? (t.includes('Business') && (t.includes('$0') || t.includes('₩0') || t.includes('miễn phí') || t.includes('무료')))
            : (t.includes('Plus') && (t.includes('$0') || t.includes('₩0') || t.includes('miễn phí') || t.includes('무료') || t.includes('THỜI GIAN CÓ HẠN') || t.includes('기간 한정')));
          if (hasTarget && div.getBoundingClientRect().height < 600) {
            const btn = div.querySelector('button, a[role="button"], a[href*="checkout"]');
            if (btn && btn.getBoundingClientRect().width > 0) {
              btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
              await sleep(500);
              await humanClick(btn);
              log(`[Trial] ✓ Đã click card: "${btn.textContent.trim().substring(0, 60)}"`);
              foundTrialBtn = true;
              break;
            }
          }
        }
      }

      if (!foundTrialBtn && btnAttempt < 4) {
        log(`[Trial] Chưa tìm thấy nút trial, chờ thêm... (${btnAttempt + 1}/5)`);
        await sleep(2000);
      }
    }

    if (!foundTrialBtn) {
      log('[Trial] ✗ Không tìm thấy nút trial/ưu đãi trên trang pricing');
      return false;
    }

    // ============ BƯỚC 5: Chờ trang checkout load ============
    log('[Trial] Chờ trang checkout load...');
    let checkoutLoaded = false;
    for (let i = 0; i < 30; i++) {
      const url = window.location.href;
      const pageText = (document.body?.textContent || '').toLowerCase();
      if (url.includes('/checkout') || url.includes('stripe') ||
          pageText.includes('phương thức thanh toán') || pageText.includes('payment method') ||
          pageText.includes('số thẻ') || pageText.includes('card number') ||
          pageText.includes('billing') || pageText.includes('hóa đơn') ||
          pageText.includes('결제 방법') || pageText.includes('카드 번호') ||
          pageText.includes('청구지 주소')) {
        checkoutLoaded = true;
        log('[Trial] ✓ Trang checkout đã load');
        break;
      }
      await sleep(1000);
    }
    if (!checkoutLoaded) {
      log('[Trial] ✗ Timeout chờ checkout page');
      return false;
    }

    // FIX: Chờ Stripe iframe render xong — đây là nguyên nhân chính gây lỗi không điền được thẻ
    log('[Trial] Chờ Stripe form render...');
    const stripeReady = await waitForStripeIframe(20000);
    if (!stripeReady) {
      log('[Trial] ⚠ Không tìm thấy Stripe iframe, thử tiếp tục với direct input...');
    } else {
      log('[Trial] ✓ Stripe form đã sẵn sàng');
      await sleep(1000); // Thêm buffer để Stripe hoàn toàn sẵn sàng
    }

    // ============ BƯỚC 6: LOOP RETRY — gen thẻ, điền form, submit ============
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      log(`[Trial] ═══ Lần thử ${attempt}/${maxRetry} ═══`);

      // 6a. Generate card
      const cardNumber = generateCardFromBin(binList);
      const cardExpiry = generateExpiry();
      const cardCvc = generateCvc();
      const billingName = generateBillingName();
      const address = getRandomAddress(countryCode);

      log(`[Trial] Card: ${cardNumber.substring(0, 6)}****${cardNumber.slice(-4)} | Exp: ${cardExpiry.formatted} | Name: ${billingName}`);
      log(`[Trial] Address: ${address.street}, ${address.city}, ${address.state} ${address.zip}`);

      // 6b. Chọn tab "Thẻ" / "Card"
      for (const el of document.querySelectorAll('button, [role="tab"], label, div[role="option"], div[class*="Tab"], span')) {
        const text = el.textContent.trim().toLowerCase();
        if ((text === 'thẻ' || text === 'card' || text === '카드' || text.includes('credit') || text.includes('debit')) &&
            el.getBoundingClientRect().width > 0) {
          try {
            el.click();
            // FIX: Chờ lâu hơn sau khi chọn tab Card để Stripe iframe render
            await sleep(2000);
            log('[Trial] ✓ Đã chọn tab Thẻ');
          } catch (_) {}
          break;
        }
      }

      // 6c. Điền card number
      log('[Trial] Điền số thẻ...');
      const cardFilled = await fillCardField([
        'input[name="cardnumber"]', 'input[name="number"]',
        'input[autocomplete="cc-number"]',
        'input[placeholder*="Card number"]', 'input[placeholder*="card number"]',
        'input[placeholder*="Số thẻ"]', 'input[placeholder*="số thẻ"]',
        'input[placeholder*="카드 번호"]',
        'input[placeholder*="0000"]',
        'input[id*="cardNumber"]', 'input[id*="card-number"]',
      ], cardNumber, 'cardNumber');
      await sleep(800);

      // 6d. Điền expiry
      log('[Trial] Điền ngày hết hạn...');
      // FIX: Thử format compact (MMYY) trước — Stripe thường nhận tốt hơn
      const expFilled = await fillCardField([
        'input[name="exp-date"]', 'input[name="expirationDate"]',
        'input[autocomplete="cc-exp"]',
        'input[placeholder*="MM / YY"]', 'input[placeholder*="MM/YY"]',
        'input[placeholder*="Ngày hết hạn"]', 'input[placeholder*="만료일"]',
        'input[id*="cardExpiry"]', 'input[id*="expiry"]',
      ], cardExpiry.compact, 'expiry');

      // Nếu compact không điền được, thử formatted
      if (!expFilled) {
        await fillCardField([
          'input[name="exp-date"]', 'input[autocomplete="cc-exp"]',
          'input[placeholder*="MM / YY"]',
        ], cardExpiry.formatted, 'expiry');
      }
      await sleep(800);

      // 6e. Điền CVC
      log('[Trial] Điền mã bảo mật...');
      await fillCardField([
        'input[name="cvc"]', 'input[name="securityCode"]',
        'input[autocomplete="cc-csc"]',
        'input[placeholder*="CVC"]', 'input[placeholder*="Mã bảo mật"]',
        'input[placeholder*="보안 코드"]',
        'input[id*="cardCvc"]', 'input[id*="cvc"]',
      ], cardCvc, 'cvc');
      await sleep(800);

      // 6f. Điền Họ và tên
      log('[Trial] Điền họ và tên...');
      const nameInput = findVisibleInput([
        'input[name="name"]', 'input[name="billingName"]',
        'input[autocomplete="name"]', 'input[autocomplete="cc-name"]',
        'input[placeholder*="Họ và tên"]', 'input[placeholder*="Full name"]',
        'input[placeholder*="Name on card"]', 'input[placeholder*="이름"]',
        'input[id*="name"]', 'input[id*="billingName"]',
      ]);
      if (nameInput) {
        await humanType(nameInput, billingName);
        log(`[Trial] ✓ Đã điền tên: ${billingName}`);
      }
      await sleep(800);

      // 6g. Chọn Quốc gia
      log('[Trial] Chọn quốc gia...');
      const countryNames = {
        US: ['United States', 'Hoa Kỳ', 'Mỹ', 'US', '미국'],
        JP: ['Japan', 'Nhật Bản', 'JP', '일본'],
        KR: ['South Korea', 'Korea', 'Hàn Quốc', 'KR', '한국', '대한민국'],
        GB: ['United Kingdom', 'Vương quốc Anh', 'UK', 'GB', '영국'],
        AU: ['Australia', 'Úc', 'AU', '호주'],
        CA: ['Canada', 'CA', '캐나다'],
      };
      const countryAliases = countryNames[countryCode] || [countryCode];

      const countrySelects = document.querySelectorAll('select');
      for (const sel of countrySelects) {
        if (!sel.offsetParent || sel.getBoundingClientRect().width === 0) continue;
        const info = (sel.name + sel.id + sel.className +
          (sel.previousElementSibling?.textContent || '') +
          (sel.closest('label')?.textContent || '') +
          (sel.closest('div')?.querySelector('label')?.textContent || '')).toLowerCase();
        if (info.includes('country') || info.includes('quốc gia') || info.includes('khu vực') ||
            info.includes('region') || info.includes('국가')) {
          const options = Array.from(sel.options);
          for (const alias of countryAliases) {
            const opt = options.find(o =>
              o.text.toLowerCase().includes(alias.toLowerCase()) ||
              o.value.toLowerCase() === countryCode.toLowerCase() ||
              o.value.toLowerCase() === alias.toLowerCase()
            );
            if (opt) {
              setSelectValue(sel, opt.value);
              log(`[Trial] ✓ Đã chọn quốc gia: ${opt.text}`);
              break;
            }
          }
          break;
        }
      }
      await sleep(2000);

      // 6h. Chọn Do Si / State
      log('[Trial] Chọn Do Si / State...');
      const stateSelects = document.querySelectorAll('select');
      for (const sel of stateSelects) {
        if (!sel.offsetParent || sel.getBoundingClientRect().width === 0) continue;
        const info = (sel.name + sel.id + sel.className +
          (sel.previousElementSibling?.textContent || '') +
          (sel.closest('label')?.textContent || '') +
          (sel.closest('div')?.querySelector('label')?.textContent || '')).toLowerCase();
        const isCountry = info.includes('country') || info.includes('quốc gia') || info.includes('국가');
        const isState = info.includes('state') || info.includes('province') || info.includes('region') ||
          info.includes('do si') || info.includes('도') || info.includes('주') || info.includes('prefecture') ||
          info.includes('administrative') || info.includes('도/시');
        if (isState && !isCountry) {
          const selected = selectDropdownOption(sel, address.state);
          if (selected) log(`[Trial] ✓ Đã chọn Do Si: ${address.state}`);
          else log(`[Trial] ⚠ Không tìm thấy Do Si "${address.state}", đã chọn random`);
          break;
        }
      }
      await sleep(1500);

      // 6i. Điền Thành phố
      log('[Trial] Điền thành phố...');
      const cityInput = findVisibleInput([
        'input[name="city"]', 'input[name="locality"]',
        'input[autocomplete="address-level2"]',
        'input[placeholder*="Thành phố"]', 'input[placeholder*="City"]',
        'input[placeholder*="Town"]', 'input[placeholder*="도시"]', 'input[placeholder*="시"]',
        'input[id*="city"]', 'input[id*="locality"]',
      ]);
      if (cityInput) {
        await humanType(cityInput, address.city);
        log(`[Trial] ✓ Đã điền thành phố: ${address.city}`);
      }
      await sleep(500);

      // 6j. Điền Dòng địa chỉ 1
      log('[Trial] Điền địa chỉ...');
      const addr1Input = findVisibleInput([
        'input[name="addressLine1"]', 'input[name="line1"]', 'input[name="address"]',
        'input[autocomplete="address-line1"]',
        'input[placeholder*="Dòng địa chỉ"]', 'input[placeholder*="Address line"]',
        'input[placeholder*="Street address"]', 'input[placeholder*="Địa chỉ"]',
        'input[placeholder*="주소"]',
        'input[id*="addressLine1"]', 'input[id*="address1"]', 'input[id*="line1"]',
      ]);
      if (addr1Input) {
        await humanType(addr1Input, address.street);
        log(`[Trial] ✓ Đã điền địa chỉ: ${address.street}`);
        await sleep(300);
        try { addr1Input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
      }
      await sleep(500);

      // 6k. Điền Mã bưu chính
      log('[Trial] Điền mã bưu chính...');
      const zipInput = findVisibleInput([
        'input[name="postalCode"]', 'input[name="zip"]', 'input[name="postal"]',
        'input[autocomplete="postal-code"]',
        'input[placeholder*="Mã bưu"]', 'input[placeholder*="Zip"]',
        'input[placeholder*="Postal"]', 'input[placeholder*="mã bưu chính"]',
        'input[placeholder*="우편번호"]',
        'input[id*="postalCode"]', 'input[id*="zip"]',
      ]);
      if (zipInput) {
        await humanType(zipInput, address.zip);
        log(`[Trial] ✓ Đã điền mã bưu chính: ${address.zip}`);
      }
      await sleep(1000);

      // ============ BƯỚC 7: Click "Đăng ký" / "Subscribe" ============
      log('[Trial] Bấm nút Đăng ký...');
      const submitTexts = ['đăng ký', 'subscribe', 'start trial', 'bắt đầu dùng thử',
        'confirm', 'xác nhận', 'pay', 'thanh toán', 'submit', '구독', '등록'];
      let submitBtn = null;
      for (const btn of document.querySelectorAll('button')) {
        const text = btn.textContent.trim().toLowerCase();
        if (submitTexts.some(t => text.includes(t)) && btn.getBoundingClientRect().width > 0 && !btn.disabled) {
          submitBtn = btn;
          break;
        }
      }
      if (!submitBtn) submitBtn = document.querySelector('button[type="submit"]:not([disabled])');

      if (submitBtn) {
        submitBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(500);
        await humanClick(submitBtn);
        log('[Trial] ✓ Đã click Đăng ký');
      } else {
        log('[Trial] ✗ Không tìm thấy nút Đăng ký');
      }

      // ============ BƯỚC 8: Xử lý hCaptcha ============
      await sleep(3000);

      const hasCaptcha = document.querySelector('iframe[src*="hcaptcha"]') ||
        document.querySelector('.h-captcha') ||
        document.querySelector('[data-hcaptcha-widget-id]') ||
        (document.body.textContent || '').toLowerCase().includes('tôi là con người') ||
        (document.body.textContent || '').toLowerCase().includes('i am human');

      if (hasCaptcha) {
        log('[Trial] Phát hiện hCaptcha, đang xử lý...');
        const captchaSolved = await solveHCaptcha(captchaService, captchaApiKey);
        if (captchaSolved) {
          log('[Trial] ✓ Captcha đã giải xong');
          await sleep(1000);
          if (submitBtn && submitBtn.getBoundingClientRect().width > 0) {
            await humanClick(submitBtn);
            log('[Trial] Đã click Đăng ký lần nữa sau captcha');
          }
        } else {
          log('[Trial] ✗ Captcha chưa giải được');
        }
      }

      // ============ BƯỚC 9: Chờ kết quả ============
      log('[Trial] Chờ kết quả...');
      let success = false;
      let cardError = false;

      for (let w = 0; w < 20; w++) {
        await sleep(2000);

        const url = window.location.href;
        const pageText = (document.body?.textContent || '').toLowerCase();

        // Thành công: redirect về trang chính
        if ((url.includes('chatgpt.com') || url.includes('chat.openai.com')) &&
            !url.includes('#pricing') && !url.includes('/checkout') &&
            !url.includes('payment') && !url.includes('billing')) {
          // FIX: Kiểm tra thêm — trang phải có dấu hiệu của ChatGPT chính, không phải trang lỗi
          const hasSuccessSign = pageText.includes('chatgpt') || pageText.includes('new chat') ||
            pageText.includes('chat mới') || document.querySelector('[data-testid="send-button"]') ||
            document.querySelector('textarea[placeholder*="Message"]');
          if (hasSuccessSign) {
            log('[Trial] ✓✓✓ Trial Plus THÀNH CÔNG! Đã quay về trang chính');
            for (const el of document.querySelectorAll('button')) {
              const t = el.textContent.trim().toLowerCase();
              if (['okay', "let's go", 'bắt đầu', 'got it', 'đóng', 'close', '확인', '시작'].includes(t)) {
                try { el.click(); } catch (_) {}
                break;
              }
            }
            success = true;
            break;
          }
        }

        // Kiểm tra lỗi thẻ
        const errorEls = document.querySelectorAll('[class*="error"], [role="alert"], .StripeElement--invalid, [class*="Error"]');
        for (const errEl of errorEls) {
          if (errEl.getBoundingClientRect().width === 0) continue;
          const t = (errEl.textContent || '').toLowerCase();
          if (t.includes('declined') || t.includes('từ chối') || t.includes('invalid') ||
              t.includes('không hợp lệ') || t.includes('insufficient') || t.includes('failed') ||
              t.includes('thất bại') || t.includes('thẻ') || t.includes('card') ||
              t.includes('거부') || t.includes('유효하지') || t.includes('실패')) {
            log(`[Trial] ✗ Lỗi thẻ: ${errEl.textContent.trim().substring(0, 100)}`);
            cardError = true;
            break;
          }
        }
        if (cardError) break;

        const spinner = document.querySelector('.spinner, [class*="loading"], [class*="processing"]');
        if (spinner && spinner.getBoundingClientRect().width > 0) {
          log('[Trial] Đang xử lý thanh toán...');
        }
      }

      if (success) {
        sendBG('REG_STEP_DONE', { step: '[Trial] ✓ Trial Plus thành công!' });
        return true;
      }

      if (cardError && attempt < maxRetry) {
        log(`[Trial] Thẻ bị từ chối, gen thẻ mới và thử lại (${attempt}/${maxRetry})...`);

        // FIX: Reset Stripe fields đúng cách — xóa và chờ trước khi điền lại
        for (const sel of [
          'input[name="cardnumber"]', 'input[name="number"]', 'input[autocomplete="cc-number"]',
          'input[name="exp-date"]', 'input[autocomplete="cc-exp"]',
          'input[name="cvc"]', 'input[autocomplete="cc-csc"]'
        ]) {
          const f = document.querySelector(sel);
          if (f && f.offsetParent) {
            f.focus();
            setInputValue(f, '');
            // Gửi Ctrl+A rồi Delete để xóa sạch
            f.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
            await sleep(100);
            f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
            await sleep(200);
          }
        }

        // FIX: Chờ Stripe reset (quan trọng — không chờ đủ sẽ không điền được lần sau)
        await sleep(2000);

        // FIX: Chờ Stripe iframe sẵn sàng lại
        await waitForStripeIframe(10000);
        await sleep(1000);

        continue;
      }

      if (!success && !cardError) {
        log('[Trial] Timeout chờ kết quả, có thể cần kiểm tra thủ công');
        break;
      }
    }

    log('[Trial] ✗ Trial Plus thất bại sau tất cả lần thử');
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  // MESSAGE LISTENER — PING + EXEC_TRIAL
  // ══════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ pong: true, trialReady: true });
      return;
    }

    if (msg.type === 'EXEC_TRIAL') {
      log('[Trial] Nhận lệnh Trial Plus từ popup');
      runTrialPlus(msg).then(ok => {
        log(`[Trial] Kết quả: ${ok ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
        sendResponse({ success: true, result: ok });
      }).catch(e => {
        log(`[Trial] Lỗi: ${e.message}`);
        sendResponse({ success: false, error: e.message });
      });
      return true; // async response
    }
  });

  console.log('[AutoReg] trial.js v2.0.0 loaded — EXEC_TRIAL listener ready');
})();
