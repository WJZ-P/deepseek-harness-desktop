/**
 * dsh-attachments, Host half.
 *
 * This standard DSH bundle deliberately lives outside the vendored `harness/`
 * tree. Its `dsh.bundle` patch activates this Host half and its `dsh.client`
 * declaration exposes the browser half through Harness's standard package
 * discovery. The same package can therefore run in native DSH or be preloaded
 * by the Desktop distribution without separate implementations.
 */

import { randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import {
  copyFile, cp, mkdir, readFile, readdir, rm, stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path'
import { pipeline } from 'node:stream/promises'

export const name = 'dsh-attachments'
export const inject = ['webServer', 'sessions']

// U+2063 is invisible but not JavaScript whitespace, so Harness's existing
// composer enables file-only submit without showing synthetic copy to users.
export const AUTO_DRAFT_MARKER = '\u2063'
export const ATTACHMENT_SOURCE_FIELD = 'dshAttachments'
export const ATTACHMENT_PROMPT_FIELD = 'dshAttachmentPrompt'
export const ROUTE_PREFIX = '/dsh-attachments/files'

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

/** @typedef {'file' | 'directory'} AttachmentKind */
/** @typedef {{ id: string, kind: AttachmentKind, name: string, mediaType: string, size: number, fileCount?: number, objectPath: string, workspacePath?: string }} StoredFile */

/** Restrict a caller filename to one portable, path-free display segment. */
export function sanitizeFilename(value) {
  const leaf = basename(String(value || 'attachment').replaceAll('\\', '/'))
  const clean = leaf
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180)
  return clean || 'attachment'
}

/** Normalize untrusted browser MIME metadata before it becomes a response header. */
export function normalizeMediaType(value) {
  const bare = String(value || '').split(';', 1)[0].trim()
  return MEDIA_TYPE.test(bare) ? bare.toLowerCase() : 'application/octet-stream'
}

function normalizeKind(value) {
  return value === 'directory' ? 'directory' : 'file'
}

/** Resolve one browser-supplied member path below a staged directory root. */
export function directoryMemberPath(root, value) {
  const raw = String(value || '').replaceAll('\\', '/')
  if (raw === '' || raw.length > 4096 || isAbsolute(raw) || raw.startsWith('/')) {
    throw new Error('missing or invalid directory member path')
  }
  const segments = raw.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new Error('missing or invalid directory member path')
  }
  const destination = resolve(root, ...segments)
  const rel = relative(root, destination)
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('directory member path escapes its attachment root')
  }
  return destination
}

/** Model-visible locator copy. File bytes stay outside the message and are read through ordinary workspace tools. */
export function attachmentPrompt(files) {
  const lines = files.map((file) => {
    const locator = file.workspacePath ?? file.objectPath
    if (file.kind === 'directory') {
      return `- 文件夹 ${JSON.stringify(file.name)} (${String(file.fileCount ?? 0)} 个文件，${formatBytes(file.size)}): ${locator}`
    }
    return `- 文件 ${JSON.stringify(file.name)} (${formatBytes(file.size)}, ${file.mediaType || 'application/octet-stream'}): ${locator}`
  })
  return [
    `📎 已附加 ${String(files.length)} 个附件。需要读取内容时，请使用文件工具打开以下路径：`,
    ...lines,
  ].join('\n')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

function objectPath(root, id) {
  return join(root, 'objects', id.slice(0, 2), id)
}

function publicFile(file) {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    ...(file.fileCount === undefined ? {} : { fileCount: file.fileCount }),
    ...(file.workspacePath === undefined ? {} : { path: file.workspacePath }),
  }
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function errorResponse(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400
  json(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

function requiredQuery(url, key, max = 500) {
  const value = url.searchParams.get(key)
  if (value === null || value === '' || value.length > max) {
    const error = new Error(`missing or invalid ${key}`)
    error.status = 400
    throw error
  }
  return value
}

function filesInMessage(message) {
  const source = message?.source
  const value = source && typeof source === 'object' ? source[ATTACHMENT_SOURCE_FIELD] : undefined
  return Array.isArray(value) ? value : []
}

function storedFilesInMessage(message, storageRoot) {
  return filesInMessage(message)
    .filter(file => file
      && FILE_ID.test(file.id)
      && typeof file.name === 'string'
      && Number.isSafeInteger(file.size)
      && file.size >= 0)
    .map(file => ({
      id: file.id,
      kind: normalizeKind(file.kind),
      name: sanitizeFilename(file.name),
      mediaType: normalizeMediaType(file.mediaType),
      size: file.size,
      ...(Number.isSafeInteger(file.fileCount) && file.fileCount >= 0 ? { fileCount: file.fileCount } : {}),
      objectPath: objectPath(storageRoot, file.id),
      ...(typeof file.path === 'string' ? { workspacePath: file.path } : {}),
    }))
}

async function directorySummary(root) {
  let size = 0
  let fileCount = 0
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const metadata = await stat(path)
        size += metadata.size
        fileCount += 1
      }
    }
  }
  await visit(root)
  return { size, fileCount }
}

