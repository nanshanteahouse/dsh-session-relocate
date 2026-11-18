/**
 * Host half of the Session relocate bundle: one authenticated route that turns
 * one stored Session into an independent Session whose header `cwd` is another
 * Workspace's directory, then optionally archives the source.
 *
 * Why a clone and not a move: a Session belongs to exactly one Workspace, and
 * that membership is judged by `SessionHeader.cwd`, which is immutable once
 * written. `workingDirectory.set()` changes the effective directory but never
 * the owning project. So "drag a Session into another project" can only be
 * realized by creating a new Session whose header points at the target
 * directory and whose event prefix is the source's history — the same recipe
 * the built-in `session.fork` uses, with `cwd` taken from the target Workspace
 * and the child attached there.
 *
 * The bundle imports no `@deepseek-ai/*` package: a profile-installed bundle
 * resolves bare specifiers from the profile scope, not from the running
 * installation. Only `node:` builtins and ctx Services are used; the pure
 * fork-seed part is vendored in `./fork-seed.js`. Every failure the route can
 * produce is reported through the closed code list documented below; an
 * unexpected fault surfaces as `clone-failed` so clients never see an unknown
 * discriminator.
 *
 * Failure codes: invalid-request, invalid-session-id, source-not-found,
 * subagent-session, no-completed-turn, same-workspace, invalid-target,
 * workspace-not-found, target-not-found, target-not-a-directory, clone-failed,
 * attach-failed, method-not-allowed, content-type.
 * @module session-relocate
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { buildForkSeed, latestCompletedPrefixBoundary } from './fork-seed.js'

/** Row name used by the bundle patch. */
export const name = 'session-relocate'

/**
 * Services the route needs before it can answer. Everything else
 * (`workingDirectory`, `agentPresets`, `agentDefaultModel`, `fs`) is optional
 * and read with `ctx.get()` at request time, so the plugin still loads in a
 * composition that omits one of them.
 */
export const inject = ['connection', 'sessionQuery', 'agents', 'workspaceRegistry']

/** Absolute route path; the browser addresses `api/session.relocate`. */
export const SESSION_RELOCATE_PATH = '/api/session.relocate'

/** Browser-relative form of {@link SESSION_RELOCATE_PATH}. */
export const SESSION_RELOCATE_ROUTE = SESSION_RELOCATE_PATH.slice(1)

/** Largest JSON body the route reads. */
const MAX_BODY_BYTES = 4096

/** Stored Session ids are opaque, but never a path: refuse separators and dots. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** Accepted relocation modes. */
const MODES = new Set(['move', 'copy'])

/**
 * Register the relocate route.
 * @param ctx - Host context carrying Connection, Session query, Agents, and the
 *   Workspace registry.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_RELOCATE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleRelocate(ctx, request),
  }), 'session-relocate: relocate route')
}

/**
 * Answer one relocate request: `POST` a JSON body
 * `{ sessionId, mode: 'move'|'copy', target: { workspaceId }|{ path } }`.
 * @param ctx - Host context carrying the Session and Workspace services.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON `{ ok: true, ... }` or `{ ok: false, code, message, details? }`.
 */
export async function handleRelocate(ctx, request) {
  if (request.method !== 'POST') {
    return failure('method-not-allowed', 'POST only', 405)
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return failure('content-type', 'content type must be application/json', 415)
  }
  const text = await request.text().catch(() => '')
  if (text.length === 0 || text.length > MAX_BODY_BYTES) {
    return failure('invalid-request', 'body is empty or too large', 400)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return failure('invalid-request', 'body is not JSON', 400)
  }
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return failure('invalid-session-id', 'sessionId is not a stored Session id', 400)
  }
  const mode = payload?.mode === undefined ? 'move' : payload.mode
  if (!MODES.has(mode)) {
    return failure('invalid-request', 'mode must be "move" or "copy"', 400)
  }
  const target = payload?.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return failure('invalid-target', 'target must name a workspaceId or an absolute path', 400)
  }
  const namesWorkspace = typeof target.workspaceId === 'string' && target.workspaceId.length > 0
  const namesPath = typeof target.path === 'string' && target.path.length > 0
  if (namesWorkspace === namesPath) {
    return failure('invalid-target', 'target must name exactly one of workspaceId or path', 400)
  }

  try {
    return await relocate(ctx, { sessionId, mode, target })
  } catch (error) {
    // The failed operation is a clone in the caller's terms, even when the
    // fault came from an unexpected dependency. Keep the code list closed.
    warn(ctx, `session-relocate: relocation of "${sessionId}" failed`, error)
    return failure('clone-failed', messageOf(error), 500, { sessionId })
  }
}

