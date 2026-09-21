// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_READ_ONLY_SHARE_HOURS = exports.MIN_READ_ONLY_SHARE_HOURS = exports.DEFAULT_READ_ONLY_SHARE_HOURS = void 0;
exports.validReadOnlyShareHours = validReadOnlyShareHours;
exports.normalizeReadOnlyShareHours = normalizeReadOnlyShareHours;
exports.DEFAULT_READ_ONLY_SHARE_HOURS = 24;
exports.MIN_READ_ONLY_SHARE_HOURS = 1;
exports.MAX_READ_ONLY_SHARE_HOURS = 168;
function validReadOnlyShareHours(value) {
    return typeof value === 'number' && Number.isInteger(value)
        && value >= exports.MIN_READ_ONLY_SHARE_HOURS && value <= exports.MAX_READ_ONLY_SHARE_HOURS;
}
function normalizeReadOnlyShareHours(value) {
    return validReadOnlyShareHours(value) ? value : exports.DEFAULT_READ_ONLY_SHARE_HOURS;
}