function committedFile(session, id) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'user/message') continue
    const found = filesInMessage(event.data).find(file => file?.id === id)
    if (found !== undefined) return found
  }
  return undefined
}

async function materializeWorkspaceCopies(agent, files) {
  const cwd = typeof agent.session.header.cwd === 'string' && agent.session.header.cwd !== ''
    ? resolve(agent.session.header.cwd)
    : undefined
  if (cwd === undefined) return files
  const directory = resolve(cwd, '.deepseek-harness', 'attachments')
  const rel = relative(cwd, directory)
  if (rel.startsWith(`..${sep}`) || rel === '..') return files
  try {
    await mkdir(directory, { recursive: true })
  } catch {
    return files
  }
  return await Promise.all(files.map(async (file) => {
    const outputName = `${file.id.slice(0, 8)}-${sanitizeFilename(file.name)}`
    const destination = join(directory, outputName)
    try {
      if (file.kind === 'directory') {
        await cp(file.objectPath, destination, { recursive: true, force: false, errorOnExist: true })
      } else {
        await copyFile(file.objectPath, destination, fsConstants.COPYFILE_EXCL)
      }
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ERR_FS_CP_EEXIST') return file
    }
    return { ...file, workspacePath: relative(cwd, destination).split(sep).join('/') }
  }))
}

function augmentMessage(message, files) {
  const previousPrompt = typeof message.source?.[ATTACHMENT_PROMPT_FIELD] === 'string'
    ? message.source[ATTACHMENT_PROMPT_FIELD]
    : undefined
  const prompt = attachmentPrompt(files)
  const content = []
  for (const block of message.content) {
    if (block?.type !== 'text') {
      content.push(block)
      continue
    }
    const text = block.text.replaceAll(AUTO_DRAFT_MARKER, '')
    if (text === '' || text === previousPrompt) continue
    content.push(text === block.text ? block : { ...block, text })
  }
  return {
    ...message,
    source: {
      ...message.source,
      [ATTACHMENT_SOURCE_FIELD]: files.map(publicFile),
      [ATTACHMENT_PROMPT_FIELD]: prompt,
    },
    content: [...content, { type: 'text', text: prompt }],
  }
}

