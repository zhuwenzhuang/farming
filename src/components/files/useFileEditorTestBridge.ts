import { useEffect, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'

const modelTestIds = new WeakMap<monaco.editor.ITextModel, number>()
let nextModelTestId = 1

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingFileEditorTest?: {
      focus: () => boolean
      revealLine: (lineNumber: number, column?: number) => boolean
      insertText: (text: string) => boolean
      undo: () => boolean
      getValue: () => string
      getLanguageId: () => string | null
      getModelId: () => number | null
      getPosition: () => { lineNumber: number; column: number } | null
      getScrollTop: () => number
      getFocusEditorRequestId: () => number | null
      getMarkers: () => Array<{ code: string; message: string; severity: number }>
      getTypeScriptDiagnosticsOptions: () => {
        noSemanticValidation?: boolean
        noSyntaxValidation?: boolean
        noSuggestionDiagnostics?: boolean
      }
    }
  }
}

interface UseFileEditorTestBridgeOptions {
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  focusEditorRequestId?: number
  onFocusEditor: () => void
}

export function useFileEditorTestBridge({
  editorRef,
  focusEditorRequestId,
  onFocusEditor,
}: UseFileEditorTestBridgeOptions) {
  useEffect(() => {
    if (!window.__FARMING_E2E__) return undefined

    const testApi = {
      focus() {
        onFocusEditor()
        return Boolean(editorRef.current)
      },
      revealLine(lineNumber: number, column = 1) {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || !model) return false
        const targetLine = Math.min(Math.max(1, lineNumber), model.getLineCount())
        const targetColumn = Math.min(Math.max(1, column), model.getLineMaxColumn(targetLine))
        editor.setPosition({ lineNumber: targetLine, column: targetColumn })
        editor.revealLineInCenter(targetLine)
        editor.focus()
        return true
      },
      insertText(text: string) {
        const editor = editorRef.current
        const selection = editor?.getSelection()
        if (!editor || !selection) return false

        editor.pushUndoStop()
        editor.executeEdits('farming-e2e', [{
          range: selection,
          text,
          forceMoveMarkers: true,
        }])
        editor.pushUndoStop()
        editor.focus()
        return true
      },
      undo() {
        const editor = editorRef.current
        if (!editor) return false
        editor.focus()
        editor.trigger('farming-e2e', 'undo', null)
        return true
      },
      getValue() {
        return editorRef.current?.getValue() ?? ''
      },
      getLanguageId() {
        return editorRef.current?.getModel()?.getLanguageId() ?? null
      },
      getModelId() {
        const model = editorRef.current?.getModel()
        if (!model) return null
        let id = modelTestIds.get(model)
        if (id === undefined) {
          id = nextModelTestId
          nextModelTestId += 1
          modelTestIds.set(model, id)
        }
        return id
      },
      getPosition() {
        return editorRef.current?.getPosition() ?? null
      },
      getScrollTop() {
        return editorRef.current?.getScrollTop() ?? 0
      },
      getFocusEditorRequestId() {
        return focusEditorRequestId ?? null
      },
      getMarkers() {
        const model = editorRef.current?.getModel()
        if (!model) return []
        return monaco.editor.getModelMarkers({ resource: model.uri }).map(marker => ({
          code: String(marker.code ?? ''),
          message: marker.message,
          severity: marker.severity,
        }))
      },
      getTypeScriptDiagnosticsOptions() {
        return monaco.typescript.typescriptDefaults.getDiagnosticsOptions()
      },
    }
    window.__farmingFileEditorTest = testApi

    return () => {
      if (window.__farmingFileEditorTest === testApi) {
        delete window.__farmingFileEditorTest
      }
    }
  }, [editorRef, focusEditorRequestId, onFocusEditor])
}
