/** dsh-attachments browser half. */

import {
  memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
} from 'react'

const CLIENT_BUNDLE_ID = 'dsh-attachments'
const AUTO_DRAFT_MARKER = '\u2063'
const ATTACHMENT_SOURCE_FIELD = 'dshAttachments'
const ROUTE_PREFIX = '/dsh-attachments/files'
const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

type UploadStatus = 'uploading' | 'ready' | 'error'
type AttachmentKind = 'file' | 'directory'

interface AttachmentDraft {
  localId: string
  id?: string
  kind: AttachmentKind
  name: string
  mediaType: string
  size: number
  fileCount?: number
  status: UploadStatus
  error?: string
}

interface LoggedFile {
  id: string
  kind?: AttachmentKind
  name: string
  mediaType: string
  size: number
  fileCount?: number
  path?: string
}

interface FileNodeData {
  seq: number
  time: number
  messageId: string
  files: LoggedFile[]
}

interface InputProps {
  sessionId: string
  session: { removed?: boolean }
  input: { draft: string; phase: string }
  inputActions: { setDraft(text: string): void }
}

interface HistoryProps {
  sessionId: string
  node: { data: FileNodeData }
}

class DraftFiles {
  private readonly rows = new Map<string, AttachmentDraft[]>()
  private readonly listeners = new Map<string, Set<() => void>>()

  snapshot(sessionId: string): readonly AttachmentDraft[] {
    return this.rows.get(sessionId) ?? EMPTY_FILES
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let group = this.listeners.get(sessionId)
    if (group === undefined) {
      group = new Set()
      this.listeners.set(sessionId, group)
    }
    group.add(listener)
    return () => {
      group?.delete(listener)
      if (group?.size === 0) this.listeners.delete(sessionId)
    }
  }

  add(sessionId: string, file: AttachmentDraft): void {
    this.rows.set(sessionId, [...this.snapshot(sessionId), file])
    this.publish(sessionId)
  }

  update(sessionId: string, localId: string, patch: Partial<AttachmentDraft>): void {
    this.rows.set(sessionId, this.snapshot(sessionId).map(file => file.localId === localId ? { ...file, ...patch } : file))
    this.publish(sessionId)
  }

  remove(sessionId: string, localId: string): void {
    const next = this.snapshot(sessionId).filter(file => file.localId !== localId)
    if (next.length === 0) this.rows.delete(sessionId)
    else this.rows.set(sessionId, [...next])
    this.publish(sessionId)
  }

  committed(sessionId: string, ids: ReadonlySet<string>): void {
    const next = this.snapshot(sessionId).filter(file => file.id === undefined || !ids.has(file.id))
    if (next.length === 0) this.rows.delete(sessionId)
    else this.rows.set(sessionId, [...next])
    this.publish(sessionId)
  }

