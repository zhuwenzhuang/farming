const BEL = '\x07';
const ESC = '\x1b';
const MAX_OSC_PAYLOAD_CHARS = 4096;
const MAX_PENDING_OSC99_NOTIFICATIONS = 16;

type TerminalNotificationMethod = 'bel' | 'osc9' | 'osc99' | 'osc777';

interface TerminalNotificationEvent {
  message: string;
  method: TerminalNotificationMethod;
  title: string;
}

type ParserState = 'text' | 'escape' | 'osc' | 'osc-escape';

function notificationText(value: unknown, limit: number): string {
  return String(value || '')
    .replace(/[\u0000-\u0006\u0008-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function simpleOscNotification(payload: string): TerminalNotificationEvent | null {
  if (payload.startsWith('9;')) {
    const message = notificationText(payload.slice(2), 240);
    if (!message || /^4(?:;|$)/.test(message)) return null;
    return { method: 'osc9', title: '', message };
  }

  if (payload.startsWith('777;notify;')) {
    const fields = payload.slice('777;notify;'.length).split(';');
    const title = notificationText(fields.shift(), 80);
    const message = notificationText(fields.join(';'), 240);
    if (!title && !message) return null;
    return { method: 'osc777', title, message };
  }

  return null;
}

function osc99Parameters(value: string): Map<string, string> {
  const parameters = new Map<string, string>();
  value.split(':').forEach(field => {
    const separator = field.indexOf('=');
    if (separator <= 0) return;
    parameters.set(field.slice(0, separator), field.slice(separator + 1));
  });
  return parameters;
}

function decodeOsc99Payload(value: string, encoding: string | undefined): string | null {
  if (encoding !== '1') return value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

class TerminalNotificationParser {
  private overflow = false;
  private payload = '';
  private readonly pendingOsc99 = new Map<string, { message: string; title: string }>();
  private state: ParserState = 'text';

  private osc99Notification(payload: string): TerminalNotificationEvent | null {
    const metadataEnd = payload.indexOf(';', 3);
    if (!payload.startsWith('99;') || metadataEnd < 0) return null;
    const parameters = osc99Parameters(payload.slice(3, metadataEnd));
    const id = notificationText(parameters.get('i'), 80);
    if (!id) return null;

    const payloadType = parameters.get('p');
    const decoded = decodeOsc99Payload(payload.slice(metadataEnd + 1), parameters.get('e'));
    if (decoded === null) return null;
    const pending = this.pendingOsc99.get(id) ?? { message: '', title: '' };
    if (payloadType === 'title') pending.title = notificationText(decoded, 80);
    if (payloadType === 'body') pending.message = notificationText(decoded, 240);

    const done = parameters.get('d') === '1';
    if (done) {
      this.pendingOsc99.delete(id);
      if (!pending.title && !pending.message) return null;
      return { method: 'osc99', ...pending };
    }

    if (pending.title || pending.message) {
      this.pendingOsc99.delete(id);
      this.pendingOsc99.set(id, pending);
      while (this.pendingOsc99.size > MAX_PENDING_OSC99_NOTIFICATIONS) {
        const oldest = this.pendingOsc99.keys().next().value;
        if (typeof oldest !== 'string') break;
        this.pendingOsc99.delete(oldest);
      }
    }
    return null;
  }

  private oscNotification(payload: string): TerminalNotificationEvent | null {
    if (payload.startsWith('99;')) return this.osc99Notification(payload);
    return simpleOscNotification(payload);
  }

  push(data: unknown): TerminalNotificationEvent[] {
    const text = String(data || '');
    const events: TerminalNotificationEvent[] = [];

    const finishOsc = () => {
      if (!this.overflow) {
        const event = this.oscNotification(this.payload);
        if (event) events.push(event);
      }
      this.payload = '';
      this.overflow = false;
      this.state = 'text';
    };

    const appendOsc = (value: string) => {
      if (this.overflow) return;
      if (this.payload.length + value.length > MAX_OSC_PAYLOAD_CHARS) {
        this.payload = '';
        this.overflow = true;
        return;
      }
      this.payload += value;
    };

    for (const char of text) {
      if (this.state === 'text') {
        if (char === BEL) {
          events.push({ method: 'bel', title: '', message: '' });
        } else if (char === ESC) {
          this.state = 'escape';
        }
        continue;
      }

      if (this.state === 'escape') {
        if (char === ']') {
          this.payload = '';
          this.overflow = false;
          this.state = 'osc';
        } else if (char !== ESC) {
          this.state = 'text';
          if (char === BEL) events.push({ method: 'bel', title: '', message: '' });
        }
        continue;
      }

      if (this.state === 'osc') {
        if (char === BEL) {
          finishOsc();
        } else if (char === ESC) {
          this.state = 'osc-escape';
        } else {
          appendOsc(char);
        }
        continue;
      }

      if (char === '\\') {
        finishOsc();
      } else {
        appendOsc(ESC);
        if (char === ESC) {
          this.state = 'osc-escape';
        } else {
          appendOsc(char);
          this.state = 'osc';
        }
      }
    }

    return events;
  }
}

export {
  TerminalNotificationParser,
  type TerminalNotificationEvent,
  type TerminalNotificationMethod,
};
