/**
 * email_providers.js — Các email provider cho extension
 *
 * v3.0 — Viết lại hoàn toàn phần DongVanFB
 *
 * Providers:
 *   1. MailTmProvider              — Tạo email tạm qua api.mail.tm (giữ nguyên)
 *   2. HotmailDongVanProvider      — Hotmail clone + lấy OTP qua dongvanfb.net
 *                                    ĐÃ VIẾT LẠI: dùng getDongVanFB_OTP() mới
 *                                    với retry logic, fallback endpoints, logging chi tiết
 *   3. DongVanMailDomainProvider   — TẠO MỚI: Mail tạm qua dongvanfb.net
 *                                    (dropmail / mailtm / 10minutemail) + polling OTP
 *
 * Architecture:
 *   - fetchOtpOnce(): gọi API 1 lần, trả kết quả ngay (không polling)
 *   - Polling loop nằm ở content.js
 *   - KHÔNG tự bỏ qua code — để content.js quyết định dựa trên failedCodes set
 */

import { getDongVanFB_OTP, parseHotmailString } from './dongvanfb_otp.js';

// ── Helpers ───────────────────────────────────────────────────────────

function randomStr(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Extract OTP từ text (dùng cho MailTm và DongVanMailDomain)
 * Hỗ trợ 4-8 digits
 */
function extractOtpFromText(text) {
  if (!text) return null;
  const patterns = [
    /(?:code|mã|verify)[:\s]*(\d{4,8})/i,
    /(\d{4,8})\s*(?:is your|là mã)/i,
    /(?:verification|xác minh)[:\s]*(\d{4,8})/i,
    /\b(\d{6})\b/,
    /\b(\d{5})\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════
//  1. MailTm Provider (giữ nguyên — hoạt động tốt)
// ═════════════════════════════════════════════════════════════════════════

export class MailTmProvider {
  constructor() {
    this.baseUrl = 'https://api.mail.tm';
    this._token = null;
    this._email = null;
    this._accountId = null;
  }

  async createEmail() {
    try {
      const domainsRes = await fetch(`${this.baseUrl}/domains?page=1`);
      const domainsData = await domainsRes.json();
      const domains = domainsData['hydra:member'] || [];
      if (!domains.length) throw new Error('Không lấy được domain mail.tm');
      const domain = domains[0].domain;

      const username = randomStr(12);
      const password = randomStr(16) + 'A1!';
      const email = `${username}@${domain}`;

      const createRes = await fetch(`${this.baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: email, password }),
      });
      if (!createRes.ok) throw new Error(`Tạo email thất bại: ${createRes.status}`);

      const tokenRes = await fetch(`${this.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: email, password }),
      });
      const tokenData = await tokenRes.json();
      this._token = tokenData.token;
      this._email = email;
      this._accountId = tokenData.id;

      return { email, password, provider: 'mailtm' };
    } catch (e) {
      console.error('[MailTm] createEmail error:', e);
      throw e;
    }
  }

  async fetchOtpOnce() {
    if (!this._token) throw new Error('Chưa tạo email');
    try {
      const res = await fetch(`${this.baseUrl}/messages?page=1`, {
        headers: { Authorization: `Bearer ${this._token}` },
      });
      const data = await res.json();
      const messages = data['hydra:member'] || [];

      for (const msg of messages) {
        if (msg.from?.address?.includes('openai') ||
            msg.subject?.toLowerCase().includes('verify') ||
            msg.subject?.toLowerCase().includes('confirm') ||
            msg.subject?.toLowerCase().includes('code')) {
          const fullRes = await fetch(`${this.baseUrl}/messages/${msg.id}`, {
            headers: { Authorization: `Bearer ${this._token}` },
          });
          const fullMsg = await fullRes.json();
          const body = fullMsg.text || fullMsg.html || '';
          const otp = extractOtpFromText(body);
          if (otp) return otp;
        }
      }
    } catch (e) {
      console.warn('[MailTm] fetchOtpOnce error:', e);
    }
    return null;
  }

  async cleanup() {
    if (this._accountId && this._token) {
      try {
        await fetch(`${this.baseUrl}/accounts/${this._accountId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this._token}` },
        });
      } catch (_) {}
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  2. Hotmail Đồng Văn Provider — VIẾT LẠI HOÀN TOÀN
// ═════════════════════════════════════════════════════════════════════════
/**
 * Provider cho Hotmail/Outlook clone.
 * Sử dụng getDongVanFB_OTP() mới với:
 *   - Retry logic 3 lần khi network error
 *   - Fallback: get_code_oauth2 (microsoft) → get_code_oauth2 (openai) → graph_code
 *   - Logging chi tiết [DONGVANFB_OTP]
 */
export class HotmailDongVanProvider {
  /**
   * @param {Array} accounts — Mảng {email, password, refreshToken, clientId}
   * @param {string} apiKey  — API key dongvanfb.net
   */
  constructor(accounts = [], apiKey = '') {
    this._accounts = accounts;
    this._apiKey = apiKey;
    this._index = 0;
  }

  /**
   * Load danh sách tài khoản từ mảng dòng text
   * Format mỗi dòng: email|password|refreshToken|clientId
   */
  loadAccounts(lines) {
    this._accounts = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try {
        const parsed = parseHotmailString(trimmed);
        this._accounts.push(parsed);
      } catch (_e) {
        // Fallback: parse thủ công nếu parseHotmailString yêu cầu 4 phần
        const parts = trimmed.split('|');
        if (parts.length >= 2) {
          this._accounts.push({
            email: parts[0].trim(),
            password: parts[1].trim(),
            refreshToken: parts[2]?.trim() || '',
            clientId: parts[3]?.trim() || '',
          });
        } else {
          console.warn(`[HotmailDV] Bỏ qua dòng không hợp lệ: ${trimmed.substring(0, 50)}`);
        }
      }
    }
    return this._accounts.length;
  }

  /**
   * Lấy tài khoản tiếp theo (round-robin)
   */
  _getNext() {
    if (!this._accounts.length) throw new Error('Không có tài khoản Hotmail');
    const acc = this._accounts[this._index % this._accounts.length];
    this._index++;
    return acc;
  }

  /**
   * Tạo email — trả về thông tin tài khoản hotmail tiếp theo
   */
  async createEmail() {
    const acc = this._getNext();
    return {
      email: acc.email,
      password: acc.password,
      provider: 'hotmail_dongvan',
      _hotmailAcc: acc,
    };
  }

  /**
   * Gọi API 1 LẦN DUY NHẤT để lấy OTP — trả về ngay
   * KHÔNG tự bỏ qua code — content.js sẽ quyết định
   *
   * ĐÃ VIẾT LẠI: Sử dụng getDongVanFB_OTP() mới
   *
   * @param {Object} hotmailAcc — {email, password, refreshToken, clientId}
   * @returns {{ otp: string|null, error: string|null }}
   */
  async fetchOtpOnce(hotmailAcc) {
    const { email, password, refreshToken, clientId } = hotmailAcc;

    console.log(`[HotmailDV] fetchOtpOnce cho ${email}`);

    // Kiểm tra thông tin bắt buộc
    if (!refreshToken || !clientId) {
      const msg = `Thiếu refreshToken hoặc clientId cho ${email}. Format: email|password|refreshToken|clientId`;
      console.error(`[HotmailDV] ${msg}`);
      return { otp: null, error: msg };
    }

    try {
      // Xây dựng hotmailString từ account object
      const hotmailString = `${email}|${password || ''}|${refreshToken}|${clientId}`;

      // Gọi hàm getDongVanFB_OTP mới — đã có retry logic, fallback, logging
      const result = await getDongVanFB_OTP({
        apikey: this._apiKey,
        mode: 'hotmail',
        hotmailString: hotmailString,
      });

      console.log(`[HotmailDV] getDongVanFB_OTP result: success=${result.success}, otp=${result.otp || 'null'}`);

      if (result.success && result.otp) {
        return { otp: result.otp, error: null };
      }

      // Không có OTP nhưng cũng không có lỗi nghiêm trọng → trả null để content.js polling tiếp
      return {
        otp: null,
        error: result.error || null,
      };

    } catch (e) {
      console.error(`[HotmailDV] fetchOtpOnce exception: ${e.message}`);
      return { otp: null, error: e.message };
    }
  }

  async cleanup() {
    // Hotmail không cần cleanup
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  3. DongVan Mail Domain Provider — MỚI HOÀN TOÀN
// ═════════════════════════════════════════════════════════════════════════
/**
 * Provider tạo mail tạm qua dongvanfb.net API.
 * Hỗ trợ 3 loại: dropmail, mailtm, 10minutemail
 *
 * Flow:
 *   1. createEmail() → gọi API tạo mail → trả email address
 *   2. fetchOtpOnce() → gọi API đọc OTP 1 lần → trả OTP hoặc null
 *      (content.js sẽ gọi fetchOtpOnce() nhiều lần trong polling loop)
 */
export class DongVanMailDomainProvider {
  /**
   * @param {string} apiKey   — API key dongvanfb.net
   * @param {string} mailType — "dropmail" | "mailtm" | "10minutemail"
   */
  constructor(apiKey = '', mailType = 'dropmail') {
    this._apiKey = apiKey;
    this._mailType = mailType;
    this._email = null;
  }

  /**
   * Tạo email tạm qua dongvanfb.net
   * GET https://api.dongvanfb.net/user/create_mail_domain?apikey=...&type=...
   */
  async createEmail() {
    console.log(`[DongVanMail] Tạo mail tạm (type=${this._mailType})...`);

    const url =
      `https://api.dongvanfb.net/user/create_mail_domain` +
      `?apikey=${encodeURIComponent(this._apiKey)}` +
      `&type=${encodeURIComponent(this._mailType)}`;

    // Retry tối đa 3 lần khi network error
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[DongVanMail] Tạo mail attempt ${attempt}/3...`);
        const res = await fetch(url);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${errText.substring(0, 200)}`);
        }

        const data = await res.json();
        console.log('[DongVanMail] Response tạo mail:', JSON.stringify(data).substring(0, 300));

        // Kiểm tra API status
        if (data.status === false || data.success === false) {
          throw new Error(`API error: ${data.message || data.msg || data.error || 'status=false'}`);
        }

        // Lấy email từ response
        const email = data.email || data.mail || data.data?.email;
        if (!email) {
          throw new Error('Không tìm thấy email trong response');
        }

        this._email = email;
        console.log(`[DongVanMail] Tạo mail thành công: ${email}`);

        return {
          email: email,
          password: '',
          provider: 'dongvan_maildomain',
        };

      } catch (e) {
        lastError = e;
        console.warn(`[DongVanMail] Tạo mail attempt ${attempt}/3 thất bại: ${e.message}`);
        if (attempt < 3) {
          const waitMs = 1000 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }

    throw new Error(`[DongVanMail] Không thể tạo mail sau 3 lần thử: ${lastError?.message}`);
  }

  /**
   * Gọi API 1 LẦN để đọc OTP — trả về ngay
   * GET https://api.dongvanfb.net/user/get_code_mail_domain?apikey=...&email=...
   *
   * Content.js sẽ gọi hàm này nhiều lần (polling loop mỗi 5 giây)
   *
   * @returns {string|null} — Mã OTP hoặc null nếu chưa có
   */
  async fetchOtpOnce() {
    if (!this._email) throw new Error('Chưa tạo email');

    const url =
      `https://api.dongvanfb.net/user/get_code_mail_domain` +
      `?apikey=${encodeURIComponent(this._apiKey)}` +
      `&email=${encodeURIComponent(this._email)}`;

    try {
      console.log(`[DongVanMail] Đọc OTP cho ${this._email}...`);
      const res = await fetch(url);

      if (!res.ok) {
        console.warn(`[DongVanMail] HTTP ${res.status} khi đọc OTP`);
        return null;
      }

      const data = await res.json();
      console.log('[DongVanMail] Response OTP:', JSON.stringify(data).substring(0, 300));

      // Kiểm tra status
      if (data.status === false && !data.code && !data.otp) {
        console.log('[DongVanMail] Chưa có OTP (status=false)');
        return null;
      }

      // Trích xuất OTP từ nhiều trường có thể
      // Ưu tiên: code → otp → content → message
      if (data.code !== undefined && data.code !== null) {
        const code = String(data.code).trim();
        if (/^\d{4,8}$/.test(code) && code !== '0') {
          console.log(`[DongVanMail] Tìm thấy OTP: ${code}`);
          return code;
        }
      }

      if (data.otp !== undefined && data.otp !== null) {
        const otp = String(data.otp).trim();
        if (/^\d{4,8}$/.test(otp) && otp !== '0') {
          console.log(`[DongVanMail] Tìm thấy OTP (trường otp): ${otp}`);
          return otp;
        }
      }

      // Thử trích xuất từ content/message bằng regex
      const textFields = [data.content, data.message, data.msg, data.data?.code];
      for (const text of textFields) {
        if (text && typeof text === 'string') {
          const extracted = extractOtpFromText(text);
          if (extracted) {
            console.log(`[DongVanMail] Trích xuất OTP từ text: ${extracted}`);
            return extracted;
          }
        }
      }

      console.log('[DongVanMail] Chưa có OTP');
      return null;

    } catch (e) {
      console.warn(`[DongVanMail] fetchOtpOnce error: ${e.message}`);
      return null;
    }
  }

  async cleanup() {
    // Mail tạm tự hết hạn, không cần cleanup
    console.log(`[DongVanMail] Cleanup: mail ${this._email} sẽ tự hết hạn`);
  }
}
