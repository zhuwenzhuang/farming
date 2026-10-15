// Close the real input pipe while keeping the child alive, or exit mid-request.
// The parent client must clean up this exact child in either case.
import fs from 'node:fs'

let pendingRequest
let buffer = Buffer.alloc(0)
const keepAlive = setInterval(() => {}, 1000)
function reply(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length:\s*(\d+)/i)?.[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const message = JSON.parse(buffer.subarray(start, start + length).toString())
    buffer = buffer.subarray(start + length)
    if (message.method === 'initialize') {
      if (process.argv.includes('--close-input')) {
        process.stdin.pause()
        fs.closeSync(0)
        reply(message.id, { capabilities: {} })
      } else {
        reply(message.id, { capabilities: {} })
      }
    } else if (message.method === '$/cancelRequest') {
      if (pendingRequest === message.params.id) {
        fs.writeFileSync(process.argv.at(-1), 'cancelled')
        const cancelledId = pendingRequest
        if (process.argv.includes('--defer-cancel-response')) {
          const release = setInterval(() => {
            if (fs.readFileSync(process.argv.at(-1), 'utf8') !== 'release') return
            clearInterval(release)
            reply(cancelledId, null)
          }, 10)
        } else {
          reply(cancelledId, null)
        }
        pendingRequest = undefined
      }
    } else if (message.method === 'textDocument/hover') {
      if (process.argv.includes('--cancel-request')) {
        pendingRequest = message.id
        fs.writeFileSync(process.argv.at(-1), 'waiting')
        continue
      }
      clearInterval(keepAlive)
      process.exit(7)
    }
  }
})
