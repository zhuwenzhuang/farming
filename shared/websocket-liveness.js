// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WEBSOCKET_PING_INTERVAL_MS = void 0;
exports.initializeWebSocketLiveness = initializeWebSocketLiveness;
exports.advanceWebSocketLiveness = advanceWebSocketLiveness;
exports.startWebSocketLivenessMonitor = startWebSocketLivenessMonitor;
exports.DEFAULT_WEBSOCKET_PING_INTERVAL_MS = 10_000;
function initializeWebSocketLiveness(socket) {
    socket.farmingHeartbeatAlive = true;
    socket.on('pong', () => {
        socket.farmingHeartbeatAlive = true;
    });
}
function advanceWebSocketLiveness(socket, openState) {
    if (socket.readyState !== openState)
        return 'ignored';
    if (socket.farmingHeartbeatAlive === false) {
        socket.terminate();
        return 'terminated';
    }
    socket.farmingHeartbeatAlive = false;
    try {
        socket.ping();
    }
    catch {
        socket.terminate();
        return 'terminated';
    }
    return 'pinged';
}
function startWebSocketLivenessMonitor(webSocketServer, { openState, intervalMs = exports.DEFAULT_WEBSOCKET_PING_INTERVAL_MS, }) {
    const timer = setInterval(() => {
        for (const socket of webSocketServer.clients) {
            advanceWebSocketLiveness(socket, openState);
        }
    }, intervalMs);
    timer.unref?.();
    return timer;
}
