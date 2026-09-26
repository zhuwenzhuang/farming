import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import type * as monaco from 'monaco-editor'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { workspaceBlameAuthorProfileUrl, workspaceBlameCommitUrl } from '@/lib/workspace-editor-model'
import type { CodeCopy } from '../code/copy'
import { FileEditorContextMenu } from './FileEditorContextMenu'
import { FileEditorInlineBlameLayer } from './FileEditorInlineBlameLayer'
import { FileEditorBlameDetail } from './FileEditorBlameDetail'
import { FileEditorBlameToast } from './FileEditorBlameToast'
import { useFileEditorBlameController } from './useFileEditorBlameController'
import { useFileEditorBlameOverlayController } from './useFileEditorBlameOverlayController'
import { useFileEditorContextMenuController } from './useFileEditorContextMenuController'

const noAction = () => {}
const noAsyncAction = async () => {}

/** Each diff side owns its model, history target, requests, and annotations. */
export function FileEditorDiffBlame({ openFile, editor, content, revision, disabled, copy }: {
  openFile: OpenWorkspaceFile
  editor: monaco.editor.IStandaloneCodeEditor
  content: string
  revision?: string
  disabled: boolean
  copy: CodeCopy
}) {
  const editorRef = useRef(editor)
  const editorHostRef = useRef(editor.getDomNode())
  const snapshot = useMemo(() => ({ revision, content, mismatchMessage: copy.blameDiffChanged }), [revision, content, copy.blameDiffChanged])
  const blame = useFileEditorBlameController({ openFile, disabled, snapshot, onRevealLine: noAction })
  const menu = useFileEditorContextMenuController({
    scope: `${openFile.agentId}:${openFile.file.path}:${revision ?? 'working'}`,
    active: true,
    editorRef,
    readOnly: true,
    canShowBlame: !disabled,
    blameOpen: blame.blameOpen,
    blameCapability: blame.blameCapability,
    blameInEditorContext: true,
    canShowLineChanges: false,
    languageServerAvailable: false,
    onCheckBlameCapability: blame.checkBlameCapability,
    onToggleBlame: blame.toggleBlame,
    onClearBlameDetail: blame.clearBlameDetail,
    onCloseTabContextMenu: noAction,
    onOpenLineChanges: noAsyncAction,
    onRunLanguageServerAction: noAsyncAction,
  })
  const { blameOverlay } = useFileEditorBlameOverlayController({
    editorRef, editorHostRef, disabled, blame: blame.blame,
    blameLabelWidths: blame.blameLabelWidths, blameOpen: blame.blameOpen,
  })

  useEffect(() => {
    const subscription = editor.onContextMenu(menu.openEditorContextMenu)
    return () => subscription.dispose()
  }, [editor, menu.openEditorContextMenu])

  const detail = blame.blameDetail?.line
  return <>
    {editorHostRef.current && createPortal(
      <FileEditorInlineBlameLayer
        {...blameOverlay}
        viewport={{ ...blameOverlay.viewport, left: 0, top: 0 }}
        copy={copy}
        onShowDetail={blame.showBlameDetail}
        onContextMenu={menu.openBlameContextMenu}
      />, editorHostRef.current,
    )}
    {menu.editorContextMenu && <FileEditorContextMenu
      {...menu.editorContextMenu}
      copy={copy}
      readOnly
      blameOpen={blame.blameOpen}
      blameCapability={blame.blameCapability}
      showBlameContextAction={menu.showBlameContextAction}
      showLineChangesContextActions={false}
      showLanguageServerActions={false}
      onClose={menu.closeEditorContextMenu}
      onRunAction={action => void menu.runEditorContextAction(action)}
    />}
    {detail && <FileEditorBlameDetail
      line={detail}
      filePath={openFile.file.path}
      authorProfileUrl={workspaceBlameAuthorProfileUrl(detail.author, blame.blame?.authorUrlTemplate || '')}
      commitUrl={workspaceBlameCommitUrl(detail.commit, blame.blame?.commitUrlTemplate || '')}
      issueLinkRules={blame.blame?.issueLinkRules ?? []}
      copy={copy}
      onClose={blame.clearBlameDetail}
    />}
    {blame.blameOpen && <FileEditorBlameToast
      blame={blame.blame}
      loading={blame.blameLoading}
      error={blame.blameError}
      dirty={false}
      onRetry={() => void blame.retryBlame()}
      copy={copy}
    />}
    {menu.clipboardWriteFailed && <div className="code-file-clipboard-alert" role="alert">{copy.copyFailed}</div>}
  </>
}
