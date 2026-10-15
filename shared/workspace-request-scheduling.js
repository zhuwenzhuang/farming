// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKSPACE_REQUEST_CONCURRENCY = void 0;
exports.workspaceRequestLane = workspaceRequestLane;
exports.languageServerRequestLane = languageServerRequestLane;
exports.WORKSPACE_REQUEST_CONCURRENCY = { interactive: 4, background: 2, languageServer: 1, languageServerBackground: 1 };
function workspaceRequestLane(request) {
    switch (request.operation) {
        case 'search':
            return request.scope === 'entries' ? 'interactive' : 'background';
        case 'tree':
        case 'read-file':
        case 'save-file':
        case 'move-entry':
        case 'create-entry':
        case 'rename-entry':
        case 'delete-entry':
        case 'switch-branch':
            return 'interactive';
        default:
            return 'background';
    }
}
function languageServerRequestLane(request) {
    // Optional semantic work must never hold a Files execution slot, even when
    // the server ignores cancellation during initialization.
    return request.operation === 'capability' || request.priority === 'background'
        ? 'languageServerBackground' : 'languageServer';
}
