import { useEffect, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingFileEditorTest?: {
      focus: () => boolean
      revealLine: (lineNumber: number) => boolean
      insertText: (text: string) => boolean
      undo: () => boolean
      getValue: () => string
      getScrollTop: () => number
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
  onFocusEditor: () => void
}

export function useFileEditorTestBridge({
  editorRef,
  onFocusEditor,
}: UseFileEditorTestBridgeOptions) {
  useEffect(() => {
    if (!window.__FARMING_E2E__) return undefined

    const testApi = {
      focus() {
        onFocusEditor()
        return Boolean(editorRef.current)
      },
      revealLine(lineNumber: number) {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || !model) return false
        const targetLine = Math.min(Math.max(1, lineNumber), model.getLineCount())
        editor.setPosition({ lineNumber: targetLine, column: 1 })
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
      getScrollTop() {
        return editorRef.current?.getScrollTop() ?? 0
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
  }, [editorRef, onFocusEditor])
}
