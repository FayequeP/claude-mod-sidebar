/* @jsx h */
import type { Register } from 'claude-code'

// ---- model speed + prompt-cache meter, drawn as a docked sidebar ----
// TPS  = output tokens / the time the response was streaming (first token to
//        the last one). TTFT = request sent -> first token. Cache rows come
//        from the API's usage fields on every step. The "Valid for" countdown
//        is the main-conversation prompt-cache TTL (5m or 1h) minus the wall
//        time since the last response finished.

type Stats = { tps: number; ttftMs: number | null }
type Last = Stats & { at: number }
type Sums = { input: number; output: number; cacheRead: number; cacheWrite: number }

let live: Stats | null = null // the step currently streaming
let last: Last | null = null // the last finished step
let sums: Sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
let lastInvalidateAt = 0
let tick: unknown

const round1 = (n: number) => Math.round(n * 10) / 10

function formatTtft(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function formatTps(n: number): string {
  return n >= 100 ? `${Math.round(n)} tok/s` : `${n.toFixed(0)} tok/s`
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

function formatShort(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function hitRate(): number | null {
  const { cacheRead, cacheWrite } = sums
  const total = cacheRead + cacheWrite
  return total > 0 ? cacheRead / total : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Rehydrate previous-session counters.
    const [stored, storedSums] = await Promise.all([
      $.store.get('last').catch(() => undefined),
      $.store.get('sums').catch(() => undefined),
    ])
    if (stored && typeof stored === 'object') {
      const s = stored as { tps?: unknown; ttftMs?: unknown; at?: unknown }
      if (typeof s.tps === 'number' && Number.isFinite(s.tps)) {
        last = {
          tps: s.tps,
          ttftMs: typeof s.ttftMs === 'number' && Number.isFinite(s.ttftMs) ? s.ttftMs : null,
          at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0,
        }
      }
    }
    if (storedSums && typeof storedSums === 'object') {
      const s = storedSums as Sums
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (typeof s[k] === 'number' && Number.isFinite(s[k])) sums[k] = s[k]
      }
    }

    // Dock the meter sidebar beside the transcript (columns => docked).
    await $.ui
      .open({ id: 'meter', title: 'Claude Code Sidebar', columns: 38, closeOnEscape: true })
      .catch(err => $.ui.log(`tps-meter: pane not opened: ${err}`))

    // Tick once a second so the cache countdown moves.
    ;(tick as { cancel(): void } | undefined)?.cancel?.()
    tick = $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
    })

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
          if (now - lastInvalidateAt > 500) {
            lastInvalidateAt = now
            $.ui.invalidate('ui.render')
          }
        }
        yield chunk
      }
    } finally {
      live = null
    }

    const result = await stream.result
    const endedAt = await $.clock.now()
    const estTokens = Math.max(0, Math.round(chars / 4))
    const usage = result.usage
    const tokens = usage?.output_tokens ?? estTokens
    if (tokens > 0) {
      const spanMs = Math.max(endedAt - (firstTokenAt ?? startedAt), 1)
      const tps = round1((tokens / spanMs) * 1000)
      last = { tps, ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt, at: endedAt }
      if (usage) {
        sums = {
          input: sums.input + (usage.input_tokens ?? 0),
          output: sums.output + (usage.output_tokens ?? 0),
          cacheRead: sums.cacheRead + (usage.cache_read_input_tokens ?? 0),
          cacheWrite: sums.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
        }
        $.store.set('sums', sums).catch(err => {
          $.ui.log(`tps-meter: store write failed: ${err}`)
        })
      }
      $.store.set('last', last).catch(err => {
        $.ui.log(`tps-meter: store write failed: ${err}`)
      })
    }
    live = null
    $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'meter') return next(e)
    const { Box, Text } = await $.ui.resolve(e)
    const cols = Math.max(20, e.props.bodyColumns || 30)

    // CONTEXT figures from the session usage (same source as the status line).
    let contextPct: number | null = null
    let contextLine = '— / —'
    try {
      const usage = await $.session.usage()
      if (usage && usage.context && usage.context.window) {
        const used = usage.context.tokens ?? 0
        contextPct = used / usage.context.window
        contextLine = `${formatShort(used)} / ${formatShort(usage.context.window)}`
      }
    } catch {
      // a test or a build without session.usage: draw without context
    }

    // CACHE TTL for the "Valid for" countdown.
    let ttlMin = 5
    try {
      const override = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
      if (override === '1h') ttlMin = 60
      else if (override === '5m') ttlMin = 5
      const force5m = await $.env.get('FORCE_PROMPT_CACHING_5M')
      if (force5m === '1') ttlMin = 5
    } catch {
      // keep the default
    }

    const now = await $.clock.now()
    const remaining = last ? ttlMin * 60_000 - (now - last.at) : null
    const remainingRatio = remaining !== null ? remaining / (ttlMin * 60_000) : 0

    let workspace = ''
    let repo: string | null = null
    let messageCount = 0
    try {
      workspace = await $.session.cwd()
      const r = await $.session.repo()
      repo = r ? (r.remote ?? r.root) : null
      messageCount = (await $.session.messages()).length
    } catch {
      // keep defaults
    }
    const workspaceName = workspace ? workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '' : '—'

    const liveStats = live ?? last
    const rate = hitRate()
    const contextBarRatio = contextPct ?? 0

    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="blue">CONTEXT</Text>
          <Text>{contextPct === null ? '—' : `${(contextPct * 100).toFixed(1)}%`}</Text>
        </Box>
        <Text color="blue">{bar(contextBarRatio, cols)}</Text>
        <Text dimColor>Used</Text>
        <Text dimColor>{contextLine}</Text>
        <Box height={1} />

        <Box flexDirection="row" justifyContent="space-between">
          <Text color="blue">TOKENS</Text>
          <Text> </Text>
        </Box>
        <Row label="↑ Input" value={formatCount(sums.input)} Box={Box} Text={Text} cols={cols} />
        <Row label="↓ Output" value={formatCount(sums.output)} Box={Box} Text={Text} cols={cols} />
        <Row label="↻ Cache read" value={formatCount(sums.cacheRead)} Box={Box} Text={Text} cols={cols} green />
        <Row label="+ Cache write" value={formatCount(sums.cacheWrite)} Box={Box} Text={Text} cols={cols} />
        <Text dimColor>{'─'.repeat(cols)}</Text>
        <Row label="Session total" value={formatCount(sums.input + sums.output + sums.cacheRead + sums.cacheWrite)} Box={Box} Text={Text} cols={cols} />
        <Box height={1} />

        <Box flexDirection="row" justifyContent="space-between">
          <Text color="blue">CACHE</Text>
          <Text color="green">{rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</Text>
        </Box>
        <Text color="green">{bar(rate ?? 0, cols)}</Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>read {formatShort(sums.cacheRead)}</Text>
          <Text dimColor>miss {formatShort(sums.cacheWrite)}</Text>
        </Box>
        <Box height={1} />
        <Box flexDirection="row" justifyContent="space-between">
          <Text>Valid for</Text>
          <Text>{remaining === null ? '—' : formatCountdown(remaining)}</Text>
        </Box>
        <Text color="yellow">{bar(remainingRatio, cols)}</Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{ttlMin === 60 ? '1h' : '5m'} window</Text>
          <Text dimColor>resets on next call</Text>
        </Box>
        <Box height={1} />

        <Box flexDirection="row" justifyContent="space-between">
          <Text color="blue">ACTIVITY</Text>
          <Text> </Text>
        </Box>
        <Row label="First token" value={formatTtft(liveStats?.ttftMs ?? null)} Box={Box} Text={Text} cols={cols} />
        <Row label="Output speed" value={liveStats ? formatTps(liveStats.tps) : '—'} Box={Box} Text={Text} cols={cols} />
        <Box height={1} />

        <Text color="magenta">WORKSPACE</Text>
        <Text bold>{workspaceName}</Text>
        <Text dimColor>{workspace}</Text>
        <Row label="Git" value={repo ?? 'unavailable'} Box={Box} Text={Text} cols={cols} orange={!repo} />
        <Row label="History" value={`${messageCount} entries`} Box={Box} Text={Text} cols={cols} />
        <Row label="Storage" value="saved" Box={Box} Text={Text} cols={cols} green />
        <Box height={1} />

        <Text dimColor>{'─'.repeat(cols)}</Text>
        <Text dimColor>live while streaming · persisted across sessions</Text>
      </Box>
    )
  })
}

function Row(props: {
  label: string
  value: string
  Box: any
  Text: any
  cols: number
  green?: boolean
  orange?: boolean
}) {
  const { label, value, Box, Text, cols, green, orange } = props
  return (
    <Box flexDirection="row" justifyContent="space-between" width={cols}>
      <Text dimColor>{label}</Text>
      <Text color={green ? 'green' : orange ? 'yellow' : undefined}>{value}</Text>
    </Box>
  )
}