  private publish(sessionId: string): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

const EMPTY_FILES: readonly AttachmentDraft[] = Object.freeze([])
const drafts = new DraftFiles()

function useFiles(sessionId: string): readonly AttachmentDraft[] {
  const subscribe = useCallback((listener: () => void) => drafts.subscribe(sessionId, listener), [sessionId])
  const snapshot = useCallback(() => drafts.snapshot(sessionId), [sessionId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function copy() {
  const zh = navigator.language.toLowerCase().startsWith('zh')
  return zh
    ? {
      remove: '移除', uploading: '上传中…',
        failed: '上传失败', folderReadFailed: '读取文件夹失败', download: '下载文件', attached: '附件',
        folder: '文件夹', files: (count: number) => `${String(count)} 个文件`,
      }
    : {
        remove: 'Remove', uploading: 'Uploading…',
        failed: 'Upload failed', folderReadFailed: 'Failed to read folder', download: 'Download file', attached: 'Attachments',
        folder: 'Folder', files: (count: number) => `${String(count)} files`,
      }
}

const labels = copy()

function endpoint(sessionId: string, id?: string): string {
  const suffix = id === undefined ? '' : `/${encodeURIComponent(id)}`
  return `${ROUTE_PREFIX}${suffix}?sessionId=${encodeURIComponent(sessionId)}`
}

function nativeImage(file: File): boolean {
  return NATIVE_IMAGE_TYPES.has(file.type)
}

function partitionDroppedFiles(files: readonly File[]): {
  nativeImages: File[]
  genericFiles: File[]
} {
  const nativeImages: File[] = []
  const genericFiles: File[] = []
  for (const file of files) {
    if (nativeImage(file)) nativeImages.push(file)
    else genericFiles.push(file)
  }
  return { nativeImages, genericFiles }
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? 'FILE' : name.slice(dot + 1, dot + 6).toUpperCase()
}

function filenameStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

interface FileIntakeSource {
  kind: 'file'
  file: File
  name: string
}

interface DirectoryIntakeSource {
  kind: 'directory'
  /** One logical attachment. Children are copied beneath this root, not added as cards. */
  entry: FileSystemDirectoryEntry
  name: string
}

type IntakeSource = FileIntakeSource | DirectoryIntakeSource

interface DirectoryMember {
  kind: AttachmentKind
  path: string
  file?: File
}

interface CapturedDropItem {
  entry: FileSystemEntry | null
  file: File | null
}

interface CollectedDrop {
  sources: IntakeSource[]
  errors: Array<{ name: string; error: unknown }>
}

async function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return await new Promise<File>((resolve, reject) => { entry.file(resolve, reject) })
}

async function directoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader()
  const output: FileSystemEntry[] = []
  // Chromium may return directory entries in several batches. Reading until
  // the first empty batch is required for folders with more than ~100 items.
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (batch.length === 0) return output
    output.push(...batch)
  }
}

function childName(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

async function directoryMembers(entry: FileSystemDirectoryEntry, parent = ''): Promise<DirectoryMember[]> {
  const output: DirectoryMember[] = []
  for (const child of await directoryEntries(entry)) {
    const path = childName(parent, child.name || 'attachment')
    if (child.isDirectory) {
      const directory = child as FileSystemDirectoryEntry
      output.push({ kind: 'directory', path })
      output.push(...await directoryMembers(directory, path))
    } else if (child.isFile) {
      const file = await fileFromEntry(child as FileSystemFileEntry)
      output.push({ kind: 'file', path, file })
    }
  }
  return output
}

async function sourceFromEntry(entry: FileSystemEntry): Promise<IntakeSource | null> {
  if (entry.isDirectory) {
    return {
      kind: 'directory',
      entry: entry as FileSystemDirectoryEntry,
      name: entry.name || 'folder',
    }
  }
  if (!entry.isFile) return null
  const file = await fileFromEntry(entry as FileSystemFileEntry)
  return { kind: 'file', file, name: file.name || entry.name || 'attachment' }
}

function captureDropItems(transfer: DataTransfer): CapturedDropItem[] {
  const captured: CapturedDropItem[] = []
  for (const item of [...transfer.items]) {
    if (item.kind !== 'file') continue
    let entry: FileSystemEntry | null = null
    try {
      entry = item.webkitGetAsEntry()
    } catch {
      // getAsFile below remains the cross-browser fallback for ordinary files.
    }
    captured.push({ entry, file: item.getAsFile() })
  }
  if (captured.length > 0) return captured
  return [...transfer.files].map(file => ({ entry: null, file }))
}

function pluginOwnsDrop(items: readonly CapturedDropItem[]): boolean {
  return items.some(item => item.entry?.isDirectory === true
    || (item.file !== null && !nativeImage(item.file)))
}

async function collectDrop(items: readonly CapturedDropItem[]): Promise<CollectedDrop> {
  const sources: IntakeSource[] = []
  const errors: CollectedDrop['errors'] = []
  for (const item of items) {
    try {
      if (item.entry?.isDirectory === true) {
        const source = await sourceFromEntry(item.entry)
        if (source !== null) sources.push(source)
      } else if (item.file !== null) {
        sources.push({
          kind: 'file',
          file: item.file,
          name: item.file.webkitRelativePath || item.file.name || 'attachment',
        })
      } else if (item.entry?.isFile === true) {
        const source = await sourceFromEntry(item.entry)
        if (source !== null) sources.push(source)
      }
    } catch (error) {
      errors.push({ name: item.entry?.name || item.file?.name || 'folder', error })
    }
  }
  return { sources, errors }
}

async function requestFileUpload(sessionId: string, source: FileIntakeSource): Promise<LoggedFile> {
  const query = new URLSearchParams({
    sessionId,
    name: source.file.name || 'attachment',
    mediaType: source.file.type || 'application/octet-stream',
  })
  const response = await fetch(`${ROUTE_PREFIX}?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': source.file.type || 'application/octet-stream' },
    body: source.file,
  })
  const payload = await response.json() as { ok: boolean; file?: LoggedFile; error?: string }
  if (!response.ok || !payload.ok || payload.file === undefined) {
    throw new Error(payload.error || `HTTP ${String(response.status)}`)
  }
  return payload.file
}

async function requestDirectoryUpload(
  sessionId: string,
  source: DirectoryIntakeSource,
  onCreated: (id: string) => void,
): Promise<LoggedFile> {
  const createQuery = new URLSearchParams({
    sessionId,
    kind: 'directory',
    name: source.name || 'folder',
    mediaType: 'inode/directory',
  })
  const createdResponse = await fetch(`${ROUTE_PREFIX}?${createQuery.toString()}`, { method: 'POST' })
  const createdPayload = await createdResponse.json() as { ok: boolean; file?: LoggedFile; error?: string }
  if (!createdResponse.ok || !createdPayload.ok || createdPayload.file?.id === undefined) {
    throw new Error(createdPayload.error || `HTTP ${String(createdResponse.status)}`)
  }
  const id = createdPayload.file.id
  onCreated(id)
  try {
    const members = await directoryMembers(source.entry)
    // One folder stays one attachment. Member transfers only reconstruct its
    // tree below the folder root and never create their own draft/history card.
    for (let offset = 0; offset < members.length; offset += UPLOAD_CONCURRENCY) {
      await Promise.all(members.slice(offset, offset + UPLOAD_CONCURRENCY).map(async (member) => {
        const query = new URLSearchParams({
          sessionId,
          kind: member.kind,
          path: member.path,
        })
        const response = await fetch(`${ROUTE_PREFIX}/${encodeURIComponent(id)}?${query.toString()}`, {
          method: 'PUT',
          ...(member.kind === 'file'
            ? {
                headers: { 'content-type': member.file?.type || 'application/octet-stream' },
                body: member.file,
              }
            : {}),
        })
        const payload = await response.json() as { ok: boolean; error?: string }
        if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${String(response.status)}`)
      }))
    }
    const finalizeResponse = await fetch(endpoint(sessionId, id), { method: 'PATCH' })
    const finalized = await finalizeResponse.json() as { ok: boolean; file?: LoggedFile; error?: string }
    if (!finalizeResponse.ok || !finalized.ok || finalized.file === undefined) {
      throw new Error(finalized.error || `HTTP ${String(finalizeResponse.status)}`)
    }
    return finalized.file
  } catch (error) {
    await fetch(endpoint(sessionId, id), { method: 'DELETE' }).catch(() => {})
    throw error
  }
}

