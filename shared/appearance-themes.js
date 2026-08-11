// Generated from TypeScript. Do not edit.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPEARANCE_THEMES = exports.RESOLVED_APPEARANCES = void 0;
exports.isResolvedAppearance = isResolvedAppearance;
exports.appearanceTheme = appearanceTheme;
const appearance_themes_json_1 = __importDefault(require("./appearance-themes.json"));
exports.RESOLVED_APPEARANCES = ['light', 'dark', 'paper'];
exports.APPEARANCE_THEMES = appearance_themes_json_1.default;
function isResolvedAppearance(value) {
    return typeof value === 'string' && exports.RESOLVED_APPEARANCES.includes(value);
}
function appearanceTheme(value) {
    return exports.APPEARANCE_THEMES[isResolvedAppearance(value) ? value : 'light'];
}
