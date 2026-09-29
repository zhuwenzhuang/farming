import assert from 'node:assert/strict'
import test from 'node:test'
import { extractDocument } from '../backend/document-extraction.cjs'
import { extractDocumentInWorker } from '../backend/document-attachment.cjs'
import * as XLSX from 'xlsx'

function archive(name: string, text: string) {
  const filename = Buffer.from(name); const content = Buffer.from(text)
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + filename.length, 12); end.writeUInt32LE(30 + filename.length + content.length, 16)
  return Buffer.concat([local, filename, content, central, filename, end])
}
export function textPdf() {
  const body = 'BT /F1 12 Tf 50 100 Td (Review migration) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${body.length} >>\nstream\n${body}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

test('extracts complete text, PDF page, DOCX paragraphs, PPTX slide and workbook sheets', async () => {
  const source = '中文 🐱\n' + 'x'.repeat(70_000)
  assert.equal((await extractDocument(Buffer.from(source), 'notes.md')).text, source)
  assert.match((await extractDocument(textPdf(), 'review.pdf')).text, /Page 1\nReview migration/)
  assert.match((await extractDocument(archive('word/document.xml', '<w:document xmlns:w="urn:w"><w:p><w:r><w:t>中文 &amp; text</w:t></w:r></w:p></w:document>'), 'review.docx')).text, /中文 & text/)
  assert.match((await extractDocument(archive('ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Slide one</a:t></a:r></a:p></p:sld>'), 'review.pptx')).text, /slides\/slide1\nSlide one/)
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name', 'Count'], ['Alpha', 42]]), 'Summary')
  for (const type of ['xlsx', 'xls'] as const) assert.match((await extractDocument(XLSX.write(book, { type: 'buffer', bookType: type }) as Buffer, `review.${type}`)).text, /Sheet: Summary\nName\tCount\nAlpha\t42/)
})
test('rejects binary, XML entities, oversized text and empty documents explicitly', async () => {
  await assert.rejects(extractDocument(Buffer.from([0, 1, 2, 3]), 'app.bin'), /Unsupported binary/)
  await assert.rejects(extractDocument(Buffer.from('x'.repeat(250_001)), 'large.txt'), /250,000/)
  await assert.rejects(extractDocument(Buffer.alloc(0), 'empty.txt'), /non-empty/)
  await assert.rejects(extractDocument(archive('word/document.xml', '<!DOCTYPE a [<!ENTITY ext SYSTEM "file:///etc/passwd">]><a>&ext;</a>'), 'bad.docx'), /document type/)
})
test('isolated extraction terminates on cancellation and timeout, then accepts another request', async () => {
  const abort = new AbortController(); abort.abort()
  await assert.rejects(extractDocumentInWorker(Buffer.from('text'), 'notes.txt', abort.signal), /cancelled/)
  await assert.rejects(extractDocumentInWorker(textPdf(), 'review.pdf', new AbortController().signal, 1), /timed out/)
  assert.equal((await extractDocumentInWorker(Buffer.from('text'), 'notes.txt', new AbortController().signal)).text, 'text')
})