async function upload(sessionId: string, source: IntakeSource, localId: string): Promise<void> {
  try {
    const file = source.kind === 'directory'
      ? await requestDirectoryUpload(sessionId, source, id => { drafts.update(sessionId, localId, { id }) })
      : await requestFileUpload(sessionId, source)
    drafts.update(sessionId, localId, {
      id: file.id,
      kind: file.kind === 'directory' ? 'directory' : 'file',
      status: 'ready',
      size: file.size,
      mediaType: file.mediaType,
      fileCount: file.fileCount,
    })
  } catch (error) {
    drafts.update(sessionId, localId, {
      status: 'error',
      error: `${source.kind === 'directory' ? `${labels.folderReadFailed}: ` : ''}${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

const uploadQueue: Array<() => Promise<void>> = []
let activeUploads = 0
const UPLOAD_CONCURRENCY = 4

function runUploadQueue(): void {
  while (activeUploads < UPLOAD_CONCURRENCY) {
    const task = uploadQueue.shift()
    if (task === undefined) return
    activeUploads += 1
    void task().finally(() => {
      activeUploads -= 1
      runUploadQueue()
    })
  }
}

function scheduleUpload(task: () => Promise<void>): void {
  uploadQueue.push(task)
  runUploadQueue()
}

function intake(sessionId: string, sources: readonly IntakeSource[]): void {
  for (const source of sources) {
    const localId = crypto.randomUUID()
    drafts.add(sessionId, {
      localId,
      kind: source.kind,
      name: source.name || 'attachment',
      mediaType: source.kind === 'directory' ? 'inode/directory' : source.file.type || 'application/octet-stream',
      size: source.kind === 'directory' ? 0 : source.file.size,
      status: 'uploading',
    })
    scheduleUpload(() => upload(sessionId, source, localId))
  }
}

function reportDropErrors(sessionId: string, errors: CollectedDrop['errors']): void {
  for (const row of errors) {
    drafts.add(sessionId, {
      localId: crypto.randomUUID(),
      kind: 'file',
      name: row.name,
      mediaType: 'application/octet-stream',
      size: 0,
      status: 'error',
      error: `${labels.folderReadFailed}: ${row.error instanceof Error ? row.error.message : String(row.error)}`,
    })
  }
}

async function hostState(sessionId: string, id: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint(sessionId, id), { method: 'HEAD', cache: 'no-store' })
      if (response.ok) return response.headers.get('x-dsh-attachment-state') ?? undefined
    } catch {
      // The local server may be between queue admission and durable append.
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)))
  }
  return undefined
}

async function reconcileCommitted(sessionId: string): Promise<number> {
  const ready = drafts.snapshot(sessionId).filter(
    (file): file is AttachmentDraft & { id: string } => file.status === 'ready' && file.id !== undefined,
  )
  const states = await Promise.all(ready.map(async file => ({ file, state: await hostState(sessionId, file.id) })))
  const committed = new Set(states
    .filter(row => row.state === 'reserved' || row.state === 'committed')
    .map(row => row.file.id))
  if (committed.size > 0) drafts.committed(sessionId, committed)
  return committed.size
}

function redispatchImages(files: readonly File[]): void {
  if (files.length === 0 || typeof DataTransfer === 'undefined') return
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
}

/** Clear Harness's bubble-phase image drag state after this plugin owns a file-only drop. */
function clearNativeDropOverlay(dataTransfer: DataTransfer | null): void {
  if (dataTransfer === null || typeof DragEvent === 'undefined') return
  document.body.dispatchEvent(new DragEvent('dragleave', {
    bubbles: true,
    clientX: 0,
    clientY: 0,
    dataTransfer,
  }))
}

function AttachmentDropOverlay() {
  useEffect(() => {
    // Harness keeps ownership of the illustration, copy and frosted sheet.
    // This body-level layer contributes only the requested dashed outline and
    // stays above transformed/sticky page layers without duplicating content.
    const mask = document.createElement('div')
    mask.className = 'dsh-attachments-drop'
    mask.setAttribute('aria-hidden', 'true')
    document.body.append(mask)
    return () => { mask.remove() }
  }, [])
  return null
}

function FileGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <rect x="4" y="2.75" width="12" height="14.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 7.25h6M7 10h6M7 12.75h4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <path d="M2.75 6.25A2.25 2.25 0 0 1 5 4h3l1.4 1.5H15A2.25 2.25 0 0 1 17.25 7.75v6A2.25 2.25 0 0 1 15 16H5a2.25 2.25 0 0 1-2.25-2.25v-7.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function FileCard({ file, sessionId, draft, onRemove }: {
  file: AttachmentDraft
  sessionId: string
  draft: boolean
  onRemove?: () => void
}) {
  const kind = file.kind === 'directory' ? 'directory' : 'file'
  const href = kind === 'directory' || file.id === undefined ? undefined : endpoint(sessionId, file.id)
  const suffix = kind === 'directory' ? labels.folder : extension(file.name)
  const state = file.status === 'uploading'
    ? labels.uploading
    : file.status === 'error'
      ? `${labels.failed}${file.error === undefined ? '' : `：${file.error}`}`
      : undefined
  return (
    <div className="dsh-attachments-file-card" data-kind={kind} data-status={file.status}>
      <div className="dsh-attachments-file-icon">{kind === 'directory' ? <FolderGlyph /> : <FileGlyph />}</div>
      <div className="dsh-attachments-file-copy">
        <span className="dsh-attachments-file-name" title={file.name}>{kind === 'directory' ? file.name : filenameStem(file.name)}</span>
        <span className="dsh-attachments-file-meta">
          {suffix}{kind === 'directory' && file.fileCount !== undefined ? ` · ${labels.files(file.fileCount)}` : ''}{state === undefined ? '' : ` · ${state}`}
        </span>
      </div>
      {draft && onRemove !== undefined
        ? <button className="dsh-attachments-file-action" type="button" onClick={onRemove} aria-label={`${labels.remove} ${file.name}`}>×</button>
        : href === undefined
          ? null
          : <a className="dsh-attachments-file-action" href={href} download={file.name} title={labels.download} aria-label={`${labels.download} ${file.name}`}>↓</a>}
    </div>
  )
}

function AttachmentDock({ sessionId, session, input, inputActions }: InputProps) {
  const files = useFiles(sessionId)
  const dock = useRef<HTMLDivElement | null>(null)
  const previousCount = useRef(files.length)
  const currentDraft = useRef(input.draft)
  currentDraft.current = input.draft
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const locked = session.removed === true || input.phase === 'submitting' || input.phase === 'adjudicating'

  useLayoutEffect(() => {
    const grew = files.length > previousCount.current
    previousCount.current = files.length
    if (!grew) return
    const rail = dock.current?.parentElement
    if (rail !== null && rail !== undefined) rail.scrollLeft = rail.scrollWidth - rail.clientWidth
  }, [files.length])

  const remove = useCallback((file: AttachmentDraft) => {
    drafts.remove(sessionId, file.localId)
    if (file.id !== undefined) void fetch(endpoint(sessionId, file.id), { method: 'DELETE' })
    const remaining = drafts.snapshot(sessionId)
    if (!remaining.some(candidate => candidate.status === 'ready') && input.draft === AUTO_DRAFT_MARKER) {
      inputActions.setDraft('')
    }
  }, [input.draft, inputActions, sessionId])

  useEffect(() => {
    if (!files.some(file => file.status === 'ready')
      || (input.draft !== '' && input.draft !== AUTO_DRAFT_MARKER)) return
    let active = true
    void reconcileCommitted(sessionId).then((count) => {
      if (!active || count === 0) return
      const readyRemain = drafts.snapshot(sessionId).some(file => file.status === 'ready')
      if (!readyRemain && currentDraft.current === AUTO_DRAFT_MARKER) inputActions.setDraft('')
    })
    return () => { active = false }
  }, [files, input.draft, inputActions, sessionId])

  useEffect(() => {
    if (!locked && files.some(file => file.status === 'ready') && input.draft.trim() === '') {
      inputActions.setDraft(AUTO_DRAFT_MARKER)
    }
  }, [files, input.draft, inputActions, locked])

  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files')
    const reset = (): void => { depth.current = 0; setDragging(false) }
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth.current += 1
      setDragging(true)
    }
    const over = (event: DragEvent): void => {
      if (!hasFiles(event) || event.dataTransfer === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
    }
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event) || event.dataTransfer === null) return
      reset()
      // Capture handles synchronously: browsers clear DataTransfer after the
      // drop callback, while directory traversal itself is asynchronous.
      const captured = captureDropItems(event.dataTransfer)
      if (!pluginOwnsDrop(captured)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      clearNativeDropOverlay(event.dataTransfer)
      if (locked) {
        return
      }
      void collectDrop(captured).then(({ sources, errors }) => {
        const nativeImages: File[] = []
        const genericFiles: IntakeSource[] = []
        for (const source of sources) {
          if (source.kind === 'file' && nativeImage(source.file)) nativeImages.push(source.file)
          else genericFiles.push(source)
        }
        intake(sessionId, genericFiles)
        reportDropErrors(sessionId, errors)
        if (nativeImages.length > 0) redispatchImages(nativeImages)
      })
    }
    document.addEventListener('dragenter', enter, true)
    document.addEventListener('dragover', over, true)
    document.addEventListener('dragleave', leave, true)
    document.addEventListener('drop', drop, true)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', enter, true)
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('dragleave', leave, true)
      document.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', reset)
    }
  }, [locked, sessionId])

  return (
    <>
      {files.length > 0 && (
        <div ref={dock} className="dsh-attachments-file-dock" data-attachment-content="" role="group" aria-label={labels.attached}>
          {files.map(file => <FileCard key={file.localId} file={file} sessionId={sessionId} draft onRemove={() => { remove(file) }} />)}
        </div>
      )}
      {dragging && <AttachmentDropOverlay />}
    </>
  )
}

const AttachmentHistory = memo(function AttachmentHistory({ sessionId, node }: HistoryProps) {
  const data = node.data
  return (
    <div className="dsh-attachments-history-row" role="group" aria-label={labels.attached}>
      <div className="dsh-attachments-history-stack">
        {data.files.map(file => (
          <FileCard
            key={file.id}
            file={{ ...file, kind: file.kind === 'directory' ? 'directory' : 'file', localId: file.id, status: 'ready' }}
            sessionId={sessionId}
            draft={false}
          />
        ))}
      </div>
    </div>
  )
})

function filesOfEvent(event: any): LoggedFile[] {
  if (event?.type !== 'user/message') return []
  const files = event.data?.source?.[ATTACHMENT_SOURCE_FIELD]
  if (!Array.isArray(files)) return []
  return files.filter((file: any) => file
    && typeof file.id === 'string'
    && typeof file.name === 'string'
    && typeof file.mediaType === 'string'
    && Number.isFinite(file.size)
    && (file.kind === undefined || file.kind === 'file' || file.kind === 'directory'))
}

const attachmentDefinition = {
  kind: 'dsh-attachments',
  target: 'chat',
  match(event: any) {
    const files = filesOfEvent(event)
    return files.length === 0 ? null : { id: String(event.data.id), role: 'start' }
  },
  start(_context: any, match: any): FileNodeData {
    const event = match.event
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      files: filesOfEvent(event),
    }
  },
  update(context: any) { return context.state },
  buildViewNode(context: any) {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'dsh-attachments',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq + 0.01,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

const STYLES = String.raw`
.dsh-attachments-file-dock{display:flex;flex:0 0 auto;align-items:center;gap:10px}
.dsh-attachments-file-card{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:224px;height:56px;flex:0 0 224px;padding:7px 28px 7px 7px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#d9dce1);border-radius:12px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#111)}
.dsh-attachments-file-card[data-status=error]{border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-attachments-file-icon{display:grid;place-items:center;width:40px;height:40px;flex:0 0 40px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#f3f4f6));color:var(--dsw-alias-label-secondary,#6b7280)}
.dsh-attachments-file-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.dsh-attachments-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:650;line-height:19px}.dsh-attachments-file-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:16px}
.dsh-attachments-file-action{position:absolute;top:4px;right:4px;z-index:1;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-button-contrast-fill,#fff);color:var(--dsw-alias-label-primary-inverted,#111);font-size:14px;font-weight:600;line-height:1;text-decoration:none;cursor:pointer;opacity:.96}.dsh-attachments-file-action:hover{transform:scale(1.06);opacity:1}
.dsh-attachments-drop{position:fixed;inset:10px;z-index:2147483647;box-sizing:border-box;border:2px dashed var(--dsw-alias-label-primary,#111);border-radius:18px;background:transparent;pointer-events:none;animation:dsh-attachments-drop-in .14s ease-out}@keyframes dsh-attachments-drop-in{from{opacity:0}to{opacity:1}}
.dsh-attachments-history-row{display:flex;justify-content:flex-end;padding:0 0 8px}.dsh-attachments-history-stack{display:flex;max-width:min(72%,620px);flex-wrap:wrap;justify-content:flex-end;gap:8px}
@media(prefers-reduced-motion:reduce){.dsh-attachments-drop{animation:none}.dsh-attachments-file-action:hover{transform:none}}@media(max-width:700px){.dsh-attachments-history-stack{max-width:90%}.dsh-attachments-file-card{width:200px;flex-basis:200px}}
`

function installStyles(): () => void {
  const existing = document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = CLIENT_BUNDLE_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots', 'conversationEvents']

export function apply(ctx: any): void {
  ctx.effect(installStyles, 'dsh-attachments: styles')

  ctx.conversationEvents.register(attachmentDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'dsh-attachments',
  }, AttachmentHistory))
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    id: 'dsh-attachments-files',
    order: -10,
  }, AttachmentDock))
}

/** Pure and registry-level seams used by the plugin bundle tests. */
export const internals = {
  attachmentDefinition,
  directoryMembers,
  filesOfEvent,
  collectDrop,
  nativeImage,
  partitionDroppedFiles,
  pluginOwnsDrop,
}
