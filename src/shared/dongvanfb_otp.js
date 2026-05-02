/**
 * ============================================================================
 *  getDongVanFB_OTP(config) — Lấy OTP từ DONGVANFB API
 * ============================================================================
 *
 *  Tác giả   : AutoReg Pro
 *  Phiên bản : 3.1.0
 *  Ngày      : 2026-03-30
 *
 *  Mô tả:
 *    Hàm async độc lập lấy mã OTP (verification code) từ dịch vụ DONGVANFB.
 *    Hỗ trợ 2 chế độ:
 *      1. "maildomain" — Tạo mail tạm (dropmail / mailtm / 10minutemail) rồi polling lấy OTP
 *      2. "hotmail"    — Dùng mail clone Outlook/Hotmail, gọi API lấy OTP qua OAuth2/Graph
 *
 *  Yêu cầu kỹ thuật:
 *    - Chỉ dùng fetch thuần (không thư viện ngoài)
 *    - Tương thích 100% với Manifest V3 background service worker
 *    - Retry logic tối đa 2 lần khi network error (giảm từ 3)
 *    - Polling timeout: 35 giây (mode maildomain, giảm từ 50)
 *    - Hotmail: gọi song song 2 endpoint oauth2 để tăng tốc
 *    - Thêm AbortController timeout 10s cho mỗi fetch request
 *    - Logging rõ ràng với prefix [DONGVANFB_OTP]
 *    - Comment tiếng Việt đầy đủ
 *
 *  Cấu trúc config:
 *    {
 *      apikey:        string,                                    // API key DONGVANFB
 *      mode:          "maildomain" | "hotmail",                  // Chế độ hoạt động
 *      mailType:      "dropmail" | "mailtm" | "10minutemail",   // Chỉ dùng khi mode = "maildomain"
 *      hotmailString: "email|password|refresh_token|client_id"   // Chỉ dùng khi mode = "hotmail"
 *    }
 *
 *  Kết quả trả về (Promise):
 *    {
 *      success:       boolean,
 *      email?:        string,        // Email đã dùng
 *      otp?:          string,        // Mã OTP lấy được
 *      error?:        string,        // Mô tả lỗi (nếu có)
 *      fullResponse?: object         // Response gốc từ API (để debug)
 *    }
 *
 * ============================================================================
 *
 *  VÍ DỤ SỬ DỤNG:
 *
 *  // ── Chế độ 1: Mail tạm (maildomain) ──────────────────────────────────
 *  const result1 = await getDongVanFB_OTP({
 *    apikey: "YOUR_DONGVANFB_API_KEY",
 *    mode: "maildomain",
 *    mailType: "dropmail"
 *  });
 *  console.log(result1);
 *  // → { success: true, email: "abc123@dropmail.me", otp: "482917", fullResponse: {...} }
 *
 *  // ── Chế độ 2: Hotmail clone ──────────────────────────────────────────
 *  const result2 = await getDongVanFB_OTP({
 *    apikey: "YOUR_DONGVANFB_API_KEY",
 *    mode: "hotmail",
 *    hotmailString: "abc@hotmail.com|pass123|1//04xYz...|123456789"
 *  });
 *  console.log(result2);
 *  // → { success: true, email: "abc@hotmail.com", otp: "739201", fullResponse: {...} }
 *
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: sleep — Tạm dừng thực thi trong khoảng thời gian chỉ định (ms)
// ─────────────────────────────────────────────────────────────────────────────

function _dvfb_sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: parseHotmailString — Tách chuỗi hotmail thành 4 phần
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parse chuỗi dạng "email|password|refresh_token|client_id"
 *
 * @param {string} str — Chuỗi đầu vào, phân cách bằng dấu "|"
 * @returns {{ email: string, password: string, refreshToken: string, clientId: string }}
 * @throws {Error} nếu chuỗi không đúng format (thiếu phần)
 *
 * Ví dụ:
 *   parseHotmailString("abc@hotmail.com|pass123|1//04xYz...|123456789")
 *   → { email: "abc@hotmail.com", password: "pass123", refreshToken: "1//04xYz...", clientId: "123456789" }
 */
