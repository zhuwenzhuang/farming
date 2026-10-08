// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.packWorkspaceBlameLines = packWorkspaceBlameLines;
exports.unpackWorkspaceBlameLines = unpackWorkspaceBlameLines;
/** Deduplicate commit metadata and consecutive line positions before transport.
 * UTF-8/JSON accounting bounds bytes, even for escapes and multibyte content. */
function packWorkspaceBlameLines(lines, offset, budget) {
    const commits = [];
    const ranges = [];
    const indices = new Map();
    const encoder = new TextEncoder();
    let bytes = 32;
    let count = 0;
    for (let index = offset; index < lines.length; index++) {
        const line = lines[index];
        const commit = {
            commit: line.commit, author: line.author, authorMail: line.authorMail,
            authorTime: line.authorTime, summary: line.summary,
        };
        const key = JSON.stringify(commit);
        const existing = indices.get(key);
        const commitIndex = existing ?? commits.length;
        const last = ranges[ranges.length - 1];
        const extend = last && last.commit === commitIndex
            && last.start + last.contents.length === line.lineNumber
            && last.originalStart + last.contents.length === line.originalLineNumber;
        const range = { start: line.lineNumber, originalStart: line.originalLineNumber, commit: commitIndex, contents: [] };
        const added = (existing === undefined ? encoder.encode(key).byteLength + 1 : 0)
            + (extend ? 0 : encoder.encode(JSON.stringify(range)).byteLength + 1)
            + encoder.encode(JSON.stringify(line.content)).byteLength + 1;
        if (bytes + added > budget)
            break;
        if (existing === undefined) {
            indices.set(key, commitIndex);
            commits.push(commit);
        }
        if (extend)
            last.contents.push(line.content);
        else {
            range.contents.push(line.content);
            ranges.push(range);
        }
        bytes += added;
        count++;
    }
    return { commits, ranges, count };
}
function unpackWorkspaceBlameLines(page) {
    const lines = [];
    for (const range of page.ranges) {
        const commit = page.commits[range.commit];
        if (!commit || !Number.isSafeInteger(range.start) || range.start < 1
            || !Number.isSafeInteger(range.originalStart) || range.originalStart < 1
            || !Number.isSafeInteger(range.commit) || !Array.isArray(range.contents)
            || !range.contents.every(content => typeof content === 'string'))
            throw new Error('Invalid blame range');
        const uncommitted = /^0+$/.test(commit.commit);
        for (let index = 0; index < range.contents.length; index++) {
            lines.push({ ...commit, uncommitted, shortCommit: uncommitted ? 'uncommitted' : commit.commit.slice(0, 8),
                authorTimeIso: commit.authorTime === null ? '' : new Date(commit.authorTime * 1000).toISOString(),
                lineNumber: range.start + index, originalLineNumber: range.originalStart + index, content: range.contents[index] });
        }
    }
    return lines;
}
