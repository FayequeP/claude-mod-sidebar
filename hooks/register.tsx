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
let git: {
  branch: string | null
  dirty: boolean | null
  changed: number
  added: number
  removed: number
  tracked: number
} | null = null
let gitAt = 0

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

function barSplit(ratio: number, width: number): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return { filled: '█'.repeat(filled), empty: '█'.repeat(width - filled) }
}

function Bar(props: { ratio: number; width: number; color: string; Box: any; Text: any }) {
  const { ratio, width, color, Box, Text } = props
  const { filled, empty } = barSplit(ratio, width)
  return (
    <Box flexDirection="row">
      <Text color={color}>{filled}</Text>
      <Text dimColor>{empty}</Text>
    </Box>
  )
}

function Header(props: { label: string; color?: string; cols: number; right?: string; Box: any; Text: any }) {
  const { label, color, cols, right, Box, Text } = props
  const labelLen = label.length + 1
  const rightLen = right ? right.length + 1 : 0
  const dashes = '─'.repeat(Math.max(2, cols - labelLen - rightLen))
  return (
    <Box flexDirection="row" justifyContent="space-between" width={cols}>
      <Text color={color ?? 'cyan'}>{`${label} ${dashes}`}</Text>
      {right !== undefined ? <Text>{right}</Text> : undefined}
    </Box>
  )
}

async function pollGit($: any): Promise<void> {
  try {
    const branchRun = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 })
    const statusRun = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 })
    const diffRun = await $.process.run(['git', 'diff', '--numstat'], { timeoutMs: 3000 })
    const counts = await $.process.run(['git', 'ls-files'], { timeoutMs: 3000 })
    const branch = branchRun.exitCode === 0 ? String(branchRun.stdout).trim() || null : null
    const statusLines =
      statusRun.exitCode === 0 ? String(statusRun.stdout).split('\n').filter(l => l.trim().length > 0) : []
    let added = 0
    let removed = 0
    for (const line of String(diffRun.stdout).split('\n')) {
      const parts = line.split(/\s+/)
      if (parts.length >= 2 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
        added += Number(parts[0])
        removed += Number(parts[1])
      }
    }
    const tracked =
      counts.exitCode === 0 ? String(counts.stdout).split('\n').filter(l => l.trim().length > 0).length : 0
    git = { branch, dirty: statusLines.length > 0, changed: statusLines.length, added, removed, tracked }
  } catch {
    // not a repo or git missing: keep last known
  }
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
    if (now - gitAt > 5000) {
      gitAt = now
      await pollGit($)
    }
    const remaining = last ? ttlMin * 60_000 - (now - last.at) : null
    const remainingRatio = remaining !== null ? remaining / (ttlMin * 60_000) : 0

    let workspace = ''
    try {
      workspace = await $.session.cwd()
    } catch {
      // keep defaults
    }
    const workspaceName = workspace ? workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '' : '—'

    const liveStats = live ?? last
    const rate = hitRate()
    const contextBarRatio = contextPct ?? 0

    const fmtK = (n: number): string => {
      if (n >= 1000) {
        const v = (n / 1000).toFixed(1)
        return `${v.endsWith('.0') ? v.slice(0, -2) : v}k`
      }
      return String(n)
    }

    return (
      <Box flexDirection="column" width={cols}>
        <Header label="CONTEXT" color="blue" cols={cols} right={contextPct === null ? '—' : `${(contextPct * 100).toFixed(1)}%`} Box={Box} Text={Text} />
        <Bar ratio={contextBarRatio} width={cols} color="blue" Box={Box} Text={Text} />
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text dimColor>Used</Text>
          <Text dimColor>{contextLine}</Text>
        </Box>
        <Box height={1} />

        <Header label="TOKENS" color="blue" cols={cols} Box={Box} Text={Text} />
        <Row label="↑ Input" value={formatCount(sums.input)} Box={Box} Text={Text} cols={cols} />
        <Row label="↓ Output" value={formatCount(sums.output)} Box={Box} Text={Text} cols={cols} />
        <Row label="⊙ Cache read" value={formatCount(sums.cacheRead)} Box={Box} Text={Text} cols={cols} green />
        <Row label="+ Cache write" value={formatCount(sums.cacheWrite)} Box={Box} Text={Text} cols={cols} />
        <Text dimColor>{'╌'.repeat(cols)}</Text>
        <Row label="Session total" value={formatCount(sums.input + sums.output + sums.cacheRead + sums.cacheWrite)} Box={Box} Text={Text} cols={cols} />
        <Box height={1} />

        <Header label="CACHE" color="blue" cols={cols} Box={Box} Text={Text} />
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text dimColor>Hit rate</Text>
          <Text color="green">{rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</Text>
        </Box>
        <Bar ratio={rate ?? 0} width={cols} color="green" Box={Box} Text={Text} />
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text dimColor>read {fmtK(sums.cacheRead)}</Text>
          <Text dimColor>miss {fmtK(sums.cacheWrite)}</Text>
        </Box>
        <Box height={1} />
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text>Valid for</Text>
          <Text>{remaining === null ? '—' : formatCountdown(remaining)}</Text>
        </Box>
        <Bar ratio={remainingRatio} width={cols} color="yellow" Box={Box} Text={Text} />
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text dimColor>{ttlMin === 60 ? '1h' : '5m'} window</Text>
          <Text dimColor>resets on next call</Text>
        </Box>
        <Box height={1} />

        <Header label="ACTIVITY" color="blue" cols={cols} Box={Box} Text={Text} />
        <Row label="First token" value={formatTtft(liveStats?.ttftMs ?? null)} Box={Box} Text={Text} cols={cols} />
        <Row label="Output speed" value={liveStats ? formatTps(liveStats.tps) : '—'} Box={Box} Text={Text} cols={cols} />
        <Box height={1} />

        <Header label="WORKSPACE" color="magenta" cols={cols} Box={Box} Text={Text} />
        <Text bold>{workspaceName}</Text>
        <Row label="Branch" value={git?.branch ?? '—'} Box={Box} Text={Text} cols={cols} magenta />
        <Row label="Git" value={git ? (git.dirty ? 'Modified' : 'Clean') : '—'} Box={Box} Text={Text} cols={cols} orange={git?.dirty === true} green={git?.dirty === false} />
        <Row label="Changed" value={git ? `${git.changed} files` : '—'} Box={Box} Text={Text} cols={cols} />
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text dimColor>Lines</Text>
          <Box flexDirection="row">
            <Text color="green">{git ? `+${fmtK(git.added)}` : '—'}</Text>
            <Text> </Text>
            <Text color="red">{git ? `-${fmtK(git.removed)}` : ''}</Text>
          </Box>
        </Box>
        <Box height={1} />

        <Text dimColor>{'─'.repeat(cols)}</Text>
        <Text dimColor>ctrl+b hide · ctrl+t tokens · ctrl+k cache</Text>
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
  magenta?: boolean
}) {
  const { label, value, Box, Text, cols, green, orange, magenta } = props
  const color = green ? 'green' : magenta ? 'magenta' : orange ? 'yellow' : undefined
  return (
    <Box flexDirection="row" justifyContent="space-between" width={cols}>
      <Text dimColor>{label}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  )
}