function parseHotmailString(str) {
  if (!str || typeof str !== 'string') {
    throw new Error('[DONGVANFB_OTP] hotmailString không hợp lệ: chuỗi rỗng hoặc không phải string');
  }

  const parts = str.trim().split('|');

  // Kiểm tra phải có ít nhất 4 phần
  if (parts.length < 4) {
    throw new Error(
      `[DONGVANFB_OTP] hotmailString không đúng format. ` +
      `Cần ít nhất 4 phần (email|password|refresh_token|client_id), ` +
      `nhưng chỉ có ${parts.length} phần: "${str.substring(0, 80)}..."`
    );
  }

  const email = parts[0].trim();
  const password = parts[1].trim();
  // refresh_token có thể chứa ký tự đặc biệt, KHÔNG trim quá mức
  const refreshToken = parts[2].trim();
  const clientId = parts[3].trim();

  // Validate email cơ bản
  if (!email.includes('@')) {
    throw new Error(`[DONGVANFB_OTP] Email không hợp lệ: "${email}"`);
  }

  // Validate refresh_token không rỗng
  if (!refreshToken) {
    throw new Error(`[DONGVANFB_OTP] refresh_token rỗng cho email: ${email}`);
  }

  // Validate client_id không rỗng
  if (!clientId) {
    throw new Error(`[DONGVANFB_OTP] client_id rỗng cho email: ${email}`);
  }

  console.log(
    `[DONGVANFB_OTP] Parse hotmail thành công: email=${email}, ` +
    `refreshToken=${refreshToken.substring(0, 15)}..., clientId=${clientId}`
  );

  return { email, password, refreshToken, clientId };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: fetchWithRetry — Gọi fetch với retry logic khi network error
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Wrapper quanh fetch() với khả năng tự động retry khi gặp network error.
 * CHỈ retry khi lỗi mạng (TypeError / fetch failed), KHÔNG retry khi HTTP 4xx/5xx.
 *
 * @param {string} url         — URL cần gọi
 * @param {object} options     — fetch options (method, headers, body, ...)
 * @param {number} maxRetries  — Số lần retry tối đa (mặc định: 3)
 * @returns {Promise<Response>} — fetch Response object
 * @throws {Error} nếu tất cả retry đều thất bại
 */
async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `[DONGVANFB_OTP] fetch attempt ${attempt}/${maxRetries}: ` +
        `${options.method || 'GET'} ${url.substring(0, 100)}`
      );

      // v3.1.0: Thêm AbortController với timeout 10s để tránh treo vô hạn
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Fetch thành công (kể cả HTTP error status) → trả về response
      return response;

    } catch (err) {
      lastError = err;
      console.warn(
        `[DONGVANFB_OTP] fetch attempt ${attempt}/${maxRetries} FAILED: ${err.message}`
      );

      // v3.1.0: Giảm backoff: 1s, 2s (thay vì 1s, 2s, 4s)
      if (attempt < maxRetries) {
        const waitMs = Math.min(1000 * attempt, 3000);
        console.log(`[DONGVANFB_OTP] Chờ ${waitMs}ms trước khi retry...`);
        await _dvfb_sleep(waitMs);
      }
    }
  }

  // Tất cả retry đều thất bại
  throw new Error(
    `[DONGVANFB_OTP] Network error sau ${maxRetries} lần thử: ${lastError?.message || 'Unknown error'}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: extractOtpCode — Trích xuất mã OTP từ response data của DONGVANFB
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Trích xuất mã OTP từ response JSON của DONGVANFB API.
 * Thử nhiều trường khác nhau: data.code, data.otp, data.content, data.message
 *
 * @param {object} data — JSON response từ API
 * @returns {string|null} — Mã OTP (4-8 chữ số) hoặc null
 */
function extractOtpCode(data) {
  if (!data) return null;

  // ── Ưu tiên 1: Trường "code" trực tiếp ────────────────────────────
  if (data.code !== undefined && data.code !== null) {
    const code = String(data.code).trim();
    // Chỉ chấp nhận nếu là chuỗi số 4-8 ký tự và không phải "0"
    if (/^\d{4,8}$/.test(code) && code !== '0') {
      return code;
    }
  }

  // ── Ưu tiên 2: Trường "otp" trực tiếp ─────────────────────────────
  if (data.otp !== undefined && data.otp !== null) {
    const otp = String(data.otp).trim();
    if (/^\d{4,8}$/.test(otp) && otp !== '0') {
      return otp;
    }
  }

  // ── Ưu tiên 3: Trích xuất từ trường "content" bằng regex ──────────
  if (data.content && typeof data.content === 'string') {
    const extracted = _extractOtpFromText(data.content);
    if (extracted) return extracted;
  }

  // ── Ưu tiên 4: Trích xuất từ trường "message" bằng regex ──────────
  if (data.message && typeof data.message === 'string') {
    const extracted = _extractOtpFromText(data.message);
    if (extracted) return extracted;
  }

  // ── Ưu tiên 5: Trích xuất từ trường "data" (nested) ───────────────
  if (data.data && typeof data.data === 'object') {
    return extractOtpCode(data.data);
  }

  return null;
}

/**
 * Trích xuất mã OTP từ text tự do bằng regex patterns
 * Hỗ trợ nhiều format: "Your code is 123456", "Mã xác minh: 482917", v.v.
 *
 * @param {string} text — Nội dung text cần tìm OTP
 * @returns {string|null}
 */
function _extractOtpFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const patterns = [
    // Pattern 1: "code: 123456" hoặc "mã: 123456"
    /(?:code|mã|verify|verification)[:\s]+(\d{4,8})/i,
    // Pattern 2: "123456 is your code"
    /(\d{4,8})\s*(?:is your|là mã|is the)/i,
    // Pattern 3: "verification code: 123456"
    /(?:verification|xác minh|xác nhận)[:\s]+(\d{4,8})/i,
    // Pattern 4: "OTP: 123456"
    /(?:otp|one.time)[:\s]+(\d{4,8})/i,
    // Pattern 5: Tìm chuỗi 6 chữ số đứng riêng (phổ biến nhất cho OTP)
    /\b(\d{6})\b/,
    // Pattern 6: Tìm chuỗi 5 chữ số đứng riêng
    /\b(\d{5})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
//  HÀM CHÍNH: getDongVanFB_OTP(config)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Lấy OTP từ DONGVANFB API.
 *
 * @param {object} config — Cấu hình (xem mô tả ở đầu file)
 * @returns {Promise<{success: boolean, email?: string, otp?: string, error?: string, fullResponse?: object}>}
 */
async function getDongVanFB_OTP(config) {
  console.log('[DONGVANFB_OTP] ═══════════════════════════════════════════');
  console.log('[DONGVANFB_OTP] Bắt đầu lấy OTP...');

  // ── Validate config cơ bản (kiểm tra null/undefined TRƯỚC khi truy cập thuộc tính) ──
  if (!config || typeof config !== 'object') {
    return { success: false, error: '[DONGVANFB_OTP] Config object là null/undefined hoặc không phải object' };
  }

  console.log('[DONGVANFB_OTP] Config:', JSON.stringify({
    mode: config.mode,
    mailType: config.mailType || '(không dùng)',
    hasApiKey: !!config.apikey,
    hasHotmailString: !!config.hotmailString,
  }));

  if (!config.apikey || typeof config.apikey !== 'string') {
    return { success: false, error: '[DONGVANFB_OTP] Thiếu hoặc sai apikey' };
  }

  if (!config.mode || !['maildomain', 'hotmail'].includes(config.mode)) {
    return {
      success: false,
      error: `[DONGVANFB_OTP] mode không hợp lệ: "${config.mode}". Chỉ chấp nhận "maildomain" hoặc "hotmail"`
    };
  }

  // ── Dispatch theo mode ─────────────────────────────────────────────
  try {
    if (config.mode === 'maildomain') {
      return await _handleMailDomainMode(config);
    } else {
      return await _handleHotmailMode(config);
    }
  } catch (err) {
    console.error('[DONGVANFB_OTP] Lỗi không mong đợi:', err);
    return {
      success: false,
      error: `[DONGVANFB_OTP] Lỗi không mong đợi: ${err.message}`,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  CHẾ ĐỘ 1: MAILDOMAIN — Tạo mail tạm + polling lấy OTP
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Flow:
 *   1. Gọi API tạo mail tạm → nhận email address
 *   2. (Caller dùng email này để đăng ký ChatGPT)
 *   3. Polling API lấy OTP mỗi 3 giây, timeout 50 giây
 *
 * @param {object} config
 * @returns {Promise<{success: boolean, email?: string, otp?: string, error?: string, fullResponse?: object}>}
 */
async function _handleMailDomainMode(config) {
  const { apikey, mailType } = config;

  // ── Validate mailType ──────────────────────────────────────────────
  const validMailTypes = ['dropmail', 'mailtm', '10minutemail'];
  if (!mailType || !validMailTypes.includes(mailType)) {
    return {
      success: false,
      error: `[DONGVANFB_OTP] mailType không hợp lệ: "${mailType}". ` +
             `Chỉ chấp nhận: ${validMailTypes.join(', ')}`
    };
  }

  // ── Bước 1: Tạo mail tạm ──────────────────────────────────────────
  console.log(`[DONGVANFB_OTP] [MAILDOMAIN] Bước 1: Tạo mail tạm (type=${mailType})...`);

  const createMailUrl =
    `https://api.dongvanfb.net/user/create_mail_domain?apikey=${encodeURIComponent(apikey)}` +
    `&type=${encodeURIComponent(mailType)}`;

  let createMailData;
  try {
    const createRes = await fetchWithRetry(createMailUrl, { method: 'GET' }, 3);

    // Kiểm tra HTTP status
    if (!createRes.ok) {
      const errorText = await createRes.text().catch(() => '(không đọc được body)');
      return {
        success: false,
        error: `[DONGVANFB_OTP] Tạo mail thất bại — HTTP ${createRes.status}: ${errorText.substring(0, 200)}`,
        fullResponse: { httpStatus: createRes.status, body: errorText },
      };
    }

    createMailData = await createRes.json();
    console.log(
      '[DONGVANFB_OTP] [MAILDOMAIN] Response tạo mail:',
      JSON.stringify(createMailData).substring(0, 500)
    );

  } catch (err) {
    return {
      success: false,
      error: `[DONGVANFB_OTP] Lỗi khi tạo mail: ${err.message}`,
    };
  }

  // ── Kiểm tra response tạo mail ────────────────────────────────────
  // API DONGVANFB thường trả: { status: true/false, email: "...", message: "..." }
  if (!createMailData) {
    return {
      success: false,
      error: '[DONGVANFB_OTP] Response tạo mail rỗng (null/undefined)',
      fullResponse: createMailData,
    };
  }

  // Kiểm tra status === false (API trả lỗi logic)
  if (createMailData.status === false || createMailData.success === false) {
    return {
      success: false,
      error: `[DONGVANFB_OTP] API trả lỗi khi tạo mail: ${createMailData.message || createMailData.msg || createMailData.error || 'Không rõ lý do'}`,
      fullResponse: createMailData,
    };
  }

  // Lấy email từ response — thử nhiều trường có thể
  const email = createMailData.email || createMailData.mail || createMailData.data?.email || null;
  if (!email) {
    return {
      success: false,
      error: '[DONGVANFB_OTP] Không tìm thấy email trong response tạo mail',
      fullResponse: createMailData,
    };
  }

  console.log(`[DONGVANFB_OTP] [MAILDOMAIN] Email tạo thành công: ${email}`);

  // ── Bước 2: Polling lấy OTP ───────────────────────────────────────
  console.log('[DONGVANFB_OTP] [MAILDOMAIN] Bước 2: Bắt đầu polling lấy OTP...');

  const POLL_INTERVAL_MS = 2500;   // v3.1.0: Mỗi 2.5 giây (giảm từ 3s)
  const POLL_TIMEOUT_MS  = 35000;  // v3.1.0: Timeout 35 giây (giảm từ 50s)
  const pollStartTime = Date.now();
  let pollCount = 0;
  let lastFullResponse = null;

  const getCodeUrl =
    `https://api.dongvanfb.net/user/get_code_mail_domain?apikey=${encodeURIComponent(apikey)}` +
    `&email=${encodeURIComponent(email)}`;

  while (Date.now() - pollStartTime < POLL_TIMEOUT_MS) {
    pollCount++;
    const elapsed = Math.round((Date.now() - pollStartTime) / 1000);
    console.log(
      `[DONGVANFB_OTP] [MAILDOMAIN] Polling #${pollCount} (${elapsed}s/${POLL_TIMEOUT_MS / 1000}s)...`
    );

    try {
      // v3.1.0: Giảm retry polling từ 3 xuống 1 (đã có vòng lặp polling bên ngoài)
      const pollRes = await fetchWithRetry(getCodeUrl, { method: 'GET' }, 1);

      if (!pollRes.ok) {
        console.warn(
          `[DONGVANFB_OTP] [MAILDOMAIN] Polling HTTP error: ${pollRes.status}`
        );
        // Không return lỗi ngay — tiếp tục polling (có thể server tạm lỗi)
        await _dvfb_sleep(POLL_INTERVAL_MS);
        continue;
      }

      const pollData = await pollRes.json();
      lastFullResponse = pollData;

      console.log(
        `[DONGVANFB_OTP] [MAILDOMAIN] Polling response:`,
        JSON.stringify(pollData).substring(0, 500)
      );

      // ── Kiểm tra xem API đã trả OTP chưa ─────────────────────────
      // Trường hợp 1: API trả trực tiếp { status: true, code: "123456" }
      if (pollData.status === true || pollData.success === true) {
        const otp = extractOtpCode(pollData);
        if (otp) {
          console.log(`[DONGVANFB_OTP] [MAILDOMAIN] ĐÃ LẤY ĐƯỢC OTP: ${otp}`);
          return {
            success: true,
            email: email,
            otp: otp,
            fullResponse: pollData,
          };
        }
      }

      // Trường hợp 2: API trả status false nhưng có code (một số API lạ)
      const otpFromAny = extractOtpCode(pollData);
      if (otpFromAny) {
        console.log(`[DONGVANFB_OTP] [MAILDOMAIN] Tìm thấy OTP trong response: ${otpFromAny}`);
        return {
          success: true,
          email: email,
          otp: otpFromAny,
          fullResponse: pollData,
        };
      }

      // Trường hợp 3: Chưa có OTP → tiếp tục polling
      console.log('[DONGVANFB_OTP] [MAILDOMAIN] Chưa có OTP, chờ polling tiếp...');

    } catch (err) {
      // Network error sau 3 lần retry → log warning nhưng tiếp tục polling
      console.warn(
        `[DONGVANFB_OTP] [MAILDOMAIN] Polling error (tiếp tục): ${err.message}`
      );
    }

    // Chờ trước khi poll tiếp
    await _dvfb_sleep(POLL_INTERVAL_MS);
  }

  // ── Timeout — không lấy được OTP ──────────────────────────────────
  console.error(
    `[DONGVANFB_OTP] [MAILDOMAIN] TIMEOUT sau ${POLL_TIMEOUT_MS / 1000}s ` +
    `(${pollCount} lần polling). Không lấy được OTP cho ${email}`
  );

  return {
    success: false,
    email: email,
    error: `[DONGVANFB_OTP] Timeout ${POLL_TIMEOUT_MS / 1000}s — không nhận được OTP cho ${email}`,
    fullResponse: lastFullResponse,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  CHẾ ĐỘ 2: HOTMAIL — Lấy OTP từ mail clone Outlook/Hotmail
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Flow (v3.1.0):
 *   1. Parse hotmailString → email, password, refresh_token, client_id
 *   2. Gọi SONG SONG get_code_oauth2(microsoft) + get_code_oauth2(openai)
 *   3. Trả về OTP từ endpoint nào thành công trước
 *
 * @param {object} config
 * @returns {Promise<{success: boolean, email?: string, otp?: string, error?: string, fullResponse?: object}>}
 */
async function _handleHotmailMode(config) {
  // ── Bước 1: Parse hotmailString ────────────────────────────────────
  if (!config.hotmailString) {
    return {
      success: false,
      error: '[DONGVANFB_OTP] Thiếu hotmailString cho mode "hotmail"',
    };
  }

  let hotmailInfo;
  try {
    hotmailInfo = parseHotmailString(config.hotmailString);
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }

  const { email, refreshToken, clientId } = hotmailInfo;

  console.log(`[DONGVANFB_OTP] [HOTMAIL] Email: ${email}`);
  // v3.1.0: Gọi song song 2 endpoint oauth2 để tăng tốc
  console.log(`[DONGVANFB_OTP] [HOTMAIL] Bắt đầu lấy OTP (song song oauth2 microsoft + openai)...`);

  // Lưu tất cả errors để debug
  const errors = [];
  let lastFullResponse = null;

  // ══════════════════════════════════════════════════════════════════
  //  Phương pháp 1+2: Gọi SONG SONG oauth2(microsoft) + oauth2(openai)
  // ══════════════════════════════════════════════════════════════════
  console.log('[DONGVANFB_OTP] [HOTMAIL] ── Gọi song song: oauth2(microsoft) + oauth2(openai) ──');

  const [oauth2Result, oauth2FallbackResult] = await Promise.allSettled([
    _callOAuth2Endpoint(email, refreshToken, clientId, 'microsoft'),
    _callOAuth2Endpoint(email, refreshToken, clientId, 'openai'),
  ]);

  // Kiểm tra kết quả từ cả 2 endpoint — ưu tiên microsoft trước
  for (const result of [oauth2Result, oauth2FallbackResult]) {
    if (result.status === 'fulfilled' && result.value.otp) {
      return {
        success: true,
        email: email,
        otp: result.value.otp,
        fullResponse: result.value.fullResponse,
      };
    }
    if (result.status === 'fulfilled') {
      if (result.value.error) errors.push(result.value.error);
      if (result.value.fullResponse) lastFullResponse = result.value.fullResponse;
    } else {
      errors.push(result.reason?.message || 'Promise rejected');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  Cả 2 oauth2 đều thất bại
  // ══════════════════════════════════════════════════════════════════
  const combinedError = errors.length > 0
    ? errors.join(' | ')
    : 'Không lấy được OTP từ bất kỳ endpoint nào';

  console.error(`[DONGVANFB_OTP] [HOTMAIL] CẢ 2 OAUTH2 ĐỀU THẤT BẠI cho ${email}`);
  console.error(`[DONGVANFB_OTP] [HOTMAIL] Chi tiết lỗi: ${combinedError}`);

  return {
    success: false,
    email: email,
    error: `[DONGVANFB_OTP] Không lấy được OTP cho ${email}. Chi tiết: ${combinedError}`,
    fullResponse: lastFullResponse,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HOTMAIL SUB-FUNCTION: Gọi endpoint get_code_oauth2
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Gọi POST https://tools.dongvanfb.net/api/get_code_oauth2
 *
 * @param {string} email        — Email Hotmail/Outlook
 * @param {string} refreshToken — OAuth2 refresh token
 * @param {string} clientId     — OAuth2 client ID
 * @param {string} type         — "microsoft" hoặc "openai"
 * @returns {{ otp: string|null, error: string|null, fullResponse: object|null }}
 */
async function _callOAuth2Endpoint(email, refreshToken, clientId, type) {
  const url = 'https://tools.dongvanfb.net/api/get_code_oauth2';
  const body = {
    email: email,
    refresh_token: refreshToken,
    client_id: clientId,
    type: type,
  };

  console.log(
    `[DONGVANFB_OTP] [HOTMAIL] Gọi get_code_oauth2 (type=${type}) cho ${email}...`
  );

  try {
    // v3.1.0: Giảm retry từ 3 xuống 2 cho endpoint chính
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 2);

    // Đọc response body
    const responseText = await res.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      console.warn(
        `[DONGVANFB_OTP] [HOTMAIL] get_code_oauth2 (${type}): Response không phải JSON: ` +
        responseText.substring(0, 200)
      );
      return {
        otp: null,
        error: `Response không phải JSON (HTTP ${res.status})`,
        fullResponse: { httpStatus: res.status, rawBody: responseText.substring(0, 500) },
      };
    }

    console.log(
      `[DONGVANFB_OTP] [HOTMAIL] get_code_oauth2 (${type}) response:`,
      JSON.stringify(data).substring(0, 500)
    );

    // Kiểm tra HTTP error
    if (!res.ok) {
      return {
        otp: null,
        error: `HTTP ${res.status}: ${data.message || data.error || data.msg || 'Unknown'}`,
        fullResponse: data,
      };
    }

    // Kiểm tra API status
    if (data.status === false || data.success === false) {
      return {
        otp: null,
        error: `API error: ${data.message || data.error || data.msg || 'status=false'}`,
        fullResponse: data,
      };
    }

    // Trích xuất OTP
    const otp = extractOtpCode(data);
    if (otp) {
      console.log(
        `[DONGVANFB_OTP] [HOTMAIL] get_code_oauth2 (${type}) → OTP: ${otp}`
      );
      return { otp, error: null, fullResponse: data };
    }

    // Có response nhưng không tìm thấy OTP
    return {
      otp: null,
      error: `Không tìm thấy OTP trong response (status=${data.status})`,
      fullResponse: data,
    };

  } catch (err) {
    console.warn(
      `[DONGVANFB_OTP] [HOTMAIL] get_code_oauth2 (${type}) exception: ${err.message}`
    );
    return {
      otp: null,
      error: err.message,
      fullResponse: null,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  EXPORT — Để dùng trong Manifest V3 background service worker (ES module)
// ═════════════════════════════════════════════════════════════════════════════
//
//  Nếu background.js dùng ES module (type: "module" trong manifest.json):
//    import { getDongVanFB_OTP, parseHotmailString } from './dongvanfb_otp.js';
//
//  Nếu dùng classic script (không module):
//    Bỏ dòng export bên dưới, các hàm sẽ tự động available ở global scope.
//

export { getDongVanFB_OTP, parseHotmailString };
