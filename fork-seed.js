/**
 * Fork-seed construction over an exact source-event prefix (vendored).
 *
 * This bundle is installed into a DSH profile, and a profile-installed bundle
 * resolves bare specifiers from the profile scope rather than from the running
 * installation; `import '@deepseek-ai/dsh-session/fork'` can therefore load an
 * unrelated copy. So the small pure part of the installed implementation is
 * reproduced here from `@deepseek-ai/dsh-session` (`src/fork.ts` and
 * `src/repair.ts`), and the Host half calls Host Services for everything else.
 *
 * The original's runtime helpers (`SessionSeq`, `SessionLogOffset`,
 * `brandString`, `deepFreeze`) are identity wrappers, so plain numbers and
 * strings reproduce the same event objects. Event member names, order and
 * optional fields are kept exactly as the original emits them.
 * @module session-relocate/fork-seed
 */

/** Model-visible wording of the synthetic error tool results, keyed by cause. */
const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  },
}

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * Copy an inclusive event prefix, mark its inherited cut, and close its open
 * tail with forked results and step/turn endings. Closed steps and turns are
 * preserved unchanged.
 *
 * The caller validates that `boundary` is an existing contiguous event seq;
 * Session construction snapshots the borrowed events before publication.
 * @param {readonly object[]} events - source log with contiguous seqs from zero.
 * @param {number} boundary - inclusive source event seq the child inherits through.
 * @returns {object[]} a new array retaining the source event objects, followed
 *   by synthetic closers outside the inherited prefix counted by
 *   `inheritedEventCount`.
 */
export function buildForkSeed(events, boundary) {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: events[boundary].time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and a
 * cause-specific `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 * @param {readonly object[]} events - the loaded durable log to scan.
 * @param {{ kind: 'interrupted' | 'forked' }} cause - selects result wording and the turn-ending reason.
 * @returns {object[]} the synthetic closer events to append after `events`.
 */
export function openTurnClosers(events, cause) {
  let openTurn = null
  let openStep = null
  const recovery = new ToolCallRecovery(cause)
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no open tail turn): nothing to close.
  const last = events[events.length - 1]
  if (openTurn === null || last === undefined) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers.
  const closers = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time

  // Close an open step before its turn.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}

/**
 * Track unanswered assistant tool requests from one Session's committed events.
 * Observe from the start of the owned step or replay prefix, and recover before
 * its step closes. This state retains pending identities, not event history.
 */
export class ToolCallRecovery {
  /** @param {{ kind: 'interrupted' | 'forked' }} cause - the close operation that owns the wording. */
  constructor(cause = { kind: 'interrupted' }) {
    this.cause = cause
    this.pendingCalls = new Map()
    this.last = undefined
  }

  /**
   * Consume the next committed event; closed steps and turn boundaries discard
   * pending requests.
   * @param {object} event - the next event from the same Session, in sequence order.
   */
  observe(event) {
    this.last = { seq: event.seq, time: event.time }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.pendingCalls.clear()
        break
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            this.pendingCalls.set(block.id, { turn: event.data.turn, step: event.data.step })
          }
        }
        break
      case 'tool/call': {
        const entry = this.pendingCalls.get(event.data.callId)
        if (entry !== undefined) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const entry = this.pendingCalls.get(callId)
        if (event.surfaceOp === 'append' && entry !== undefined
          && entry.turn === event.data.turn && entry.step === event.data.step) {
          this.pendingCalls.delete(callId)
        }
        break
      }
      // SessionEvent is merge-extensible; unrelated events retain pending requests.
      default:
        break
    }
  }

  /**
   * Build conservative error results in assistant order without changing tracked
   * state. Sequences follow the latest observed event and timestamps reuse its
   * time.
   * @returns {object[]} pending tool-result events, empty when no request remains unanswered.
   */
  results() {
    if (this.last === undefined) return []
    let seq = this.last.seq + 1
    const time = this.last.time
    const results = []

    const text = CLOSER_TEXT[this.cause.kind]
    // Close calls before their step: providers reject dangling assistant calls,
    // and Map insertion order preserves their transcript order.
    for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
      const started = callSeq !== undefined
      const message = {
        id: `${this.cause.kind}-tool-result-${callId}-${seq}`,
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{
          type: 'text',
          text: started ? text.started : text.notStarted,
        }],
      }
      results.push({
        type: 'tool/result',
        seq: seq++,
        time,
        data: {
          turn,
          step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...started ? { sourceEventSeqs: [callSeq] } : {},
      })
    }

    return results
  }
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins. Copied from the
 * installed Session controller so a clone cuts where a built-in fork would.
 * @param {readonly object[]} events - source log with contiguous seqs from zero.
 * @returns {number | undefined} the inclusive boundary seq, or undefined when no
 *   turn has completed (there is no conversation to copy yet).
 */
export function latestCompletedPrefixBoundary(events) {
  let lastTurnEnd
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/end') {
      lastTurnEnd = events[index]
      break
    }
  }
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}
