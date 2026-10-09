// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.worktreeDirectorySuffix = worktreeDirectorySuffix;
/** Shared display/allocation suffix; Git name validation remains backend-owned. */
function worktreeDirectorySuffix(branch) {
    return branch.replace(/\//g, '-');
}
