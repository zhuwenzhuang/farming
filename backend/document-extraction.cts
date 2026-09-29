import { SaxesParser } from 'saxes';
import type { Readable } from 'node:stream';
import * as XLSX from 'xlsx';
import { getDocumentProxy } from 'unpdf';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT = 250_000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
interface ZipEntry { fileName: string; uncompressedSize: number }
interface ZipReader {
  eachEntry(): AsyncIterable<ZipEntry>;
  openReadStreamPromise(entry: ZipEntry): Promise<Readable>;
  close(): void;
}
const yauzl = require('yauzl') as {
  fromBufferPromise(buffer: Buffer, options: { autoClose: boolean; strictFileNames: boolean; validateEntrySizes: boolean }): Promise<ZipReader>;
};

function boundedText(text: string) {
  if (text.length > MAX_DOCUMENT_TEXT) throw new Error('Document text exceeds 250,000 characters. Split the document before attaching it.');
  return text;
}

async function officeParts(bytes: Buffer, keep: (name: string) => boolean) {
  const zip = await yauzl.fromBufferPromise(bytes, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  const parts = new Map<string, string>();
  let count = 0;
  let expanded = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      expanded += entry.uncompressedSize;
      if (++count > 10_000 || expanded > MAX_ARCHIVE_BYTES) throw new Error('Document archive exceeds the extraction budget. Export a smaller document.');
      if (!keep(entry.fileName)) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > MAX_ARCHIVE_BYTES) { stream.destroy(); throw new Error('Document archive entry is too large.'); }
        chunks.push(buffer);
      }
      parts.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
    }
  } finally { zip.close(); }
  return parts;
}

function officeXmlText(xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  let text = '';
  let capture = false;
  parser.on('doctype', () => { throw new Error('Document XML must not contain a document type.'); });
  parser.on('opentag', tag => {
    if (tag.local === 't') capture = true;
    if (tag.local === 'tab') text += '\t';
    if (tag.local === 'br') text += '\n';
  });
  parser.on('text', value => { if (capture) text = boundedText(text + value); });
  parser.on('closetag', tag => {
    if (tag.local === 't') capture = false;
    if (tag.local === 'p' || tag.local === 'tr') text += '\n';
    if (tag.local === 'tc') text += '\t';
    boundedText(text);
  });
  parser.write(xml).close();
  return text.trim();
}

export async function extractDocument(bytes: Buffer, name: string): Promise<{ text: string; type: string }> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Attach a non-empty document smaller than 20 MB.');
  const extension = name.split('.').pop()?.toLowerCase();
  let text = '';
  let type = 'text/plain';
  if (bytes.subarray(0, 5).toString() === '%PDF-' || extension === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true });
    try {
      if (pdf.numPages > 250) throw new Error('PDF exceeds 250 pages. Split it before attaching.');
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        if (pageText.trim()) text = boundedText(`${text}${text ? '\n\n' : ''}## Page ${index}\n${pageText.trim()}`);
        page.cleanup();
      }
    } finally { await pdf.loadingTask.destroy(); }
    type = 'application/pdf';
  } else if (extension === 'docx' || extension === 'pptx') {
    const isWord = extension === 'docx';
    const parts = await officeParts(bytes, file => isWord
      ? /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(file)
      : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(file));
    if (isWord && !parts.has('word/document.xml')) throw new Error('Invalid DOCX document.');
    const names = [...parts.keys()].sort((a, b) => {
      if (a === 'word/document.xml') return -1;
      if (b === 'word/document.xml') return 1;
      return a.localeCompare(b, 'en', { numeric: true });
    });
    for (const file of names) {
      const body = officeXmlText(parts.get(file)!);
      if (!body) continue;
      const label = isWord ? file.replace('word/', '').replace('.xml', '') : file.replace('ppt/', '').replace('.xml', '');
      text = boundedText(`${text}${text ? '\n\n' : ''}## ${label}\n${body}`);
    }
    type = isWord ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  } else if (extension === 'xlsx' || extension === 'xls') {
    if (extension === 'xlsx') await officeParts(bytes, () => false);
    const book = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false });
    if (book.SheetNames.length > 100) throw new Error('Workbook exceeds 100 sheets. Split it before attaching.');
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      if (!sheet) continue;
      const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
      if ((range.e.r + 1) * (range.e.c + 1) > 100_000) throw new Error('Workbook sheet exceeds 100,000 cells. Export a smaller range.');
      text = boundedText(`${text}${text ? '\n\n' : ''}## Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet, { FS: '\t', blankrows: false })}`);
    }
    type = extension === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.ms-excel';
  } else {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { throw new Error('Unsupported binary or text encoding. Export as UTF-8, PDF, DOCX, XLSX or PPTX.'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Unsupported binary file. Export as PDF, DOCX, XLSX or PPTX.');
    boundedText(text);
  }
  if (!text.trim()) throw new Error('No readable text found. Scanned documents need OCR before attaching.');
  return { text, type };
}