/**
 * Resolve the requested target to one Workspace, registering an unowned
 * directory when the request names a path.
 * @param ctx - Host context carrying the Workspace registry and filesystem.
 * @param target - request target naming exactly one of `workspaceId` or `path`.
 * @returns the target Workspace, or the failure response to send.
 */
async function resolveTarget(ctx, target) {
  const registry = ctx.get('workspaceRegistry')

  if (target.workspaceId !== undefined) {
    const workspace = registry.get(target.workspaceId)
    if (workspace === undefined) {
      return {
        error: failure('workspace-not-found', `no Workspace has id "${target.workspaceId}"`, 404, {
          workspaceId: target.workspaceId,
        }),
      }
    }
    let status
    try {
      status = await workspace.status()
    } catch {
      status = 'missing-dir'
    }
    if (status !== 'ok') {
      return {
        error: failure('target-not-found', `the directory of workspace "${workspace.id}" no longer exists`, 409, {
          workspaceId: workspace.id,
          path: workspace.path,
        }),
      }
    }
    return { workspace }
  }

  if (!isAbsolute(target.path)) {
    return { error: failure('invalid-target', 'target.path must be an absolute path', 400, { path: target.path }) }
  }
  const inspected = await inspectDirectory(ctx, target.path)
  if (inspected.error !== undefined) return inspected
  try {
    // Idempotent: an already registered canonical path returns its Workspace.
    return { workspace: await registry.create(inspected.path) }
  } catch (error) {
    return { error: mapRegistryFailure(error, inspected.path) }
  }
}

/**
 * Validate a target directory through the composed filesystem before the
 * registry owns it, so the caller learns "missing" apart from "not a directory".
 * @param ctx - Host context carrying the filesystem service.
 * @param path - absolute directory path from the request.
 * @returns `{ path }` as the canonical spelling, or the failure response.
 */
async function inspectDirectory(ctx, path) {
  const fs = ctx.get('fs')
  if (fs === undefined) return { path }
  let resolved
  try {
    resolved = await fs.resolve(path, {})
  } catch (error) {
    return { error: mapFilesystemFailure(error, path) }
  }
  let info
  try {
    info = await fs.stat(resolved)
  } catch (error) {
    return { error: mapFilesystemFailure(error, path) }
  }
  if (info === undefined) {
    return { error: failure('target-not-found', `no directory exists at "${path}"`, 404, { path }) }
  }
  if (info.type !== 'directory') {
    return { error: failure('target-not-a-directory', `"${path}" is not a directory`, 409, { path }) }
  }
  return { path: fs.processPath(resolved) }
}

/**
 * Validate the source Session, resolve the target Workspace, clone the history
 * into it, and for `move` archive the source. The observation lease is released
 * before the response is returned.
 *
 * Source validation runs before the target is resolved on purpose: resolving a
 * path target can durably register a Workspace, and a request that turns out to
 * be unserviceable must not leave an empty project behind.
 * @param ctx - Host context carrying the Session and Workspace services.
 * @param request - validated session id, mode, and target description.
 * @returns the success or failure response.
 */
async function relocate(ctx, { sessionId, mode, target }) {
  let observation
  try {
    observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
  } catch (error) {
    if (typeof error?.code === 'string' && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return failure('source-not-found', `session "${sessionId}" not found`, 404, { sessionId })
    }
    warn(ctx, `session-relocate: source "${sessionId}" could not be observed`, error)
    return failure('clone-failed', messageOf(error), 500, { sessionId })
  }
  try {
    const header = observation.header
    if (header?.origin === 'subagent') {
      return failure('subagent-session', 'a subagent conversation cannot be relocated on its own', 409, { sessionId })
    }
    const events = observation.events
    const boundary = latestCompletedPrefixBoundary(events)
    if (boundary === undefined) {
      return failure('no-completed-turn', `session "${sessionId}" has no completed turn to copy`, 409, { sessionId })
    }
    const resolved = await resolveTarget(ctx, target)
    if (resolved.error !== undefined) return resolved.error
    const workspace = resolved.workspace
    const sameWorkspace = sameWorkspaceFailure(ctx, header, workspace, sessionId)
    if (sameWorkspace !== undefined) return sameWorkspace
    return await cloneInto(ctx, {
      header,
      events,
      boundary,
      projections: observation.projections?.values,
      sessionId,
      mode,
      workspace,
    })
  } finally {
    try {
      observation[Symbol.dispose]?.()
    } catch {
      // The lease is released exactly once; a repeated release is the only fault here.
    }
  }
}

