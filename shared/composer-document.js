// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeComposerLink = safeComposerLink;
exports.normalizeComposerDocument = normalizeComposerDocument;
exports.literalComposerDocument = literalComposerDocument;
exports.composerDocumentText = composerDocumentText;
exports.composerDocumentPrompt = composerDocumentPrompt;
exports.composerDocumentFromContent = composerDocumentFromContent;
const blocks = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'horizontalRule']);
const inline = new Set(['text', 'hardBreak']);
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safeComposerLink(value) {
    return typeof value === 'string' && value.length <= 4096 && /^(https?:\/\/|mailto:)/i.test(value) && !/[\u0000-\u0020]/.test(value);
}
function normalizeComposerDocument(value) {
    if (!record(value) || value.version !== 1 || !record(value.doc))
        return undefined;
    let count = 0;
    let chars = 0;
    function read(raw, parent, depth) {
        if (!record(raw) || typeof raw.type !== 'string' || ++count > 30_000 || depth > 32)
            return undefined;
        const type = raw.type;
        const allowed = parent === '' ? type === 'doc'
            : ['paragraph', 'heading'].includes(parent) ? inline.has(type)
                : parent === 'codeBlock' ? type === 'text'
                    : ['bulletList', 'orderedList'].includes(parent) ? type === 'listItem' : blocks.has(type);
        if (!allowed)
            return undefined;
        const node = { type };
        if (type === 'text') {
            if (typeof raw.text !== 'string' || !raw.text || (chars += raw.text.length) > 250_000)
                return undefined;
            node.text = raw.text;
        }
        else if (raw.text !== undefined)
            return undefined;
        if (raw.attrs !== undefined) {
            if (!record(raw.attrs))
                return undefined;
            if (type === 'heading') {
                if (!Number.isInteger(raw.attrs.level) || Number(raw.attrs.level) < 1 || Number(raw.attrs.level) > 6)
                    return undefined;
                node.attrs = { level: Number(raw.attrs.level) };
            }
            else if (type === 'codeBlock') {
                const language = raw.attrs.language;
                if (language != null && (typeof language !== 'string' || !/^[\w#+.-]{1,64}$/.test(language)))
                    return undefined;
                node.attrs = { language: language == null ? null : String(language) };
            }
            else if (type === 'orderedList') {
                const start = raw.attrs.start ?? 1;
                if (!Number.isInteger(start) || Number(start) < 1 || Number(start) > 1_000_000)
                    return undefined;
                node.attrs = { start: Number(start), type: null };
            }
        }
        if (raw.marks !== undefined) {
            if (parent === 'codeBlock' || !inline.has(type) || !Array.isArray(raw.marks) || raw.marks.length > 6)
                return undefined;
            node.marks = [];
            for (const mark of raw.marks) {
                if (!record(mark) || !['bold', 'italic', 'strike', 'underline', 'code', 'link'].includes(String(mark.type)))
                    return undefined;
                if (mark.type === 'link') {
                    if (!record(mark.attrs) || !safeComposerLink(mark.attrs.href))
                        return undefined;
                    node.marks.push({ type: 'link', attrs: { href: mark.attrs.href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } });
                }
                else
                    node.marks.push({ type: String(mark.type) });
            }
        }
        if (raw.content !== undefined) {
            if (inline.has(type) || type === 'horizontalRule' || !Array.isArray(raw.content))
                return undefined;
            node.content = [];
            for (const child of raw.content) {
                const parsed = read(child, type, depth + 1);
                if (!parsed)
                    return undefined;
                node.content.push(parsed);
            }
        }
        if (['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem'].includes(type) && !node.content?.length)
            return undefined;
        if (type === 'listItem' && node.content?.[0]?.type !== 'paragraph')
            return undefined;
        return node;
    }
    const doc = read(value.doc, '', 0);
    return doc ? { version: 1, doc } : undefined;
}
function literalComposerDocument(text) {
    return { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: text.split('\n').flatMap((line, index) => [
                        ...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : []),
                    ]) }] } };
}
function composerDocumentText(document) {
    function text(node) {
        if (node.type === 'text')
            return node.text || '';
        if (node.type === 'hardBreak')
            return '\n';
        if (node.type === 'horizontalRule')
            return '---';
        return (node.content || []).map(text).join(['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n');
    }
    return text(document.doc);
}
/** Model projection is never parsed back into the visible document. */
function composerDocumentPrompt(document) {
    function text(node) {
        if (node.type === 'text') {
            const link = node.marks?.find(mark => mark.type === 'link')?.attrs?.href;
            return link ? `${node.text} (${link})` : node.text || '';
        }
        if (node.type === 'hardBreak')
            return '\n';
        if (node.type === 'horizontalRule')
            return '---';
        const body = (node.content || []).map(text).join(['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n');
        if (node.type !== 'codeBlock')
            return body;
        const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)));
        return `${fence}${node.attrs?.language || ''}\n${body}\n${fence}`;
    }
    return text(document.doc);
}
function composerDocumentFromContent(content) {
    if (!Array.isArray(content))
        return undefined;
    for (const block of content) {
        if (!record(block) || block.type !== 'text' || !record(block._meta))
            continue;
        const document = normalizeComposerDocument(block._meta.farmingInputDocument);
        if (document && composerDocumentPrompt(document) === block.text)
            return document;
    }
    return undefined;
}
