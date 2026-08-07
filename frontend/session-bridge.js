// Generated from TypeScript. Do not edit.
"use strict";
(function attachSessionBridge(global) {
    function createClient(options = {}) {
        const getSocket = options.getSocket || (() => null);
        const composerResults = new Map();
        const checkpointRequests = new Map();
        let composerRequestSequence = 0;
        let checkpointRequestSequence = 0;
        let transportReady = false;
        function send(message) {
            const ws = getSocket();
            if (!ws || ws.readyState !== global.WebSocket.OPEN) {
                return false;
            }
            ws.send(JSON.stringify(message));
            return true;
        }
        function sendPendingCheckpoints() {
            if (!transportReady)
                return;
            for (const [requestId, request] of checkpointRequests) {
                if (request.sent || request.signal?.aborted)
                    continue;
                request.sent = send({
                    type: 'terminal-checkpoint-request',
                    requestId,
                    agentId: request.agentId,
                });
                if (!request.sent) {
                    transportReady = false;
                    return;
                }
            }
        }
        function deleteCheckpointRequest(requestId) {
            const request = checkpointRequests.get(requestId);
            if (!request)
                return null;
            checkpointRequests.delete(requestId);
            if (request.signal && request.onAbort) {
                request.signal.removeEventListener('abort', request.onAbort);
            }
            return request;
        }
        function settleCheckpointResult(message) {
            const request = checkpointRequests.get(message.requestId);
            if (!request || request.agentId !== message.agentId)
                return false;
            deleteCheckpointRequest(message.requestId);
            if (!message.ok || !message.session) {
                request.reject(new Error(message.error || 'Terminal checkpoint is unavailable'));
            }
            else {
                request.resolve({ session: message.session });
            }
            return true;
        }
        return {
            focusAgent(agentId, options = {}) {
                return send({
                    type: 'focus-agent',
                    agentId,
                    ...(options.activityScope ? { activityScope: options.activityScope } : {}),
                    ...(options.stateScope ? { stateScope: options.stateScope } : {}),
                    ...(options.streamScope ? { streamScope: options.streamScope } : {}),
                    ...(options.previewScope ? { previewScope: options.previewScope } : {}),
                    ...(options.refreshState === true ? { refreshState: true } : {}),
                });
            },
            sendTerminalInput(agentId, input) {
                return send({ type: 'input', agentId, input });
            },
            sendComposerMessage(agentId, message, attachments = [], options = {}) {
                const requestedId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
                const requestId = requestedId
                    || global.crypto?.randomUUID?.()
                    || `composer-${Date.now().toString(36)}-${++composerRequestSequence}`;
                const sent = send({
                    type: 'composer-input',
                    agentId,
                    message,
                    requestId,
                    ...(attachments.length > 0 ? { attachments } : {}),
                });
                if (sent && options.onResult)
                    composerResults.set(requestId, options.onResult);
                return sent;
            },
            handleServerMessage(message) {
                if (isProtocolHello(message)) {
                    transportReady = true;
                    checkpointRequests.forEach(request => {
                        request.sent = false;
                    });
                    sendPendingCheckpoints();
                    return false;
                }
                if (isTerminalCheckpointResult(message)) {
                    const request = checkpointRequests.get(message.requestId);
                    if (!request || request.agentId !== message.agentId)
                        return false;
                    const interceptor = global.__FARMING_E2E__
                        ? global.__farmingTerminalCheckpointInterceptor
                        : undefined;
                    if (!interceptor)
                        return settleCheckpointResult(message);
                    void Promise.resolve(interceptor(message)).then(result => {
                        if (result && isTerminalCheckpointResult(result))
                            settleCheckpointResult(result);
                    }).catch(error => {
                        const pending = deleteCheckpointRequest(message.requestId);
                        pending?.reject(error instanceof Error ? error : new Error(String(error)));
                    });
                    return true;
                }
                if (isComposerInputResult(message)) {
                    const callback = composerResults.get(message.requestId);
                    if (!callback)
                        return false;
                    composerResults.delete(message.requestId);
                    callback(message);
                    return true;
                }
                return false;
            },
            handleTransportDisconnected(message = 'Connection unavailable') {
                transportReady = false;
                checkpointRequests.forEach(request => {
                    request.sent = false;
                });
                composerResults.forEach(callback => callback({ accepted: false, message, uncertain: true }));
                composerResults.clear();
            },
            interruptAgent(agentId) {
                return send({ type: 'interrupt-agent', agentId });
            },
            resizeAgent(agentId, cols, rows) {
                return send({ type: 'resize-agent', agentId, cols, rows });
            },
            clearTerminal(agentId) {
                return send({ type: 'clear-terminal', agentId });
            },
            archiveAgent(agentId) {
                return send({ type: 'archive-agent', agentId });
            },
            requestTerminalCheckpoint(agentId, options = {}) {
                if (options.signal?.aborted) {
                    return Promise.reject(options.signal.reason instanceof Error
                        ? options.signal.reason
                        : new globalThis.DOMException('Terminal checkpoint request was cancelled', 'AbortError'));
                }
                const requestId = global.crypto?.randomUUID?.()
                    || `terminal-checkpoint-${Date.now().toString(36)}-${++checkpointRequestSequence}`;
                const promise = new Promise((resolve, reject) => {
                    const request = {
                        agentId,
                        sent: false,
                        signal: options.signal,
                        resolve,
                        reject,
                        onAbort: undefined,
                    };
                    request.onAbort = () => {
                        deleteCheckpointRequest(requestId);
                        reject(options.signal?.reason instanceof Error
                            ? options.signal.reason
                            : new globalThis.DOMException('Terminal checkpoint request was cancelled', 'AbortError'));
                    };
                    checkpointRequests.set(requestId, request);
                    options.signal?.addEventListener('abort', request.onAbort, { once: true });
                    sendPendingCheckpoints();
                });
                return promise;
            },
        };
    }
    function isComposerInputResult(message) {
        if (!message || typeof message !== 'object')
            return false;
        const candidate = message;
        return candidate.type === 'composer-input-result' && typeof candidate.requestId === 'string';
    }
    function isProtocolHello(message) {
        return Boolean(message && typeof message === 'object' && message.type === 'protocol-hello');
    }
    function isTerminalCheckpointResult(message) {
        if (!message || typeof message !== 'object')
            return false;
        const candidate = message;
        return candidate.type === 'terminal-checkpoint-result'
            && typeof candidate.requestId === 'string'
            && typeof candidate.agentId === 'string';
    }
    global.FarmingSessionBridge = { createClient };
})(window);
