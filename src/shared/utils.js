/**
 * utils.js — Các hàm tiện ích dùng chung
 */

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomDelay(minMs = 1000, maxMs = 3000) {
  return sleep(randomInt(minMs, maxMs));
}

export function randomStr(len = 10, charset = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  return Array.from({ length: len }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
}

export function generatePassword(len = 14) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%';
  const all = upper + lower + digits + special;
  let pass = [
    upper[randomInt(0, upper.length - 1)],
    lower[randomInt(0, lower.length - 1)],
    digits[randomInt(0, digits.length - 1)],
    special[randomInt(0, special.length - 1)],
  ];
  for (let i = pass.length; i < len; i++) {
    pass.push(all[randomInt(0, all.length - 1)]);
  }
  return pass.sort(() => Math.random() - 0.5).join('');
}

export function generateName() {
  const firstNames = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia',
    'Benjamin', 'Isabella', 'Lucas', 'Mia', 'Henry', 'Charlotte', 'Alexander', 'Amelia',
    'Mason', 'Harper', 'Ethan', 'Evelyn'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
    'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Jackson', 'White', 'Harris',
    'Martin', 'Thompson', 'Young', 'Walker', 'Allen'];
  return {
    firstName: firstNames[randomInt(0, firstNames.length - 1)],
    lastName: lastNames[randomInt(0, lastNames.length - 1)],
  };
}

export function generateBirthday() {
  const year = randomInt(1985, 2000);
  const month = randomInt(1, 12);
  const day = randomInt(1, 28);
  return { year, month, day };
}

// ── Luhn algorithm cho thẻ ────────────────────────────────────────────

export function luhnChecksum(number) {
  const digits = String(number).split('').map(Number);
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits[i];
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function generateCard(bin = '4111111111111111') {
  // Sinh số thẻ 16 chữ số hợp lệ theo Luhn từ BIN
  const prefix = String(bin).slice(0, 6);
  let number = prefix;
  while (number.length < 15) {
    number += randomInt(0, 9);
  }
  // Tính check digit
  let sum = 0;
  let alternate = true;
  for (let i = number.length - 1; i >= 0; i--) {
    let n = parseInt(number[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  number += checkDigit;

  const expMonth = String(randomInt(1, 12)).padStart(2, '0');
  const expYear = String(randomInt(new Date().getFullYear() + 1, new Date().getFullYear() + 4));
  const cvv = String(randomInt(100, 999));

  return { number, expMonth, expYear, cvv };
}

export const CARD_ADDRESS = {
  US: {
    line1: '123 Main Street',
    city: 'New York',
    state: 'NY',
    zip: '10001',
    country: 'US',
  },
  GB: {
    line1: '10 Downing Street',
    city: 'London',
    state: '',
    zip: 'SW1A 2AA',
    country: 'GB',
  },
  JP: {
    line1: '1-1 Chiyoda',
    city: 'Tokyo',
    state: 'Tokyo',
    zip: '100-0001',
    country: 'JP',
  },
  AU: {
    line1: '1 George Street',
    city: 'Sydney',
    state: 'NSW',
    zip: '2000',
    country: 'AU',
  },
};

// ── Proxy helpers ─────────────────────────────────────────────────────

export function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  try {
    const str = proxyStr.trim();
    // Format: socks5://user:pass@host:port hoặc http://host:port hoặc host:port:user:pass
    if (str.startsWith('socks5://') || str.startsWith('http://') || str.startsWith('https://')) {
      const url = new URL(str);
      return {
        scheme: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port),
        username: url.username || '',
        password: url.password || '',
      };
    }
    // Format: host:port:user:pass
    const parts = str.split(':');
    if (parts.length >= 2) {
      return {
        scheme: 'http',
        host: parts[0],
        port: parseInt(parts[1]),
        username: parts[2] || '',
        password: parts[3] || '',
      };
    }
  } catch (e) {}
  return null;
}

export function formatProxyForChrome(proxy) {
  if (!proxy) return null;
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
      },
    },
  };
}

// ── Message helpers ───────────────────────────────────────────────────

export function sendToBackground(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

export function sendToTab(tabId, type, data = {}) {
  return chrome.tabs.sendMessage(tabId, { type, ...data });
}
