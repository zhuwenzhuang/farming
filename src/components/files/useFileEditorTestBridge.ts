import { useEffect, type MutableRefObject } from 'react'
import type * as monaco from 'monaco-editor'

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingFileEditorTest?: {
      focus: () => boolean
      insertText: (text: string) => boolean
      getValue: () => string
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
      getValue() {
        return editorRef.current?.getValue() ?? ''
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
