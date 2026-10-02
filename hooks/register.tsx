/* @jsx h */
import type { Register } from 'claude-code'

// ---- model speed, measured off the streamed response --------------------
// TPS  = output tokens / the time the response was streaming (first token to
//        the last one). TTFT = request sent -> first token. The running avg is
//        the mean TPS of finished steps, kept across sessions in $.store.

type Stats = { tps: number; ttftMs: number | null }

let live: Stats | null = null // the step currently streaming
let last: Stats | null = null // the last finished step
let sumTps = 0
let finishedSteps = 0
let lastInvalidateAt = 0

const round1 = (n: number) => Math.round(n * 10) / 10

function averageTps(): number | null {
  return finishedSteps > 0 ? round1(sumTps / finishedSteps) : null
}

function formatTtft(ms: number | null): string {
  if (ms === null) return 'ttft —'
  return ms >= 1000 ? `ttft ${(ms / 1000).toFixed(1)}s` : `ttft ${Math.round(ms)}ms`
}

function formatTps(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1)
}

export const register: Register = on => {
  // Load the running average from the store so it survives restarts.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const stored = await $.store
      .get('avg')
      .catch(err => {
        $.ui.log(`tps-meter: store read failed: ${err}`)
        return undefined
      })
    if (stored && typeof stored === 'object') {
      const s = stored as { sumTps?: unknown; finishedSteps?: unknown }
      if (
        typeof s.sumTps === 'number' &&
        Number.isFinite(s.sumTps) &&
        typeof s.finishedSteps === 'number' &&
        s.finishedSteps > 0
      ) {
        sumTps = s.sumTps
        finishedSteps = s.finishedSteps
      }
    }
    const lastStored = await $.store.get('last').catch(() => undefined)
    if (lastStored && typeof lastStored === 'object') {
      const s = lastStored as { tps?: unknown; ttftMs?: unknown }
      if (typeof s.tps === 'number' && Number.isFinite(s.tps)) {
        last = {
          tps: s.tps,
          ttftMs: typeof s.ttftMs === 'number' && Number.isFinite(s.ttftMs) ? s.ttftMs : null,
        }
        $.ui.invalidate('ui.render')
      }
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let firstTokenAt: number | null = null
    let chars = 0
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          const now = await $.clock.now()
          if (firstTokenAt === null) firstTokenAt = now
          chars += chunk.text.length
          const estTokens = Math.max(1, Math.round(chars / 4))
          const spanMs = Math.max(now - firstTokenAt, 1)
          live = {
            tps: round1((estTokens / spanMs) * 1000),
            ttftMs: firstTokenAt - startedAt,
          }
          if (now - lastInvalidateAt > 200) {
            lastInvalidateAt = now
            $.ui.invalidate('ui.render')
          }
        }
        yield chunk
      }
    } finally {
      // On error or a closed stream, drop the live readout; nothing is
      // recorded below in that case.
      live = null
    }

    const result = await stream.result
    const endedAt = await $.clock.now()
    const estTokens = Math.max(0, Math.round(chars / 4))
    const tokens = result.usage?.output_tokens ?? estTokens
    if (tokens > 0) {
      const spanMs = Math.max(endedAt - (firstTokenAt ?? startedAt), 1)
      const tps = round1((tokens / spanMs) * 1000)
      last = { tps, ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt }
      sumTps += tps
      finishedSteps += 1
      $.store.set('avg', { sumTps, finishedSteps }).catch(err => {
        $.ui.log(`tps-meter: store write failed: ${err}`)
      })
      $.store.set('last', last).catch(err => {
        $.ui.log(`tps-meter: store write failed: ${err}`)
      })
    }
    live = null
    $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const stats = live ?? last
    const avg = averageTps()
    if (!stats && avg === null) return next(e)
    const tps = stats ? `${formatTps(stats.tps)} TPS` : '— TPS'
    const avgPart = avg === null ? 'avg —' : `avg ${formatTps(avg)}`
    const ttft = stats ? formatTtft(stats.ttftMs) : 'ttft —'
    // Rewrite the dim hint line under the prompt; the engine draws the new
    // string in its place.
    return next({
      ...e,
      props: { ...e.props, hint: `${e.props.hint} · ${tps} · ${avgPart} · ${ttft}` },
    })
  })
}
