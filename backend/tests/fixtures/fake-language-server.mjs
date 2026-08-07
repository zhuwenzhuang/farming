let buffer = Buffer.alloc(0)
let rootUri = ''
let refreshSupported = false

function send(message) {
  const body = Buffer.from(JSON.stringify(message))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function hierarchyItem(uri, name = 'main') {
  return {
    name,
    detail: 'fake hierarchy item',
    kind: 12,
    uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
  }
}

function handle(message) {
  const { id, method, params = {} } = message
  if (!method) return
  if (method === 'initialize') {
    rootUri = params.rootUri
    refreshSupported = params.capabilities?.workspace?.semanticTokens?.refreshSupport === true
      && params.capabilities?.workspace?.inlayHint?.refreshSupport === true
    send({
      jsonrpc: '2.0',
      id: 900,
      method: 'client/registerCapability',
      params: {
        registrations: [{
          id: 'fake-document-highlights',
          method: 'textDocument/documentHighlight',
          registerOptions: {},
        }, {
          id: 'fake-semantic-tokens',
          method: 'textDocument/semanticTokens',
          registerOptions: {
            legend: {
              tokenTypes: ['variable', 'function'],
              tokenModifiers: ['declaration'],
            },
            full: true,
          },
        }, {
          id: 'fake-inlay-hints',
          method: 'textDocument/inlayHint',
          registerOptions: {},
        }],
      },
    })
    reply(id, {
      capabilities: {
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        callHierarchyProvider: true,
        typeHierarchyProvider: true,
        textDocumentSync: 1,
      },
    })
    return
  }
  if (method === 'shutdown') {
    reply(id, null)
    return
  }
  if (method === 'exit') {
    process.exit(0)
  }
  if (method === 'textDocument/didOpen') {
    const uri = params.textDocument.uri
    if (refreshSupported) {
      send({ jsonrpc: '2.0', id: 901, method: 'workspace/semanticTokens/refresh' })
      send({ jsonrpc: '2.0', id: 902, method: 'workspace/inlayHint/refresh' })
      send({ jsonrpc: '2.0', id: 903, method: 'workspace/semanticTokens/refresh' })
    }
    const diagnostics = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [{
          message: 'fake diagnostic',
          severity: 2,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          source: 'fake-lsp',
        }],
      },
    }
    send(diagnostics)
    send(diagnostics)
    send({ jsonrpc: '2.0', method: 'language/status', params: { type: 'ServiceReady', message: 'Ready' } })
    send({ jsonrpc: '2.0', method: 'language/status', params: { type: 'ServiceReady', message: 'Ready' } })
    return
  }
  if (id === undefined) return
  const uri = params.textDocument?.uri || `${rootUri}/main.fake`
  if (method === 'textDocument/hover') {
    reply(id, { contents: { kind: 'markdown', value: '**fake hover**' } })
    return
  }
  if (['textDocument/definition', 'textDocument/references', 'textDocument/implementation'].includes(method)) {
    reply(id, [{
      uri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    }])
    return
  }
  if (method === 'textDocument/documentHighlight') {
    reply(id, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      kind: 2,
    }, {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
      kind: 3,
    }])
    return
  }
  if (method === 'textDocument/semanticTokens/full') {
    reply(id, { resultId: 'fake-semantic-1', data: [0, 0, 4, 1, 1] })
    return
  }
  if (method === 'textDocument/inlayHint') {
    reply(id, [{
      position: { line: 0, character: 4 },
      label: [{ value: ': number', tooltip: { kind: 'markdown', value: '**inferred type**' } }],
      kind: 1,
      tooltip: 'fake inlay hint',
      paddingLeft: true,
    }])
    return
  }
  if (method === 'textDocument/documentSymbol') {
    reply(id, [{
      name: 'main',
      detail: 'fake symbol',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    }])
    return
  }
  if (method === 'workspace/symbol') {
    reply(id, [{
      name: 'main',
      kind: 12,
      location: {
        uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      },
    }])
    return
  }
  if (method === 'textDocument/prepareCallHierarchy' || method === 'textDocument/prepareTypeHierarchy') {
    reply(id, [hierarchyItem(uri)])
    return
  }
  if (method === 'callHierarchy/incomingCalls') {
    reply(id, [{ from: hierarchyItem(uri, 'caller'), fromRanges: [] }])
    return
  }
  if (method === 'callHierarchy/outgoingCalls') {
    reply(id, [{ to: hierarchyItem(uri, 'callee'), fromRanges: [] }])
    return
  }
  if (method === 'typeHierarchy/supertypes' || method === 'typeHierarchy/subtypes') {
    reply(id, [hierarchyItem(uri, method.endsWith('supertypes') ? 'base' : 'derived')])
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } })
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] || 0)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + length) return
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
    buffer = buffer.subarray(bodyStart + length)
    handle(JSON.parse(body))
  }
})
