/**
 * Browser half of the Session relocate bundle.
 *
 * The drag source is this plugin's own 24px handle in the Session row action
 * strip, not the built-in row drag. The built-in row sets
 * `effectAllowed = 'move'` for its reorder gesture, so a Ctrl drop would compute
 * `dropEffect = 'none'` and never fire; and listening to every row drag would
 * pop this dock during ordinary reordering. The handle therefore stops the
 * dragstart from reaching the row, declares `copyMove`, and publishes the
 * Session id under its own MIME type. Dropping that payload on a project chip
 * asks the Host to rebuild the conversation in that project's directory.
 *
 * The dock is a static legend plus project chips (a segmented control would be
 * unclickable while an HTML5 drag is in flight); the Session context menu and a
 * click/Enter on the handle open the same picker as a focus-trapped dialog,
 * where the move/copy choice is interactive.
 *
 * Both surfaces are mounted through `shell.overlay` but portalled to the
 * document body: that layer is a z-index-20 stacking context, so a surface
 * rendered inside it would paint below the sidebar drawer and host modals.
 * Styles are rendered as a React <style> element inside the portal (unmounting
 * removes them) and use theme tokens only, so light and dark share one sheet.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-relocate',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'session-relocate'
    /** Document-relative Host route (see the Host half's SESSION_RELOCATE_PATH). */
    const ROUTE = 'api/session.relocate'
    /** Drag payload type owned by this plugin, so foreign drags are ignored. */
    const DROP_MIME = 'application/x-dsh-session-relocate'
    /**
     * Prefix a remote-backend router (the SSH/WSL/Docker workspaces plugin) puts
     * on every identity it owns. Such an id names a resource inside another DSH
     * process: this Host can neither read its log nor attach a clone to it.
     */
    const REMOTE_ID_PREFIX = 'dsh-remote:'

    /**
     * Whether an identity is addressed through a remote-backend router.
     * @param id - Session or Workspace identity from the sidebar projection.
     * @returns true when the resource lives in another DSH process.
     */
    function isRemoteId(id) {
      return typeof id === 'string' && id.startsWith(REMOTE_ID_PREFIX)
    }
    /** Safety valve: a lost `dragend` must not leave the dock on screen. */
    const DOCK_EXPIRE_MS = 20000
    /** How long a success notice stays up. */
    const NOTICE_MS = 6000
    /** An undoable notice stays long enough to reach the button. */
    const UNDO_MS = 10000

    /** English copy; the fallback locale for every other UI language. */
    const EN = {
      'handle.label': 'Move to another project…',
      'handle.hint': 'Drag to another project, or click to pick one',
      'hover.moveHint': 'Drag to another project',
      'menu.move': 'Move to project…',
      'menu.move.blank': 'Move to project (blank session)',
      'menu.move.subagent': 'Move to project (subagent)',
      'menu.move.remote': 'Move to project (remote session)',
      'dock.label': 'Move session to another project',
      'dock.title': 'Move to another project',
      'dock.source': '“{title}” will be rebuilt in the project you choose, with the target directory as its working directory.',
      'dock.legend': 'Drop on a project = move · hold Ctrl/⌘ while dragging = copy',
      'dock.untitled': 'Untitled session',
      'dock.current': 'current project',
      'dock.folder': 'Choose folder…',
      'dock.folderHint': 'An unregistered folder becomes a new project',
      'dock.noProjects': 'No project is registered yet — choose a folder instead.',
      'dock.remote': 'remote project',
      'dock.remoteHint': 'Lives in a remote DSH backend — a local session cannot be attached to it',
      'dialog.title': 'Move this session to another project',
      'dialog.desc.move': '“{title}” will be copied into the chosen project with its full history and the source session will be archived. The notice that follows can restore it.',
      'dialog.desc.copy': '“{title}” will be copied into the chosen project with its full history; the source session stays where it is.',
      'dialog.busy': 'Rebuilding the session in the target project…',
      'dialog.picking': 'Waiting for the folder chooser…',
      'dialog.close': 'Cancel',
      'mode.group': 'What to do with the source session',
      'mode.move': 'Move',
      'mode.copy': 'Copy',
      'notice.moved': 'Moved to “{project}”.',
      'notice.movedKept': 'Copied to “{project}”. The source session is still running, so it was kept.',
      'notice.movedKeptError': 'Copied to “{project}”. The source session could not be archived, so it was kept.',
      'notice.copied': 'Copied to “{project}”.',
      'notice.dirAdjusted': ' The session now runs in the target directory.',
      'notice.undo': 'Undo',
      'notice.undone': 'Move undone. The original session is back.',
      'error.notSession': 'Only this plugin’s drag handle carries a session here.',
      'error.noSession': 'This drag carries no session. Open a session row and drag its handle.',
      'error.sourceNotFound': 'That session no longer exists.',
      'error.sourceNotLocal': 'This session runs in a remote DSH backend, so its history cannot be read here. Open the remote project and move the session inside it.',
      'error.subagent': 'A subagent conversation cannot be moved on its own.',
      'error.noTurn': 'This session has no completed turn yet, so there is no history to carry over. Start a new session in the target project instead.',
      'error.same': 'It is already in that project.',
      'error.target': 'The target is not an existing directory.',
      'error.workspace': 'That project no longer exists.',
      'error.workspaceUnavailable': 'That project’s directory is not reachable right now — the connection may be down or a share may be unmounted. Reconnect it and try again.',
      'error.workspaceNotLocal': 'That project belongs to a remote DSH backend. A session cannot be moved across DSH processes; add the same directory as a lightweight project, or move the session on the remote side.',
      'error.clone': 'The session could not be rebuilt in the target project.',
      'error.attach': 'The session was created but could not join the target project.',
      'error.pickFailed': 'The folder chooser is unavailable in this composition.',
      'error.generic': 'The Host refused this request.',
      'error.network': 'Cannot reach the DSH Host. Check the connection and try again.',
      'error.undoUnavailable': 'Undo is unavailable in this composition.',
      'error.undoFailed': 'Undo did not complete: {reason}',
      'error.failed': 'Could not move the session: {reason}',
    }

    /** Simplified Chinese copy. */
    const ZH = {
      'handle.label': '移动到项目…',
      'handle.hint': '拖到其他项目，或点击选择项目',
      'hover.moveHint': '可拖到其他项目',
      'menu.move': '移动到项目…',
      'menu.move.blank': '移动到项目（空白会话）',
      'menu.move.subagent': '移动到项目（子代理）',
      'menu.move.remote': '移动到项目（远程会话）',
      'dock.label': '把会话移动到另一个项目',
      'dock.title': '移动到另一个项目',
      'dock.source': '“{title}”会在你选中的项目里重建，并以目标目录作为工作目录。',
      'dock.legend': '拖到项目上 = 移动 · 按住 Ctrl/⌘ 拖 = 复制',
      'dock.untitled': '未命名会话',
      'dock.current': '当前项目',
      'dock.folder': '选择文件夹…',
      'dock.folderHint': '未登记的文件夹会注册成新项目',
      'dock.noProjects': '还没有注册任何项目，请改用“选择文件夹…”。',
      'dock.remote': '远程项目',
      'dock.remoteHint': '该项目在远程 DSH 里，本机会话无法挂过去',
      'dialog.title': '把这个会话移动到另一个项目',
      'dialog.desc.move': '“{title}”会连同完整历史被复制到你选中的项目，源会话将被归档；随后的提示里可以撤销。',
      'dialog.desc.copy': '“{title}”会连同完整历史被复制到你选中的项目，源会话保持原样。',
      'dialog.busy': '正在目标项目里重建会话…',
      'dialog.picking': '正在等待选择文件夹…',
      'dialog.close': '取消',
      'mode.group': '如何处理源会话',
      'mode.move': '移动',
      'mode.copy': '复制',
      'notice.moved': '已移动到“{project}”。',
      'notice.movedKept': '已复制到“{project}”。源会话仍在运行，因此已保留。',
      'notice.movedKeptError': '已复制到“{project}”。源会话未能归档，因此已保留。',
      'notice.copied': '已复制到“{project}”。',
      'notice.dirAdjusted': ' 会话现已切换到目标目录运行。',
      'notice.undo': '撤销',
      'notice.undone': '已撤销移动，原会话回来了。',
      'error.notSession': '只有本插件的拖拽抓手能把会话放到这里。',
      'error.noSession': '这次拖拽没有携带会话标识，请从会话行的抓手重新拖一次。',
      'error.sourceNotFound': '这条会话已经不存在了。',
      'error.sourceNotLocal': '这条会话跑在远程 DSH 里，本机读不到它的历史。请在远程项目窗口里打开它再移动。',
      'error.subagent': '子代理会话不能单独移动。',
      'error.noTurn': '这个会话还没有完成的回合，没有可带走的历史；请直接在目标项目里新建会话。',
      'error.same': '它已经在这个项目里了。',
      'error.target': '目标不是一个已存在的目录。',
      'error.workspace': '这个项目已经不存在了。',
      'error.workspaceUnavailable': '这个项目的目录当前不可达，可能是连接断开或共享目录没有挂载。请恢复连接后重试。',
      'error.workspaceNotLocal': '这个项目属于远程 DSH。会话不能跨 DSH 进程搬移：可以把同一目录加成轻量模式项目，或在远端直接迁移会话。',
      'error.clone': '无法在目标项目里重建会话。',
      'error.attach': '会话已创建，但没能加入目标项目。',
      'error.pickFailed': '当前组合没有可用的目录选择器。',
      'error.generic': 'Host 拒绝了这个请求。',
      'error.network': '无法连接 DSH Host，请检查连接后重试。',
      'error.undoUnavailable': '当前组合不支持撤销。',
      'error.undoFailed': '撤销没有完成：{reason}',
      'error.failed': '移动失败：{reason}',
    }

    /** Surface styles: theme tokens only, so light and dark share one sheet. */
    const CSS = `
.sr-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;box-sizing:border-box;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32))}
.sr-panel{width:min(560px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,none);font:inherit;outline:none}
.sr-dock{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1000;width:min(720px,calc(100vw - 32px));border:1px solid var(--dsw-alias-border-l2)}
.sr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
.sr-source{display:flex;flex-direction:column;gap:4px;min-width:0}
.sr-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.sr-desc{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-word}
.sr-path{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}
.sr-modegroup{display:inline-flex;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.sr-mode{height:30px;padding:0 12px;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.sr-mode[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.sr-mode:disabled{opacity:.5;cursor:default}
.sr-chips{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;padding:2px 2px 6px;scrollbar-width:thin}
.sr-chip{display:flex;flex-direction:column;gap:2px;flex:0 0 auto;min-width:136px;max-width:224px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sr-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sr-chip[data-drop="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.sr-chip:disabled{opacity:.5;cursor:default}
.sr-chip-title{font-size:13px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-chip-path{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-legend{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.sr-error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.sr-busy{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.sr-foot{display:flex;justify-content:flex-end;gap:8px}
.sr-button{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.sr-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sr-button:disabled{opacity:.5;cursor:default}
.sr-chip:focus-visible,.sr-mode:focus-visible,.sr-button:focus-visible,.sr-handle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sr-handle{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:-4px;padding:0;border:0;border-radius:var(--dsw-radius-xs,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:grab}
.sr-handle:hover{color:var(--dsw-alias-label-primary)}
.sr-handle:focus-visible{outline-offset:-2px}
.sr-handle:active{cursor:grabbing}
.sr-hover-hint{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-hovercard-label-secondary,var(--dsw-alias-label-secondary))}
.sr-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1001;max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,none);font:inherit;font-size:13px;line-height:1.5;word-break:break-word}
.sr-toast-text{flex:1 1 auto}
.sr-toast-action{flex:0 0 auto;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;cursor:pointer}
.sr-toast-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sr-toast-action:disabled{opacity:.5;cursor:default}
.sr-toast-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`

    /** Monotonic key so each request and notice remounts its surface. */
    let sequence = 0
    /** True from the moment a submit starts until it settles; a stray `dragend` must not close the panel. */
    let inFlight = false

    function nextKey() {
      sequence += 1
      return sequence
    }

    /** Coded error for the cases the Host never sees. */
    function codedError(code, message) {
      const error = new Error(message)
      error.code = code
      return error
    }

    /** Move glyph, matching the shell's outline icons. */
    function MoveIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M1.6 4.3c0-.6.4-1 1-1h2.9l1.2 1.4h5.7c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H2.6c-.6 0-1-.4-1-1z' }),
      h('path', { d: 'M6.2 9.3h3.4' }),
      h('path', { d: 'M8.3 7.9 9.9 9.3l-1.6 1.4' }))
    }

    /**
     * Drag-handle glyph: a 2x3 dot grid, the conventional "grab and drag"
     * affordance. It is deliberately not the shell's horizontal three-dot
     * trigger, which sits in the same strip and would read as a duplicate.
     */
    function GripIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14
      const dots = []
      for (const cx of [5.4, 10.6]) {
        for (const cy of [4, 8, 12]) {
          dots.push(h('circle', { key: `${cx}:${cy}`, cx, cy, r: 1.15, fill: 'currentColor' }))
        }
      }
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
      }, dots)
    }

    /**
     * Minimal observable snapshot: the shape slot hooks and `observe` entries
     * expect, without importing a Harness Client package.
     * @param initial - first value.
     * @returns getSnapshot/subscribe/set.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Read one Session summary without starting or failing a surface. */
    function summaryOf(listSessions, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        return listSessions()?.byId?.[sessionId]
      } catch {
        return undefined
      }
    }

    /** Read the registered project rows, tolerating a missing service or baseline. */
    function projectItems(listWorkspaces) {
      try {
        const items = listWorkspaces()?.items
        return Array.isArray(items) ? items : []
      } catch {
        return []
      }
    }

    /** Shorten one absolute path for a chip or a notice without losing its tail. */
    function shortPath(path) {
      if (typeof path !== 'string' || path === '') return ''
      if (path.length <= 48) return path
      const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
      const base = cut > 0 ? path.slice(cut + 1) : ''
      if (base !== '' && base.length <= 32) return `${path.slice(0, 14)}…${path.slice(cut)}`
      return `${path.slice(0, 20)}…${path.slice(-22)}`
    }

    /** Keep Tab inside the dialog's focusable controls. */
    function trapFocus(event, container) {
      if (container === null) return
      const focusable = [...container.querySelectorAll('button:not(:disabled)')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    /**
     * Turn a relocate rejection into localized copy plus a diagnostic detail.
     * The Host's stable code decides the sentence; the raw Host message stays
     * available as a tooltip so screen readers and bug reports keep it.
     */
    function errorText(reason, t) {
      const code = reason && reason.code
      const detail = reason instanceof Error ? reason.message : String(reason)
      const mapped = {
        'source-not-found': 'error.sourceNotFound',
        'source-not-local': 'error.sourceNotLocal',
        'subagent-session': 'error.subagent',
        'no-completed-turn': 'error.noTurn',
        'same-workspace': 'error.same',
        'invalid-target': 'error.target',
        'target-not-found': 'error.target',
        'target-not-a-directory': 'error.target',
        'workspace-not-found': 'error.workspace',
        'workspace-not-local': 'error.workspaceNotLocal',
        'workspace-unavailable': 'error.workspaceUnavailable',
        'clone-failed': 'error.clone',
        'attach-failed': 'error.attach',
        'picker-unavailable': 'error.pickFailed',
        'undo-unavailable': 'error.undoUnavailable',
        'invalid-session-id': 'error.generic',
        'invalid-request': 'error.generic',
        'content-type': 'error.generic',
        'method-not-allowed': 'error.generic',
        'http': 'error.generic',
        'network': 'error.network',
      }[code]
      if (mapped === undefined) return { text: t('error.failed', { reason: detail }), detail }
      return { text: t(mapped), detail }
    }

    /**
     * Whether a row may be relocated at all.
     *
     * A blank row has no history to carry, a subagent row owns no independent
     * lifecycle, and a row addressed as `dsh-remote:<source>:<id>` runs in
     * another DSH process whose log this Host cannot read — that one is refused
     * up front instead of failing after the drop.
     */
    function relocatable(summary) {
      return summary !== undefined
        && summary.blank !== true
        && summary.origin !== 'subagent'
        && !isRemoteId(summary.id)
    }

    /**
     * The plugin's own drag handle in the Session row action strip.
     *
     * `stopPropagation()` runs first and unconditionally: letting the row's own
     * React dragstart run would overwrite `effectAllowed` with `'move'` and
     * start the built-in reorder gesture, which also makes a Ctrl drop resolve
     * to `dropEffect = 'none'`.
     */
    function RelocateHandle(props) {
      const { sessionId, displayTitle, t } = props
      if (typeof sessionId !== 'string' || !props.isRelocatable(sessionId)) return null
      const title = typeof displayTitle === 'string' ? displayTitle : ''
      const label = t('handle.label')
      return h('button', {
        type: 'button',
        className: 'sr-handle',
        draggable: true,
        title: t('handle.hint'),
        'aria-label': label,
        onClick: (event) => {
          event.stopPropagation()
          props.openDialog(sessionId, title)
        },
        onDragStart: (event) => {
          // First: keep the gesture away from the row's reorder drag.
          event.stopPropagation()
          const transfer = event.dataTransfer
          if (transfer !== null && transfer !== undefined) {
            transfer.effectAllowed = 'copyMove'
            try {
              transfer.setData(DROP_MIME, sessionId)
              transfer.setData('text/plain', sessionId)
            } catch {
              // A refused second type is harmless; the dock validates the MIME.
            }
          }
          props.beginDrag(sessionId, title)
        },
        onDragEnd: () => { props.endDrag() },
      }, h(GripIcon, { size: 14 }))
    }

    /** Non-interactive hover-card line: discloses the drag affordance. */
    function RelocateHoverHint(props) {
      if (!props.isRelocatable(props.sessionId)) return null
      return h('p', { className: 'sr-hover-hint' }, props.t('hover.moveHint'))
    }

    /**
     * One picker surface: the drag dock (`kind: 'dock'`) and the menu dialog
     * (`kind: 'dialog'`) share the project list, so both stay consistent.
     *
     * A segmented control would be unclickable during an HTML5 drag, so the
     * dock shows a static legend instead; the dialog keeps the control and
     * therefore supports a deliberate copy. The dialog traps focus and locks
     * scrolling; the dock never steals focus from the ongoing drag.
     */
    function RelocatePanel(props) {
      const { request, api } = props
      const { t } = api
      const isDialog = request.kind === 'dialog'
      const [mode, setMode] = React.useState(request.mode === 'copy' ? 'copy' : 'move')
      const [busy, setBusy] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [hovered, setHovered] = React.useState(null)
      const panelRef = React.useRef(null)
      const busyRef = React.useRef(false)
      busyRef.current = busy || picking
      // Request-level guards live in refs, not state: a decision taken in the
      // same tick as a state update must not read the previous render's value.
      const submittingRef = React.useRef(false)
      const pickingRef = React.useRef(false)
      const ids = React.useId()
      const titleId = `${ids}-title`
      const descId = `${ids}-desc`

      const sessionId = typeof request.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : null
      const summary = summaryOf(api.listSessions, sessionId)
      const summaryTitle = summary !== undefined && typeof summary.displayTitle === 'string' ? summary.displayTitle : ''
      const requestTitle = typeof request.displayTitle === 'string' ? request.displayTitle : ''
      const sourceTitle = summaryTitle !== '' ? summaryTitle : requestTitle !== '' ? requestTitle : t('dock.untitled')
      const sourceCwd = summary !== undefined && typeof summary.cwd === 'string' ? summary.cwd : ''
      const projects = projectItems(api.listWorkspaces)
      const currentProjectId = sessionId === null
        ? null
        : (projects.find(project => Array.isArray(project.sessionIds) && project.sessionIds.includes(sessionId))?.workspaceId ?? null)

      // Modal lifecycle: scroll lock, initial focus, focus trap and focus return.
      // The dock skips all of it so the pointer drag keeps working behind it.
      React.useEffect(() => {
        if (!isDialog) return undefined
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const first = panelRef.current?.querySelector('button:not(:disabled)')
        ;(first ?? panelRef.current)?.focus({ preventScroll: true })
        return () => { document.body.style.overflow = previousOverflow }
      }, [isDialog])

      React.useEffect(() => {
        if (!isDialog) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (!busyRef.current) api.dismiss()
          } else if (event.key === 'Tab') {
            trapFocus(event, panelRef.current)
            event.stopPropagation()
          }
        }
        const onFocusIn = (event) => {
          if (panelRef.current?.contains(event.target)) return
          const target = busyRef.current ? panelRef.current : panelRef.current?.querySelector('button:not(:disabled)') ?? panelRef.current
          target?.focus({ preventScroll: true })
        }
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('focusin', onFocusIn)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('focusin', onFocusIn)
        }
      }, [isDialog])

      React.useEffect(() => {
        if (!isDialog) return undefined
        const previousFocus = document.activeElement
        return () => {
          if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
            previousFocus.focus({ preventScroll: true })
          }
        }
      }, [isDialog])

      /** Whether a drag payload belongs to this plugin (or at least names a Session). */
      const carriesSession = (transfer) => {
        const types = Array.from(transfer?.types ?? [])
        return types.includes(DROP_MIME) || types.includes('text/plain')
      }

      /** The Session id a drop carries, or null when the payload is not a Session. */
      const dropSessionId = (transfer) => {
        const read = (type) => {
          try {
            return transfer?.getData?.(type) ?? ''
          } catch {
            return ''
          }
        }
        // Our own MIME first: the built-in reorder drag also writes text/plain.
        let id = read(DROP_MIME)
        if (id === '') id = read('text/plain')
        if (id === '') return null
        return summaryOf(api.listSessions, id) === undefined ? null : id
      }

      /** Send one relocate request; the injected helper reports and opens on success. */
      const submit = (target, targetTitle, chosenMode, chosenId) => {
        if (submittingRef.current) return
        const id = chosenId !== undefined && chosenId !== null ? chosenId : sessionId
        if (id === null) {
          setError({ text: t('error.noSession'), detail: '' })
          return
        }
        submittingRef.current = true
        inFlight = true
        setBusy(true)
        setError(null)
        api.relocate({ sessionId: id, mode: chosenMode, target, targetTitle, sourceTitle })
          .then(() => { api.dismiss() })
          .catch((reason) => {
            setBusy(false)
            setError(errorText(reason, t))
          })
          .finally(() => {
            submittingRef.current = false
            inFlight = false
          })
      }

      /** Pick a folder and relocate into it; the Host registers it when unowned. */
      const chooseFolder = (chosenId, chosenMode) => {
        if (pickingRef.current || submittingRef.current) return
        pickingRef.current = true
        // Hold the surface open across the chooser: `dragend` fires as soon as
        // the drop settles, long before the operator picks a folder.
        inFlight = true
        setPicking(true)
        setError(null)
        Promise.resolve()
          .then(() => api.pickDirectory())
          .then((path) => {
            pickingRef.current = false
            setPicking(false)
            if (typeof path !== 'string' || path === '') {
              inFlight = false
              // A cancelled chooser leaves a dialog usable and retryable, while
              // a dock belongs to a gesture that has already ended.
              if (!isDialog) api.dismiss()
              return
            }
            submit({ path }, shortPath(path), chosenMode, chosenId)
          })
          .catch((reason) => {
            pickingRef.current = false
            inFlight = false
            setPicking(false)
            setError(errorText(reason, t))
          })
      }

      /** A project chip is a drop target in the dock and a button in the dialog. */
      const onChipDragOver = (event, project) => {
        // A remote project is not a drop target at all: accepting the drag and
        // failing afterwards would only promise something this Host cannot do.
        if (isRemoteId(project.workspaceId)) return
        const transfer = event.dataTransfer
        if (!carriesSession(transfer)) return
        event.preventDefault()
        event.stopPropagation()
        if (transfer !== null && transfer !== undefined) {
          transfer.dropEffect = event.ctrlKey || event.metaKey
            ? 'copy'
            : mode === 'copy' ? 'copy' : 'move'
        }
        if (project.workspaceId !== currentProjectId && hovered !== project.workspaceId) setHovered(project.workspaceId)
      }
      const onChipDrop = (event, project) => {
        event.preventDefault()
        event.stopPropagation()
        setHovered(null)
        if (isRemoteId(project.workspaceId)) {
          api.notify(t('error.workspaceNotLocal'))
          return
        }
        const id = dropSessionId(event.dataTransfer)
        if (id === null) {
          api.dismiss()
          api.notify(t('error.notSession'))
          return
        }
        submit(
          { workspaceId: project.workspaceId },
          typeof project.title === 'string' && project.title !== '' ? project.title : shortPath(project.path),
          event.ctrlKey || event.metaKey ? 'copy' : mode,
          id,
        )
      }
      const onFolderDragOver = (event) => {
        const transfer = event.dataTransfer
        if (!carriesSession(transfer)) return
        event.preventDefault()
        event.stopPropagation()
        if (transfer !== null && transfer !== undefined) transfer.dropEffect = 'copy'
      }
      const onFolderDrop = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const id = dropSessionId(event.dataTransfer)
        if (id === null) {
          api.dismiss()
          api.notify(t('error.notSession'))
          return
        }
        chooseFolder(id, event.ctrlKey || event.metaKey ? 'copy' : mode)
      }
      /** The panel itself accepts the payload so the drop is never cancelled mid-air. */
      const onPanelDragOver = (event) => {
        const transfer = event.dataTransfer
        if (!carriesSession(transfer)) return
        event.preventDefault()
        if (transfer !== null && transfer !== undefined) {
          transfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : mode === 'copy' ? 'copy' : 'move'
        }
        setHovered(null)
      }
      const onPanelDrop = (event) => {
        event.preventDefault()
        setHovered(null)
        api.notify(t('dock.legend'))
      }

      const chips = projects.map((project) => {
        const isCurrent = project.workspaceId === currentProjectId
        const isRemote = isRemoteId(project.workspaceId)
        const title = typeof project.title === 'string' && project.title !== '' ? project.title : shortPath(project.path)
        const reason = isCurrent ? t('dock.current') : isRemote ? t('dock.remote') : shortPath(project.path)
        const tooltip = isCurrent ? `${project.path} · ${t('dock.current')}`
          : isRemote ? `${project.path} · ${t('dock.remoteHint')}`
            : project.path
        return h('button', {
          key: project.workspaceId,
          type: 'button',
          className: 'sr-chip',
          'data-drop': hovered === project.workspaceId ? 'true' : 'false',
          disabled: isCurrent || isRemote || busy,
          title: tooltip,
          'aria-label': isCurrent ? `${title} (${t('dock.current')})`
            : isRemote ? `${title} (${t('dock.remote')})`
              : title,
          onDragOver: event => onChipDragOver(event, project),
          onDragEnter: event => onChipDragOver(event, project),
          onDrop: event => onChipDrop(event, project),
          onClick: () => {
            if (isCurrent || isRemote) return
            submit({ workspaceId: project.workspaceId }, title, mode)
          },
        },
        h('span', { className: 'sr-chip-title' }, title),
        h('span', { className: 'sr-chip-path' }, reason))
      })
      const folderChip = h('button', {
        key: 'session-relocate.folder',
        type: 'button',
        className: 'sr-chip',
        disabled: busy,
        title: t('dock.folderHint'),
        onDragOver: onFolderDragOver,
        onDragEnter: onFolderDragOver,
        onDrop: onFolderDrop,
        onClick: () => { chooseFolder(sessionId, mode) },
      },
      h('span', { className: 'sr-chip-title' }, t('dock.folder')),
      h('span', { className: 'sr-chip-path' }, t('dock.folderHint')))

      const modeGroup = isDialog
        ? h('div', { className: 'sr-modegroup', role: 'group', 'aria-label': t('mode.group') },
          h('button', {
            type: 'button',
            className: 'sr-mode',
            'aria-pressed': mode === 'move' ? 'true' : 'false',
            disabled: busy || picking,
            onClick: () => { setMode('move') },
          }, t('mode.move')),
          h('button', {
            type: 'button',
            className: 'sr-mode',
            'aria-pressed': mode === 'copy' ? 'true' : 'false',
            disabled: busy || picking,
            onClick: () => { setMode('copy') },
          }, t('mode.copy')))
        : null

      const body = [
        h('div', { className: 'sr-head', key: 'head' },
          h('div', { className: 'sr-source' },
            h(isDialog ? 'h2' : 'p', {
              id: isDialog ? titleId : undefined,
              className: 'sr-title',
            }, isDialog ? t('dialog.title') : t('dock.title')),
            h('p', {
              id: isDialog ? descId : undefined,
              className: 'sr-desc',
            }, isDialog
              ? t(mode === 'copy' ? 'dialog.desc.copy' : 'dialog.desc.move', { title: sourceTitle })
              : t('dock.source', { title: sourceTitle })),
            sourceCwd === '' ? null : h('p', { className: 'sr-path', title: sourceCwd }, shortPath(sourceCwd))),
          modeGroup),
        error === null ? null : h('p', {
          className: 'sr-error',
          role: 'alert',
          key: 'error',
          title: error.detail === '' ? undefined : error.detail,
        }, error.text),
        picking ? h('p', { className: 'sr-busy', role: 'status', key: 'picking' }, t('dialog.picking')) : null,
        busy ? h('p', { className: 'sr-busy', role: 'status', key: 'busy' }, t('dialog.busy')) : null,
        busy || picking ? null : h('div', { className: 'sr-chips', key: 'chips' }, chips.concat(folderChip)),
        busy || picking || isDialog ? null : (projects.length === 0
          ? h('p', { className: 'sr-legend', key: 'none' }, t('dock.noProjects'))
          : h('p', { className: 'sr-legend', key: 'legend' }, t('dock.legend'))),
        h('div', { className: 'sr-foot', key: 'foot' },
          h('button', {
            type: 'button',
            className: 'sr-button',
            disabled: busy || picking,
            onClick: () => { api.dismiss() },
          }, t('dialog.close'))),
      ]

      const panel = h('div', {
        className: isDialog ? 'sr-panel' : 'sr-panel sr-dock',
        role: isDialog ? 'dialog' : 'region',
        ...isDialog
          ? {
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            'aria-describedby': descId,
            tabIndex: -1,
          }
          : { 'aria-label': t('dock.label') },
        'aria-busy': busy || picking ? 'true' : 'false',
        ref: panelRef,
        onDragOver: onPanelDragOver,
        onDrop: onPanelDrop,
        onKeyDown: event => { event.stopPropagation() },
      }, body)

      return ReactDOM.createPortal(h(React.Fragment, null,
        isDialog
          ? h('div', {
            className: 'sr-backdrop',
            onPointerDown: event => {
              if (event.target === event.currentTarget && !busyRef.current) api.dismiss()
            },
          }, panel)
          : panel), document.body)
    }

    /** One transient notice, with an Undo action when the move archived its source. */
    function RelocateToast(props) {
      const { notice, api } = props
      const [busy, setBusy] = React.useState(false)
      const busyRef = React.useRef(false)
      busyRef.current = busy
      React.useEffect(() => {
        if (busy) return undefined
        const timer = setTimeout(() => { api.dismissNotice() }, notice.undo === undefined ? NOTICE_MS : UNDO_MS)
        return () => { clearTimeout(timer) }
      }, [notice.key, busy])
      const undo = () => {
        if (busyRef.current) return
        setBusy(true)
        api.undoMove(notice.undo)
          .then(() => {
            api.dismissNotice()
            api.notify(api.t('notice.undone'))
          })
          .catch((reason) => {
            setBusy(false)
            api.notify(errorText(reason, api.t).text)
          })
      }
      return ReactDOM.createPortal(h(React.Fragment, null,
        h('div', { className: 'sr-toast', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'sr-toast-text' }, notice.text),
          notice.undo === undefined
            ? null
            : h('button', {
              type: 'button',
              className: 'sr-toast-action',
              disabled: busy,
              onClick: undo,
            }, api.t('notice.undo')))), document.body)
    }

    /**
     * The plugin's stylesheet, mounted for the whole life of the plugin.
     *
     * `shell.overlay` entries stay mounted even with nothing to show, so this
     * one keeps the `.sr-*` rules available to surfaces that live in other
     * slots. Without it the row drag handle and the hover-card hint — both
     * rendered by the built-in Workspace browser, not by this overlay — would
     * fall back to browser defaults (native button chrome, default paragraph
     * margins) until the dock happened to open.
     */
    function RelocateStyles() {
      return ReactDOM.createPortal(h('style', null, CSS), document.body)
    }

    /** The `shell.overlay` entry: the drag dock, the menu dialog, or one notice. */
    function RelocateOverlay(props) {
      const request = props.useRelocateRequest(value => value)
      const notice = props.useRelocateNotice(value => value)
      const api = {
        dismiss: props.dismiss,
        dismissNotice: props.dismissNotice,
        relocate: props.relocate,
        pickDirectory: props.pickDirectory,
        notify: props.notify,
        listSessions: props.listSessions,
        listWorkspaces: props.listWorkspaces,
        undoMove: props.undoMove,
        t: props.t,
      }
      return h(React.Fragment, null,
        request === null ? null : h(RelocatePanel, { key: request.key, request, api }),
        notice === null ? null : h(RelocateToast, { key: notice.key, notice, api }))
    }

    return {
      inject: ['slots', 'locale', 'contextMenus', 'sessions'],
      apply(ctx) {
        const request = createStore(null)
        const notice = createStore(null)
        const t = ctx.locale.bind(NS)
        const sessions = () => ctx.get('sessions')
        const workspaces = () => ctx.get('workspaces')
        const uiWorkspace = () => ctx.get('uiWorkspace')
        let expireTimer = null

        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'session-relocate: dictionaries')

        /** Host-authoritative Session list, read through a guarded snapshot. */
        const listSessions = () => {
          try {
            return sessions()?.list?.getSnapshot?.()
          } catch {
            return undefined
          }
        }
        /** Registered projects, read through a guarded snapshot. */
        const listWorkspaces = () => {
          try {
            return workspaces()?.list?.getSnapshot?.()
          } catch {
            return undefined
          }
        }
        const notify = (text) => { notice.set({ key: nextKey(), text }) }
        const notifyUndo = (text, undo) => { notice.set({ key: nextKey(), text, undo }) }
        const dismiss = () => { request.set(null) }
        const dismissNotice = () => { notice.set(null) }

        const clearExpire = () => {
          if (expireTimer !== null) {
            clearTimeout(expireTimer)
            expireTimer = null
          }
        }
        /** Raise the dock as soon as the handle's drag starts. */
        const beginDrag = (sessionId, displayTitle) => {
          clearExpire()
          request.set({ key: nextKey(), kind: 'dock', sessionId, displayTitle, mode: 'move' })
          expireTimer = setTimeout(() => {
            expireTimer = null
            if (!inFlight) request.set(null)
          }, DOCK_EXPIRE_MS)
        }
        /** The gesture ended: drop or cancel the dock unless a request holds it open. */
        const endDrag = () => {
          clearExpire()
          if (!inFlight) request.set(null)
        }
        /** A click or Enter on the handle opens the modal picker instead. */
        const openDialog = (sessionId, displayTitle) => {
          clearExpire()
          request.set({ key: nextKey(), kind: 'dialog', sessionId, displayTitle, mode: 'move' })
        }
        /** Blank and subagent rows own no movable history. */
        const isRelocatable = (sessionId) => relocatable(summaryOf(listSessions, sessionId))

        /** Open the Host or native folder chooser; a missing composition degrades to a coded error. */
        const pickDirectory = () => {
          const ui = uiWorkspace()
          if (ui === undefined || typeof ui.pickDirectory !== 'function') {
            return Promise.reject(codedError('picker-unavailable', 'directory picker unavailable'))
          }
          return Promise.resolve(ui.pickDirectory())
        }

        /** Reload the Session list best effort, then open the rebuilt Session. */
        const revealRebuiltSession = async (childId) => {
          try {
            await sessions()?.refresh?.()
          } catch (reason) {
            console.warn('session-relocate: list refresh after relocate failed', reason)
          }
          try {
            const ui = uiWorkspace()
            if (ui !== undefined && typeof ui.openSession === 'function') ui.openSession(childId)
          } catch (reason) {
            console.warn('session-relocate: opening the rebuilt session failed', reason)
          }
        }

        /**
         * Undo an archived move: restore the source, show it, then hide the
         * clone. The order matters — opening first keeps the clone's archive
         * from clearing the selection the operator just moved to.
         */
        const undoMove = async (undo) => {
          const ui = uiWorkspace()
          if (undo === undefined || undo === null
            || ui === undefined
            || typeof ui.unarchiveSession !== 'function'
            || typeof ui.archiveSession !== 'function') {
            throw codedError('undo-unavailable', 'workspace actions unavailable')
          }
          await ui.unarchiveSession(undo.sourceId)
          try {
            if (typeof ui.openSession === 'function') ui.openSession(undo.sourceId)
          } catch (reason) {
            console.warn('session-relocate: opening the restored session failed', reason)
          }
          await ui.archiveSession(undo.childId)
          try {
            await sessions()?.refresh?.()
          } catch (reason) {
            console.warn('session-relocate: list refresh after undo failed', reason)
          }
        }

        /** Report the outcome in the reader's language and offer Undo when it applies. */
        const notifySuccess = (payload, targetTitle, sourceId) => {
          const project = typeof targetTitle === 'string' && targetTitle !== ''
            ? targetTitle
            : shortPath(typeof payload?.targetPath === 'string' ? payload.targetPath : '')
          const kept = payload?.mode !== 'copy' && payload?.archivedSource !== true
          const keptKey = payload?.archiveSkipped === 'error' ? 'notice.movedKeptError' : 'notice.movedKept'
          const key = payload?.mode === 'copy' ? 'notice.copied' : kept ? keptKey : 'notice.moved'
          let text = t(key, { project: project === '' ? '…' : project })
          if (payload?.directoryAdjusted === true) text += t('notice.dirAdjusted')
          if (payload?.mode === 'move' && payload?.archivedSource === true && typeof sourceId === 'string') {
            notifyUndo(text, { sourceId, childId: payload.sessionId })
            return
          }
          notify(text)
        }

        /** Ask the Host to rebuild one Session in a target project or directory. */
        const relocate = async ({ sessionId, mode, target, targetTitle }) => {
          let response
          try {
            response = await fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, mode, target }),
            })
          } catch (reason) {
            throw codedError('network', reason instanceof Error ? reason.message : String(reason))
          }
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || payload?.ok !== true) {
            const error = new Error(typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`)
            error.code = typeof payload?.code === 'string' ? payload.code : 'http'
            if (payload?.details !== undefined) error.details = payload.details
            throw error
          }
          notifySuccess(payload, targetTitle, sessionId)
          void revealRebuiltSession(payload.sessionId)
          return payload
        }

        // Own drag handle in the Session row action strip. 650 places it beside
        // the built-in actions without displacing the More trigger.
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'session-relocate.handle',
          order: 650,
          locale: NS,
          inject: () => ({ t, beginDrag, endDrag, openDialog, isRelocatable }),
        }, RelocateHandle))

        // Hover-card line that discloses the drag affordance.
        ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
          name: 'sidebar.session.row.hover',
          id: 'session-relocate.hover-hint',
          order: 100,
          locale: NS,
          inject: () => ({ t, isRelocatable }),
        }, RelocateHoverHint))

        // Session menu entry: the accessible route to the same picker.
        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-relocate.move',
          target: 'session',
          order: 700,
          observe: () => {
            const list = sessions()?.list
            return list === undefined ? [ctx.locale] : [ctx.locale, list]
          },
          resolve: (target) => {
            const summary = summaryOf(listSessions, target.sessionId)
            // A blank Session has no completed turn to carry, a subagent row
            // owns no independent lifecycle, and a remote-backend Session keeps
            // its log in another DSH process; all three keep the entry, disabled
            // with the reason, so a missing action never looks like a bug.
            const reason = summary?.origin === 'subagent' ? 'subagent'
              : summary?.blank === true ? 'blank'
                : isRemoteId(summary?.id ?? target.sessionId) ? 'remote' : null
            return [{
              id: 'move',
              label: reason === null ? t('menu.move') : t(`menu.move.${reason}`),
              icon: { key: 'session-relocate.move' },
              ...reason === null ? {} : { disabled: true },
              run: () => { openDialog(target.sessionId, target.displayTitle) },
            }]
          },
        }), 'session-relocate: Session menu action')

        ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-relocate.move' }, MoveIcon)
        })

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-relocate.styles',
          order: -1000,
        }, RelocateStyles))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-relocate.overlay',
          locale: NS,
          inject: () => ({
            hooks: { relocateRequest: request, relocateNotice: notice },
            t,
            dismiss,
            dismissNotice,
            relocate,
            pickDirectory,
            notify,
            listSessions,
            listWorkspaces,
            undoMove,
          }),
        }, RelocateOverlay))

        // Lifecycle guards only: the drag itself is started by the handle, which
        // owns its own dragstart/dragend. These cover a source element that
        // unmounts mid-drag, a drop that ends the gesture, and Escape.
        ctx.effect(() => {
          const onDragEnd = () => { endDrag() }
          const onDrop = () => {
            setTimeout(() => {
              if (inFlight) return
              clearExpire()
              request.set(null)
            }, 0)
          }
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            const current = request.getSnapshot()
            // The dialog owns Escape itself (it also has to hold focus).
            if (current === null || current.kind !== 'dock') return
            if (inFlight) return
            request.set(null)
          }
          window.addEventListener('dragend', onDragEnd)
          window.addEventListener('drop', onDrop)
          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            clearExpire()
            window.removeEventListener('dragend', onDragEnd)
            window.removeEventListener('drop', onDrop)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        }, 'session-relocate: drag lifecycle')
      },
    }
  },
})