/**
 * Refuse a relocation whose target is where the Session already belongs. The
 * immutable header names the owning project, so both a canonical-path match and
 * a registered-owner match mean "nothing to do".
 * @param ctx - Host context carrying the Workspace registry.
 * @param header - source Session header.
 * @param workspace - resolved target Workspace.
 * @param sessionId - source Session id.
 * @returns the failure response, or undefined when the target differs.
 */
function sameWorkspaceFailure(ctx, header, workspace, sessionId) {
  if (header.cwd !== undefined && header.cwd === workspace.path) {
    return failure('same-workspace', `session "${sessionId}" already runs in "${workspace.path}"`, 409, {
      sessionId, workspaceId: workspace.id,
    })
  }
  if (header.cwd === undefined) return undefined
  let owner
  try {
    owner = ctx.get('workspaceRegistry').list().find(entry => entry.path === header.cwd)
  } catch {
    owner = undefined
  }
  if (owner === undefined || owner.id !== workspace.id) return undefined
  return failure('same-workspace', `session "${sessionId}" already belongs to workspace "${workspace.id}"`, 409, {
    sessionId, workspaceId: workspace.id,
  })
}

/**
 * Clone one validated source Session into `workspace`.
 * @param ctx - Host context.
 * @param request - validated request plus the source cut it must carry.
 * @returns the response to send.
 */
async function cloneInto(ctx, { header, events, boundary, projections, sessionId, mode, workspace }) {
  const registry = ctx.get('workspaceRegistry')
  const presets = ctx.get('agentPresets')
  const presetId = typeof projections?.agentPreset === 'string' ? projections.agentPreset : undefined
  const agentOptions = selectRoute(ctx, projections?.modelSelection)
  const seed = buildForkSeed(events, boundary)
  const childId = `session-${randomUUID()}`

  // A clone must compose the same preset world as any other Session: the
  // source's recorded preset, or the deployment default when it recorded none.
  // Resolving with `undefined` is how the built-in fork selects that default;
  // skipping the mount would publish a tool-less Agent that still looks normal
  // in the sidebar, so a resolve failure fails the relocation instead.
  let resolvedPresetId
  if (presets !== undefined) {
    try {
      resolvedPresetId = (await presets.resolve(presetId)).id
    } catch (error) {
      warn(ctx, `session-relocate: agent preset of "${sessionId}" could not be resolved`, error)
      return failure('clone-failed', `agent preset could not be resolved: ${messageOf(error)}`, 500, {
        sessionId,
        ...presetId === undefined ? {} : { agentPreset: presetId },
      })
    }
  }

  let handle
  try {
    handle = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: boundary + 1,
      meta: {
        cwd: workspace.path,
        isSeeded: true,
        ...resolvedPresetId === undefined ? {} : { agentPreset: resolvedPresetId },
      },
      ...agentOptions === undefined ? {} : { agentOptions },
      ...presets === undefined || resolvedPresetId === undefined ? {} : {
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolvedPresetId)
        },
      },
    })
  } catch (error) {
    warn(ctx, `session-relocate: clone of "${sessionId}" failed`, error)
    return failure('clone-failed', messageOf(error), 500, { sessionId, workspaceId: workspace.id })
  }

  try {
    await workspace.attachSession(childId)
  } catch (error) {
    await disposeHandle(handle)
    warn(ctx, `session-relocate: clone "${childId}" could not attach to workspace "${workspace.id}"`, error)
    return failure('attach-failed', messageOf(error), 409, { sessionId: childId, workspaceId: workspace.id })
  }

  const directoryAdjusted = await adjustDirectory(ctx, handle?.agent, workspace.path)

  let archivedSource = false
  let archiveSkipped
  let archiveError
  if (mode === 'move') {
    try {
      await registry.archiveSession(sessionId)
      archivedSource = true
    } catch (error) {
      // The Host refuses to hide a Session that still has running work. That is
      // not a relocation failure: the clone exists, the source simply stays.
      archiveSkipped = error?.name === 'WorkspaceActiveSessionError' ? 'active' : 'error'
      archiveError = messageOf(error)
      warn(ctx, `session-relocate: source "${sessionId}" was kept instead of archived`, error)
    }
  }

  return jsonResponse({
    ok: true,
    sessionId: childId,
    workspaceId: workspace.id,
    targetPath: workspace.path,
    mode,
    archivedSource,
    ...archiveSkipped === undefined ? {} : { archiveSkipped },
    ...archiveError === undefined ? {} : { archiveError },
    directoryAdjusted,
  }, 200)
}

