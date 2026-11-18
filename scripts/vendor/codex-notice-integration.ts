// Scope unscoped Codex app-server diagnostics to the request that triggered them
// so a shared app-server never broadcasts one session's warnings onto peers.
export function integrateCodexNotices(source: string): string {
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) {
      throw new Error(`Expected one Codex diagnostic notice boundary: ${from.slice(0, 100)}`);
    }
    source = source.replace(from, to);
  };
  replace(
    '    this.threadSettings.delete(threadId);\n  }',
    '    this.threadSettings.delete(threadId);\n    this.pendingDiagnosticNotices.delete(threadId);\n  }',
  );
  replace(
    '  async threadDelete(params) {\n    return await this.sendRequest({ method: "thread/delete", params });\n  }\n  async threadUnsubscribe(params) {',
    '  async threadDelete(params) {\n    this.pendingDiagnosticNotices.delete(params.threadId);\n    return await this.sendRequest({ method: "thread/delete", params });\n  }\n  async threadUnsubscribe(params) {\n    this.pendingDiagnosticNotices.delete(params.threadId);',
  );
  replace(
    `  onServerNotification(sessionId, callback) {
    this.notificationHandlers.set(sessionId, callback);
  }`,
    `  onServerNotification(sessionId, callback) {
    this.notificationHandlers.set(sessionId, callback);
    const pending = this.pendingDiagnosticNotices.get(sessionId);
    if (pending) {
      this.pendingDiagnosticNotices.delete(sessionId);
      for (const notification of pending) callback(notification);
    }
  }`,
  );
  replace(
    `  notificationHandlers = /* @__PURE__ */ new Map();
  notify(notification) {
    const threadId = extractThreadId(notification);
    if (threadId !== null) {
      const handler = this.notificationHandlers.get(threadId);
      if (handler) {
        handler(notification);
      }
      return;
    }
    for (const notificationHandler of this.notificationHandlers.values()) {
      notificationHandler(notification);
    }
  }`,
    `  notificationHandlers = /* @__PURE__ */ new Map();
  diagnosticScopes = /* @__PURE__ */ new Set();
  pendingDiagnosticNotices = /* @__PURE__ */ new Map();
  rememberPendingDiagnosticNotices(threadId, notices) {
    if (typeof threadId !== "string" || !threadId || notices.length === 0) return;
    const existing = this.pendingDiagnosticNotices.get(threadId) ?? [];
    this.pendingDiagnosticNotices.delete(threadId);
    this.pendingDiagnosticNotices.set(threadId, [...existing, ...notices].slice(-16));
    while (this.pendingDiagnosticNotices.size > 32) {
      const oldest = this.pendingDiagnosticNotices.keys().next().value;
      if (oldest === void 0) break;
      this.pendingDiagnosticNotices.delete(oldest);
    }
  }
  notify(notification) {
    const threadId = extractThreadId(notification);
    if (threadId !== null) {
      const handler = this.notificationHandlers.get(threadId);
      if (handler) {
        handler(notification);
      }
      return;
    }
    if (isUnscopedDiagnosticNotification(notification) && this.diagnosticScopes.size > 0) {
      const pendingScopes = [];
      const threadIds = /* @__PURE__ */ new Set();
      for (const scope of this.diagnosticScopes) {
        if (scope.kind === "pending") pendingScopes.push(scope);
        else if (scope.kind === "thread") threadIds.add(scope.threadId);
      }
      for (const scope of pendingScopes) {
        if (scope.notices.length < 16) scope.notices.push(notification);
      }
      for (const targetThreadId of threadIds) {
        this.notificationHandlers.get(targetThreadId)?.(notification);
      }
      return;
    }
    for (const notificationHandler of this.notificationHandlers.values()) {
      notificationHandler(notification);
    }
  }`,
  );
  replace(
    `  async sendRequest(request) {
    for (const callback of this.codexEventHandlers) {
      callback({ eventType: "request", ...request });
    }
    const loadedThreadId = threadLoadOf(request);
    let result;
    try {
      if (loadedThreadId === null) {
        if (request.params) {
          result = await this.connection.sendRequest(request.method, request.params);
        } else {
          result = await this.connection.sendRequest(request.method);
        }
      } else {
        result = await this.threadLoadGate(loadedThreadId, () => this.sendThreadLoad(loadedThreadId, request));
      }
    } catch (err) {
      throw err instanceof Error ? explainCodexError(err, { codexHome: this.codexHome }) : err;
    }
    for (const callback of this.codexEventHandlers) {
      callback({ eventType: "response", ...result });
    }
    return result;
  }`,
    `  async sendRequest(request) {
    for (const callback of this.codexEventHandlers) {
      callback({ eventType: "request", ...request });
    }
    const loadedThreadId = threadLoadOf(request);
    const diagnosticScope = diagnosticScopeOf(request);
    if (diagnosticScope !== null) this.diagnosticScopes.add(diagnosticScope);
    let result;
    try {
      if (loadedThreadId === null) {
        if (request.params) {
          result = await this.connection.sendRequest(request.method, request.params);
        } else {
          result = await this.connection.sendRequest(request.method);
        }
      } else {
        result = await this.threadLoadGate(loadedThreadId, () => this.sendThreadLoad(loadedThreadId, request));
      }
    } catch (err) {
      throw err instanceof Error ? explainCodexError(err, { codexHome: this.codexHome }) : err;
    } finally {
      if (diagnosticScope !== null) this.diagnosticScopes.delete(diagnosticScope);
    }
    if (diagnosticScope?.kind === "pending") {
      const handler = typeof result?.thread?.id === "string" ? this.notificationHandlers.get(result.thread.id) : void 0;
      if (handler) {
        for (const notification of diagnosticScope.notices) handler(notification);
      } else {
        this.rememberPendingDiagnosticNotices(result?.thread?.id, diagnosticScope.notices);
      }
    }
    for (const callback of this.codexEventHandlers) {
      callback({ eventType: "response", ...result });
    }
    return result;
  }`,
  );
  replace(
    'function threadLoadOf(request) {',
    `function isUnscopedDiagnosticNotification(notification) {
  return notification.method === "configWarning"
    || notification.method === "deprecationNotice"
    || (notification.method === "warning" && extractThreadId(notification) === null);
}
function diagnosticScopeOf(request) {
  if (request.method === "thread/start") {
    return request.params?.ephemeral === true ? { kind: "suppress" } : { kind: "pending", notices: [] };
  }
  if (request.method === "thread/fork") {
    return { kind: "pending", notices: [] };
  }
  if (typeof request.params?.threadId === "string") {
    return { kind: "thread", threadId: request.params.threadId };
  }
  switch (request.method) {
    case "config/read":
    case "skills/list":
    case "skills/extraRoots/set":
    case "model/list":
    case "permissionProfile/list":
    case "thread/list":
    case "thread/loaded/list":
      return { kind: "suppress" };
    default:
      return null;
  }
}
function threadLoadOf(request) {`,
  );
  return source;
}
