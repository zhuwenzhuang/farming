/// <reference lib="webworker" />

import { parseSpreadsheetWorkbook } from '@/lib/spreadsheet-workbook'

interface SpreadsheetWorkerRequest {
  buffer: ArrayBuffer
  fileName: string
}

const workerScope = self as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<SpreadsheetWorkerRequest>) => {
  try {
    const workbook = parseSpreadsheetWorkbook(event.data.buffer, event.data.fileName)
    workerScope.postMessage({ workbook })
  } catch (error) {
    workerScope.postMessage({
      error: error instanceof Error ? error.message : 'Unable to parse this spreadsheet.',
    })
  }
}

export {}