/**
 * Make the clone's effective directory match the target Workspace. The header
 * already names it, but an inherited `working-directory/change` event can replay
 * the source's later directory on top; one committed change fixes the projection
 * and tells the model why. Best effort: the clone and its placement already
 * exist, so a failure here is reported through the flag, not as a failed move.
 * @param ctx - Host context carrying the working-directory service.
 * @param agent - the newly created Agent, when creation returned one.
 * @param targetPath - canonical directory of the target Workspace.
 * @returns whether a change was committed.
 */
async function adjustDirectory(ctx, agent, targetPath) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined || agent === undefined) return false
  try {
    if (workingDirectory.get(agent.session) === targetPath) return false
    await workingDirectory.set(agent, targetPath)
    return true
  } catch (error) {
    warn(ctx, `session-relocate: clone directory was not adjusted to "${targetPath}"`, error)
    return false
  }
}

/**
 * Read the model route a clone should start on: the source Session's current
 * selection when it has one, else the deployment default.
 * @param ctx - Host context carrying the default-model service.
 * @param value - the source's `modelSelection` projection value, wire or state shape.
 * @returns the route to pass as `agentOptions`, or undefined to let the default apply.
 */
function selectRoute(ctx, value) {
  const candidate = value?.next ?? value?.pending ?? value?.lastUsed
  if (typeof candidate?.provider === 'string' && typeof candidate?.model === 'string') {
    return {
      provider: candidate.provider,
      model: candidate.model,
      ...typeof candidate.reasoningEffort === 'string' ? { reasoningEffort: candidate.reasoningEffort } : {},
    }
  }
  let fallback
  try {
    fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  } catch {
    fallback = undefined
  }
  if (typeof fallback?.provider === 'string' && typeof fallback?.model === 'string') {
    return {
      provider: fallback.provider,
      model: fallback.model,
      ...typeof fallback.reasoningEffort === 'string' ? { reasoningEffort: fallback.reasoningEffort } : {},
    }
  }
  return undefined
}

/**
 * Release the agent we created when a later step failed, best effort.
 * @param handle - the AgentHandle returned by creation, when it exists.
 */
async function disposeHandle(handle) {
  try {
    await handle?.dispose?.()
  } catch {
    // Rollback is best effort; the attach failure is the reported outcome.
  }
}

/**
 * Map a filesystem rejection onto the route's closed code list.
 * @param error - rejection from `fs.resolve` / `fs.stat`.
 * @param path - the requested path.
 * @returns the failure response.
 */
function mapFilesystemFailure(error, path) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'ENOENT') return failure('target-not-found', `no directory exists at "${path}"`, 404, { path })
  if (code === 'ENOTDIR') return failure('target-not-a-directory', `"${path}" is not a directory`, 409, { path })
  if (code === 'EACCES' || code === 'EPERM') {
    return failure('invalid-target', `"${path}" is not accessible`, 403, { path })
  }
  return failure('invalid-target', messageOf(error), 400, { path })
}

/**
 * Map a Workspace registry rejection onto the route's closed code list.
 * @param error - rejection from `workspaceRegistry.create`.
 * @param path - the requested path.
 * @returns the failure response.
 */
function mapRegistryFailure(error, path) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'ENOENT') return failure('target-not-found', `no directory exists at "${path}"`, 404, { path })
  if (code === 'ENOTDIR') return failure('target-not-a-directory', `"${path}" is not a directory`, 409, { path })
  return failure('invalid-target', messageOf(error), 400, { path })
}

/**
 * Build one failure response.
 * @param code - closed failure discriminator.
 * @param message - human-readable detail for logs and dialogs.
 * @param status - HTTP status.
 * @param details - optional structured context for the caller.
 * @returns the response.
 */
function failure(code, message, status = 400, details) {
  return jsonResponse({ ok: false, code, message, ...details === undefined ? {} : { details } }, status)
}

/**
 * Build one JSON response the browser reads.
 * @param body - response payload.
 * @param status - HTTP status.
 * @returns the response.
 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Report a non-fatal diagnostic without letting a logger fault fail the request.
 * @param ctx - Host context.
 * @param message - stable prefix naming this plugin.
 * @param error - the fault.
 */
function warn(ctx, message, error) {
  try {
    ctx.logger?.warn?.(`${message}: ${messageOf(error)}`)
  } catch {
    // Diagnostics never change a response.
  }
}

/**
 * Render any thrown value as a message.
 * @param error - thrown value.
 * @returns its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