function downloadName(name) {
  const ascii = sanitizeFilename(name).replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Mount file transport and prompt association; dsh.client owns browser discovery. */
export function apply(ctx) {
  const storageRoot = join(dshHome(), 'dsh-attachments', 'v1')
  /** @type {Map<string, StoredFile[]>} */
  const pendingBySession = new Map()
  /** @type {Map<string, { sessionId: string, file: StoredFile }>} */
  const stagingDirectories = new Map()
  /** @type {Map<string, { sessionId: string, files: StoredFile[] }>} */
  const pendingByMessage = new Map()
  /** @type {Map<string, Array<{ files: StoredFile[], canceled: boolean }>>} */
  const editTransfers = new Map()

  const reservedFile = (sessionId, id) => {
    for (const reserved of pendingByMessage.values()) {
      if (reserved.sessionId !== sessionId) continue
      const file = reserved.files.find(candidate => candidate.id === id)
      if (file !== undefined) return file
    }
    return undefined
  }

  const route = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const tail = url.pathname === ROUTE_PREFIX
        ? ''
        : url.pathname.startsWith(`${ROUTE_PREFIX}/`)
          ? decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1))
          : undefined
      if (tail === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      const sessionId = requiredQuery(url, 'sessionId', 200)
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        const error = new Error('unknown or inactive session')
        error.status = 404
        throw error
      }

      if (req.method === 'POST' && tail === '') {
        const kind = normalizeKind(url.searchParams.get('kind'))
        const name = sanitizeFilename(requiredQuery(url, 'name', 500))
        const mediaType = kind === 'directory'
          ? 'inode/directory'
          : normalizeMediaType(url.searchParams.get('mediaType'))
        const id = randomUUID()
        const path = objectPath(storageRoot, id)
        await mkdir(dirname(path), { recursive: true })
        if (kind === 'directory') {
          await mkdir(path)
          const file = { id, kind, name, mediaType, size: 0, fileCount: 0, objectPath: path }
          stagingDirectories.set(id, { sessionId, file })
          json(res, 201, { ok: true, file: publicFile(file) })
          return
        }
        try {
          // Stream directly to the private object store. The plugin imposes
          // no arbitrary byte ceiling and never buffers a whole upload in
          // the Host process; available disk and transport capacity are the
          // natural bounds.
          await pipeline(req, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
        } catch (error) {
          await rm(path, { force: true }).catch(() => {})
          throw error
        }
        const metadata = await stat(path)
        const file = { id, kind, name, mediaType, size: metadata.size, objectPath: path }
        const current = pendingBySession.get(sessionId) ?? []
        pendingBySession.set(sessionId, [...current, file])
        json(res, 201, { ok: true, file: publicFile(file) })
        return
      }

      if (!FILE_ID.test(tail)) {
        const error = new Error('invalid attachment id')
        error.status = 404
        throw error
      }

      if (req.method === 'PUT') {
        const staged = stagingDirectories.get(tail)
        if (staged === undefined || staged.sessionId !== sessionId) {
          const error = new Error('staged directory attachment not found')
          error.status = 404
          throw error
        }
        const memberKind = url.searchParams.get('kind')
        if (memberKind !== 'file' && memberKind !== 'directory') {
          const error = new Error('missing or invalid directory member kind')
          error.status = 400
          throw error
        }
        const destination = directoryMemberPath(staged.file.objectPath, requiredQuery(url, 'path', 4096))
        if (memberKind === 'directory') {
          await mkdir(destination, { recursive: true })
        } else {
          await mkdir(dirname(destination), { recursive: true })
          try {
            await pipeline(req, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
          } catch (error) {
            await rm(destination, { force: true }).catch(() => {})
            throw error
          }
        }
        json(res, 201, { ok: true })
        return
      }

      if (req.method === 'PATCH') {
        const staged = stagingDirectories.get(tail)
        if (staged === undefined || staged.sessionId !== sessionId) {
          const error = new Error('staged directory attachment not found')
          error.status = 404
          throw error
        }
        const summary = await directorySummary(staged.file.objectPath)
        const file = { ...staged.file, ...summary }
        stagingDirectories.delete(tail)
        const current = pendingBySession.get(sessionId) ?? []
        pendingBySession.set(sessionId, [...current, file])
        json(res, 200, { ok: true, file: publicFile(file) })
        return
      }

      if (req.method === 'DELETE') {
        const current = pendingBySession.get(sessionId) ?? []
        const pending = current.find(candidate => candidate.id === tail)
        const staged = stagingDirectories.get(tail)
        const file = pending ?? (staged?.sessionId === sessionId ? staged.file : undefined)
        if (file === undefined) {
          const error = new Error('pending attachment not found')
          error.status = 404
          throw error
        }
        if (pending !== undefined) {
          const next = current.filter(candidate => candidate.id !== tail)
          if (next.length === 0) pendingBySession.delete(sessionId)
          else pendingBySession.set(sessionId, next)
        } else {
          stagingDirectories.delete(tail)
        }
        await rm(file.objectPath, { recursive: true, force: true })
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const pending = (pendingBySession.get(sessionId) ?? []).find(candidate => candidate.id === tail)
        const reserved = reservedFile(sessionId, tail)
        const logged = committedFile(session, tail)
        if (pending === undefined && reserved === undefined && logged === undefined) {
          const error = new Error('attachment not found in this session')
          error.status = 404
          throw error
        }
        const file = pending ?? reserved ?? logged
        const kind = normalizeKind(file.kind)
        if (req.method === 'GET' && kind === 'directory') {
          const error = new Error('directory attachments are read through their workspace path')
          error.status = 409
          throw error
        }
        const path = objectPath(storageRoot, tail)
        const metadata = kind === 'file' ? await stat(path) : undefined
        const displayName = sanitizeFilename(pending?.name ?? reserved?.name ?? logged.name)
        const mediaType = normalizeMediaType(pending?.mediaType ?? reserved?.mediaType ?? logged.mediaType)
        const state = pending !== undefined ? 'pending' : reserved !== undefined ? 'reserved' : 'committed'
        res.writeHead(200, {
          'content-type': mediaType,
          'content-length': String(kind === 'directory' ? file.size : metadata.size),
          ...(kind === 'directory' ? {} : { 'content-disposition': downloadName(displayName) }),
          'cache-control': 'private, no-store',
          'x-dsh-attachment-state': state,
        })
        if (req.method === 'HEAD') {
          res.end()
        } else if (typeof res.write === 'function') {
          // Keep downloads constant-memory too: a large attachment should not
          // be copied into one Host-side Buffer merely to reach the browser.
          await pipeline(createReadStream(path), res)
        } else {
          // Minimal response doubles used by embedders may only expose end().
          res.end(await readFile(path))
        }
        return
      }

      res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, PATCH, DELETE' })
      res.end()
    } catch (error) {
      errorResponse(res, error)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: route }),
    'dsh-attachments: file route',
  )

  const retireFiles = (files) => Promise.all(
    files.map(file => rm(file.objectPath, { recursive: true, force: true }).catch(() => {})),
  )

  const takeEditTransfer = (sessionId) => {
    const rows = editTransfers.get(sessionId)
    const row = rows?.shift()
    if (rows?.length === 0) editTransfers.delete(sessionId)
    if (row === undefined) return undefined
    row.canceled = true
    return row.files
  }

  const deferCanceledFiles = (sessionId, files) => {
    const row = { files, canceled: false }
    editTransfers.set(sessionId, [...(editTransfers.get(sessionId) ?? []), row])
    queueMicrotask(() => {
      if (row.canceled) return
      const rows = editTransfers.get(sessionId) ?? []
      const next = rows.filter(candidate => candidate !== row)
      if (next.length === 0) editTransfers.delete(sessionId)
      else editTransfers.set(sessionId, next)
      void retireFiles(files)
    })
  }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // The replacement below re-emits inserted synchronously. Its metadata is
    // the recursion guard and makes queued-message previews useful immediately.
    if (filesInMessage(message).length > 0) return
    const sessionId = String(agent.id)
    const transferred = takeEditTransfer(sessionId)
    const files = transferred ?? pendingBySession.get(sessionId)
    if (files === undefined || files.length === 0) return
    if (transferred === undefined) pendingBySession.delete(sessionId)
    const decorated = augmentMessage(message, files)
    if (!agent.inbox.replace(message.id, decorated)) {
      pendingBySession.set(sessionId, [...files, ...(pendingBySession.get(sessionId) ?? [])])
      return
    }
    pendingByMessage.set(String(message.id), { sessionId, files })
  })

  // Queue edits emit discarded(old) followed synchronously by inserted(new),
  // so the replacement inherits the files. A plain cancellation has no paired
  // insertion and the microtask retires its private object bytes.
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const reserved = pendingByMessage.get(String(message.id))
    const files = reserved?.files ?? storedFilesInMessage(message, storageRoot)
    if (files.length === 0) return
    if (reserved !== undefined) pendingByMessage.delete(String(message.id))
    deferCanceledFiles(String(agent.id), files)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) {
      for (const message of messages) {
        const reserved = pendingByMessage.get(String(message.id))
        if (reserved === undefined) continue
        pendingByMessage.delete(String(message.id))
        void retireFiles(reserved.files)
      }
      return decision
    }
    const accepted = new Set(decision.messages.map(message => String(message.id)))
    const output = []
    for (const message of decision.messages) {
      const reserved = pendingByMessage.get(String(message.id))
      const files = reserved?.files ?? storedFilesInMessage(message, storageRoot)
      if (files.length === 0) {
        output.push(message)
        continue
      }
      const materialized = await materializeWorkspaceCopies(agent, files)
      pendingByMessage.delete(String(message.id))
      output.push(augmentMessage(message, materialized))
    }
    // A downstream pre-step transform may intentionally drop a claimed
    // message. It will never become durable, so retire the now-unowned bytes.
    for (const message of messages) {
      const messageId = String(message.id)
      if (accepted.has(messageId)) continue
      const reserved = pendingByMessage.get(messageId)
      if (reserved === undefined) continue
      pendingByMessage.delete(messageId)
      void retireFiles(reserved.files)
    }
    return { ...decision, messages: output }
  })

  ctx.effect(() => async () => {
    const uncommitted = new Map()
    for (const staged of stagingDirectories.values()) uncommitted.set(staged.file.id, staged.file)
    for (const files of pendingBySession.values()) {
      for (const file of files) uncommitted.set(file.id, file)
    }
    for (const reserved of pendingByMessage.values()) {
      for (const file of reserved.files) uncommitted.set(file.id, file)
    }
    for (const rows of editTransfers.values()) {
      for (const row of rows) {
        if (!row.canceled) for (const file of row.files) uncommitted.set(file.id, file)
      }
    }
    stagingDirectories.clear()
    pendingBySession.clear()
    pendingByMessage.clear()
    editTransfers.clear()
    await retireFiles([...uncommitted.values()])
  }, 'dsh-attachments: pending file lifetime')
}

export const internals = {
  directorySummary,
  filesInMessage,
  storedFilesInMessage,
  augmentMessage,
  publicFile,
}
