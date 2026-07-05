const crypto = require('crypto');

const SHARE_TICKET_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CODE_LENGTH = 10;
const DEFAULT_MAX_TICKETS = 200;
const SHARE_TICKET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function createShareTicketCode(options = {}) {
  const length = Math.max(6, Math.min(Number(options.length) || DEFAULT_CODE_LENGTH, 32));
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += SHARE_TICKET_ALPHABET[bytes[index] % SHARE_TICKET_ALPHABET.length];
  }
  return code;
}

class QrShareTicketStore {
  constructor(options = {}) {
    this.ttlMs = Math.max(30_000, Number(options.ttlMs) || SHARE_TICKET_TTL_MS);
    this.codeLength = Math.max(6, Math.min(Number(options.codeLength) || DEFAULT_CODE_LENGTH, 32));
    this.maxTickets = Math.max(1, Number(options.maxTickets) || DEFAULT_MAX_TICKETS);
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.tickets = new Map();
  }

  create(token, options = {}) {
    const now = Number(options.now) || Date.now();
    this.cleanup(now);
    this.trim(now);

    let code = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      code = createShareTicketCode({ length: this.codeLength, randomBytes: this.randomBytes });
      if (!this.tickets.has(code)) break;
      code = '';
    }
    if (!code) {
      throw new Error('Unable to allocate share code');
    }

    const ticket = {
      code,
      token: String(token || ''),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.tickets.set(code, ticket);
    return { ...ticket };
  }

  consume(code, options = {}) {
    const normalizedCode = normalizeCode(code);
    const now = Number(options.now) || Date.now();
    const ticket = this.tickets.get(normalizedCode);
    if (!ticket) return null;
    this.tickets.delete(normalizedCode);
    if (ticket.expiresAt <= now) return null;
    return { ...ticket };
  }

  revoke(code) {
    return this.tickets.delete(normalizeCode(code));
  }

  cleanup(now = Date.now()) {
    for (const [code, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(code);
      }
    }
  }

  trim(now = Date.now()) {
    if (this.tickets.size < this.maxTickets) return;
    this.cleanup(now);
    if (this.tickets.size < this.maxTickets) return;
    const oldest = [...this.tickets.values()]
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, Math.max(1, this.tickets.size - this.maxTickets + 1));
    for (const ticket of oldest) {
      this.tickets.delete(ticket.code);
    }
  }
}

module.exports = {
  QrShareTicketStore,
  SHARE_TICKET_ALPHABET,
  SHARE_TICKET_TTL_MS,
  createShareTicketCode,
  normalizeCode,
};
