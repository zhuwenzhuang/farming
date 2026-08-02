import type { ProtocolClientHelloMessage } from '../shared/browser-protocol.js';

const { negotiateProtocolExtensions } = require('../shared/browser-protocol.js');

interface BrowserProtocolWebSocket {
  negotiatedProtocolExtensions?: Set<string>;
  protocolVersion?: number;
  send(data: string): void;
}

interface BrowserProtocolHandshakeOptions {
  availableExtensions: readonly string[];
  minProtocolVersion: number;
  protocolVersion: number;
}

function serverHello(
  options: BrowserProtocolHandshakeOptions,
  negotiatedExtensions?: readonly string[],
) {
  return {
    type: 'protocol-hello',
    protocolVersion: options.protocolVersion,
    minProtocolVersion: options.minProtocolVersion,
    availableExtensions: options.availableExtensions,
    ...(negotiatedExtensions ? { negotiatedExtensions } : {}),
  };
}

export function offerBrowserProtocolExtensions(
  socket: BrowserProtocolWebSocket,
  options: BrowserProtocolHandshakeOptions,
): void {
  socket.negotiatedProtocolExtensions = new Set();
  socket.send(JSON.stringify(serverHello(options)));
}

export function acknowledgeBrowserProtocolExtensions(
  socket: BrowserProtocolWebSocket,
  hello: ProtocolClientHelloMessage,
  options: BrowserProtocolHandshakeOptions,
): string[] {
  const negotiatedExtensions = negotiateProtocolExtensions(
    options.availableExtensions,
    hello.requestedExtensions,
  );
  socket.protocolVersion = hello.protocolVersion;
  socket.negotiatedProtocolExtensions = new Set(negotiatedExtensions);
  socket.send(JSON.stringify(serverHello(options, negotiatedExtensions)));
  return negotiatedExtensions;
}
