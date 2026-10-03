/* @jsx h */
import type { Register } from 'claude-code'

// ---- model speed + prompt-cache meter, drawn as a docked sidebar ----
// TPS  = output tokens / the time the response was streaming (first token to
//        the last one). TTFT = request sent -> first token. Cache rows come
//        from the API's usage fields on every step. The "Valid for" countdown
//        is the main-conversation prompt-cache TTL (5m or 1h) minus the wall
//        time since the last response finished.

type Stats = { tps: number; ttftMs: number | null; isWarmingUp?: boolean }
type Last = Stats & { at: number }
type Sums = { input: number; output: number; cacheRead: number; cacheWrite: number }

let live: Stats | null = null // the step currently streaming
let last: Last | null = null // the last finished step
let sums: Sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
let lastInvalidateAt = 0
let tick: unknown
let isOpen = false // ponytail: module var, a hot reload reopens the pane anyway

const PANE = { id: 'meter', title: 'Claude Code Sidebar', columns: 38, rows: 3 } as const
let git: {
  branch: string | null
  dirty: boolean | null
  changed: number
  added: number
  removed: number
  tracked: number
} | null = null
let gitAt = 0
let tasks: Task[] = [] // the main conversation's task list, as its task tools last left it

const round1 = (n: number) => Math.round(n * 10) / 10

function formatTtft(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function formatTps(n: number): string {
  return n >= 100 ? `${Math.round(n)} tok/s` : `${n.toFixed(0)} tok/s`
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// One accent on a neutral base. Green/amber/red appear only as status
// (git state, cache about to expire, lines added/removed), never decoration.
const C = {
  accent: '#7aa2f7',
  track: '#3b4048',
  muted: '#8b919a',
  ok: '#8fbf7a',
  warn: '#d9a55b',
  bad: '#e07a7a',
}

// Compact counts: 76, 16.8k, 3.68M. Calmer than 3,684,818 in a narrow column.
function compact(n: number): string {
  if (n < 1000) return String(n)
  const k = (n / 1000).toFixed(n < 100_000 ? 1 : 0)
  // 999,950 rounds to "1000" k: that is 1M, so fall through to millions.
  if (+k < 1000) return `${+k}k`
  return `${+(n / 1_000_000).toFixed(2)}M`
}

// Smooth block bar. Terminal: full cells █, then one partial cell in eighths
// (▏..▉) so the end moves smoothly, then a dim ░ track; monospace, exact.
// Desktop/remote: an SVG pill, since a proportional font makes glyph runs drift.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function smoothBar(ratio: number, width: number): { fill: string; track: string } {
  const eighths = Math.round(Math.max(0, Math.min(1, ratio)) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  return { fill: '█'.repeat(full) + part, track: '░'.repeat(width - full - (part ? 1 : 0)) }
}

function Bar(props: { ratio: number; color: string; width: number; surface: string; el: any }) {
  const { ratio, color, width, surface, el } = props
  const r = Math.max(0, Math.min(1, ratio))
  if (surface === 'terminal') {
    const { fill, track } = smoothBar(r, width)
    return (
      <el.Text>
        <el.Text color={color}>{fill}</el.Text>
        <el.Text color={C.track}>{track}</el.Text>
      </el.Text>
    )
  }
  const w = Math.round(r * 1000)
  // 8px pill centred in 14px: the transparent margin spaces rows on desktop.
  // rx is wider than ry because the 1000-wide viewBox is squeezed to the pane.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="14" viewBox="0 0 1000 14" preserveAspectRatio="none"><rect y="3" width="1000" height="8" rx="10" ry="4" fill="${C.track}"/>${w > 0 ? `<rect y="3" width="${Math.max(w, 20)}" height="8" rx="10" ry="4" fill="${color}"/>` : ''}</svg>`
  return (
    <el.Box width="100%">
      <el.Svg source={svg} alt={`${Math.round(r * 100)}%`} height={14} />
    </el.Box>
  )
}

function Title(props: { label: string; right?: string; el: any }) {
  const { label, right, el } = props
  return (
    <el.Box flexDirection="row" justifyContent="space-between" width="100%">
      <el.Text bold>{label}</el.Text>
      {right !== undefined ? <el.Text bold color={C.accent}>{right}</el.Text> : undefined}
    </el.Box>
  )
}

function Row(props: { label: string; value: string; el: any; color?: string; dim?: boolean }) {
  const { label, value, el, color, dim } = props
  return (
    <el.Box flexDirection="row" justifyContent="space-between" width="100%">
      <el.Text color={C.muted}>{label}</el.Text>
      <el.Text color={dim ? C.muted : color}>{value}</el.Text>
    </el.Box>
  )
}

async function pollGit($: any): Promise<void> {
  try {
    const branchRun = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 })
    const statusRun = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 })
    const diffRun = await $.process.run(['git', 'diff', '--numstat'], { timeoutMs: 3000 })
    const counts = await $.process.run(['git', 'ls-files'], { timeoutMs: 3000 })
    if (branchRun.exitCode !== 0) {
      git = null // not a repo: the sidebar shows its empty state
      return
    }
    const branch = String(branchRun.stdout).trim() || null
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

    await $.command.register({ name: 'sidebar', description: 'Show or hide the sidebar' })

    // Dock the sidebar beside the transcript (columns => docked).
    await $.ui
      .open(PANE)
      .then(r => { isOpen = r?.isPlaced !== false })
      .catch(err => $.ui.log(`sidebar: pane not opened: ${err}`))

    // Tick once a second so the cache countdown moves.
    ;(tick as { cancel(): void } | undefined)?.cancel?.()
    tick = $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
    })

    return result
  })

  on('command.run', { command: 'sidebar' }, async $ => {
    const shown = await toggle($)
    return { text: shown ? 'Sidebar shown.' : 'Sidebar hidden. /sidebar or ctrl+x s shows it again.' }
  })

  // While hidden, a one-line "show" button above the prompt keeps the shortcut
  // alive: a Button's `action` chord only fires while that Button is mounted.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOpen || e.props.hasSurvey) return next(e)
    const { Box, Button } = (await $.ui.resolve(e)) as any
    return (
      <Box>
        <Button key="toggle" label="Show sidebar  ctrl+x s" plain dimColor action={TOGGLE_ACTION} onPress={() => toggle($)} />
      </Box>
    )
  })

  // The person can also close it with the pane's own x; keep the toggle in step.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE.id) {
      isOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Tasks: follow the main conversation's task tools. Subagents keep lists of
  // their own (agentId set); those would muddle the plan shown here.
  on('tool.call', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId || !TASK_TOOLS.has(e.tool) || 'deny' in out || out.isError) return out
    const args = e as unknown as Record<string, unknown>
    if (e.tool === 'TodoWrite') tasks = applyTodoWrite(args.todos)
    else if (e.tool === 'TaskCreate') tasks = applyTaskCreate(tasks, args, out.result, out.text)
    else tasks = applyTaskUpdate(tasks, args)
    $.ui.invalidate('ui.render')
    return out
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let firstTokenAt: number | null = null
    let lastTokenAt: number | null = null
    let chars = 0
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        // Every streamed piece of output counts: visible text, thinking, and
        // tool-call arguments (a file the model writes streams as `input`).
        const piece =
          chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text : chunk.kind === 'input' ? chunk.json : null
        if (piece !== null) {
          const now = await $.clock.now()
          if (firstTokenAt === null) firstTokenAt = now
          lastTokenAt = now
          chars += piece.length
          const tps = speed(Math.round(chars / 4), firstTokenAt, now)
          live = { tps: tps ?? live?.tps ?? last?.tps ?? 0, ttftMs: firstTokenAt - startedAt, isWarmingUp: tps === null }
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
    const usage = result.usage
    if (usage) {
      sums = {
        input: sums.input + (usage.input_tokens ?? 0),
        output: sums.output + (usage.output_tokens ?? 0),
        cacheRead: sums.cacheRead + (usage.cache_read_input_tokens ?? 0),
        cacheWrite: sums.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
      }
      $.store.set('sums', sums).catch(err => {
        $.ui.log(`sidebar: store write failed: ${err}`)
      })
    }
    if (usage || chars > 0) {
      // A response arrived: the cache clock restarts whether or not the
      // speed reading below is trustworthy.
      const tps = firstTokenAt === null ? null : speed(usage?.output_tokens ?? Math.round(chars / 4), firstTokenAt, lastTokenAt!)
      last = {
        tps: tps ?? last?.tps ?? 0,
        ttftMs: firstTokenAt === null ? (last?.ttftMs ?? null) : firstTokenAt - startedAt,
        at: endedAt,
      }
      $.store.set('last', last).catch(err => {
        $.ui.log(`sidebar: store write failed: ${err}`)
      })
    }
    live = null
    $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'meter') return next(e)
    // Being drawn means it is open. An unasked open below 144 columns waits
    // ({ isPlaced: false }) and is seated later, after session.start already
    // recorded it closed; without this the band's "Show sidebar" lingers.
    if (!isOpen) {
      isOpen = true
      $.ui.invalidate('ui.render') // drop the band's show button
    }
    const els = (await $.ui.resolve(e)) as any // Svg exists on desktop, not terminal
    const { Box, Text } = els

    // CONTEXT figures from the session usage (same source as the status line).
    let contextPct: number | null = null
    let contextLine = '— / —'
    let rateLimits: { percentUsed: number }[] = []
    try {
      const usage = await $.session.usage()
      rateLimits = usage?.rateLimits ?? []
      if (usage && usage.context && usage.context.window) {
        const used = usage.context.tokens ?? 0
        contextPct = used / usage.context.window
        contextLine = `${compact(used)} / ${compact(usage.context.window)}`
      }
    } catch {
      // a test or a build without session.usage: draw without context
    }

    // Prompt-cache TTL of the main conversation, resolved as Claude Code does.
    const [envTtl, force5m, enable1h, settings] = await Promise.all([
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(() => undefined),
      $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined),
      $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined),
      $.settings.read().catch(() => ({}) as Record<string, unknown>),
    ])
    const ttl = resolveTtl({
      envTtl,
      force5m,
      enable1h,
      setting: settings.promptCacheTtl,
      rateLimits,
    })
    const ttlMin = ttl.minutes

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

    const ctxPctText = contextPct === null ? '—' : `${(contextPct * 100).toFixed(1)}%`
    const rateText = rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
    const validText = remaining === null ? '—' : formatCountdown(remaining)
    const speedText = liveStats && liveStats.tps > 0 ? formatTps(liveStats.tps) : '—'
    // Expiry is the one value that changes meaning near zero: color it then.
    const expiryColor = remaining === null ? C.muted : remaining < 30_000 ? C.bad : remaining < 90_000 ? C.warn : undefined
    const el = els
    const barW = Math.max(10, (e.props.bodyColumns || 30) - 3) // minus paddingLeft 1 + paddingRight 2

    // Main-screen terminal seats the pane inline above the prompt, full width:
    // a sidebar layout there is a takeover, so draw a compact strip instead.
    if (e.props.placement === 'inline') {
      const dot = <Text color={C.track}>  ·  </Text>
      return (
        <Box flexDirection="column" width="100%">
          <Box flexDirection="row" width="100%" flexWrap="wrap">
            <Text color={C.muted}>Context </Text>
            <Bar ratio={contextBarRatio} color={C.accent} width={16} surface={e.surface} el={el} />
            <Text bold color={C.accent}> {ctxPctText}</Text>
            {dot}
            <Text color={C.muted}>Cache </Text><Text>{rateText}</Text>
            <Text color={C.muted}> expires </Text><Text color={expiryColor}>{validText}</Text>
            {dot}
            <Text color={C.muted}>Speed </Text><Text>{speedText}</Text>
            {dot}
            <Text color={C.muted}>Total </Text>
            <Text>{compact(sums.input + sums.output + sums.cacheRead + sums.cacheWrite)}</Text>
          </Box>
          <Text color={C.muted}>Run /tui fullscreen to dock this as a sidebar.</Text>
        </Box>
      )
    }

    const gap = <Box height={1} />
    return (
      <Box flexDirection="column" width="100%" minHeight={e.props.scroll?.bodyRows} paddingLeft={1} paddingRight={2} paddingTop={1}>
        {tasks.length > 0 ? (
          <Box flexDirection="column" width="100%" marginBottom={1}>
            <Title label="Tasks" right={`${taskDone(tasks)}/${tasks.length}`} el={el} />
            <Bar ratio={taskDone(tasks) / tasks.length} color={C.accent} width={barW} surface={e.surface} el={el} />
            <TaskNow tasks={tasks} el={el} />
          </Box>
        ) : undefined}
        <Title label="Context" right={ctxPctText} el={el} />
        <Bar ratio={contextBarRatio} color={C.accent} width={barW} surface={e.surface} el={el} />
        <Text color={C.muted}>{contextLine} tokens</Text>
        {gap}

        <Title label="Tokens" el={el} />
        <Row label="Input" value={compact(sums.input)} el={el} />
        <Row label="Output" value={compact(sums.output)} el={el} />
        <Row label="Cache read" value={compact(sums.cacheRead)} el={el} />
        <Row label="Cache write" value={compact(sums.cacheWrite)} el={el} />
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text>Total</Text>
          <Text bold>{compact(sums.input + sums.output + sums.cacheRead + sums.cacheWrite)}</Text>
        </Box>
        {gap}

        <Title label="Cache" el={el} />
        <Row label="Hit rate" value={rateText} el={el} color={C.accent} />
        <Bar ratio={rate ?? 0} color={C.accent} width={barW} surface={e.surface} el={el} />
        {gap}
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text color={C.muted}>Expires in</Text>
          <Text>
            <Text color={expiryColor}>{validText}</Text>
            <Text color={C.muted}> / {ttlMin === 60 ? '1h' : '5m'}</Text>
          </Text>
        </Box>
        <Bar ratio={remainingRatio} color={expiryColor ?? C.accent} width={barW} surface={e.surface} el={el} />
        {/* Which rule set the TTL, on its own line: beside the time it overflowed a narrow pane. */}
        <Text color={C.muted}>{ttlMin === 60 ? '1h' : '5m'} cache · {ttl.source}</Text>
        {gap}

        <Title label="Speed" el={el} />
        <Row label="First token" value={formatTtft(liveStats?.ttftMs ?? null)} el={el} />
        <Row label="Output" value={speedText} el={el} />
        {gap}

        <Title label="Workspace" el={el} />
        <Row label="Folder" value={workspaceName} el={el} />
        {git ? (
          <Box flexDirection="column" width="100%">
            <Row label="Branch" value={git.branch ?? 'detached'} el={el} />
            <Row label="Status" value={git.dirty ? `${git.changed} changed` : 'Clean'} el={el} color={git.dirty ? C.warn : C.ok} />
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text color={C.muted}>Lines</Text>
              <Text>
                <Text color={C.ok}>+{compact(git.added)}</Text>
                <Text color={C.muted}> </Text>
                <Text color={C.bad}>−{compact(git.removed)}</Text>
              </Text>
            </Box>
          </Box>
        ) : (
          <Row label="Git" value="Not a repository" el={el} dim />
        )}

        {/* Spacer: the pane's body is bodyRows tall, so the toggle sits at its foot. */}
        <Box flexGrow={1} minHeight={1} />
        <els.Button key="toggle" label="Hide sidebar  ctrl+x s" plain dimColor action={TOGGLE_ACTION} onPress={() => toggle($)} />
      </Box>
    )
  })
}

// Borrowed engine action: the person binds a chord to it in keybindings.json
// (ctrl+x s -> app:toggleReplTab), and that chord presses whichever toggle
// button is mounted. ponytail: no custom-action API for plugins yet; swap the
// name if the engine ever mounts its own handler for this action.
const TOGGLE_ACTION = 'app:toggleReplTab'

async function toggle($: any): Promise<boolean> {
  if (isOpen) {
    await $.ui.close({ id: PANE.id })
    isOpen = false
  } else {
    await $.ui.open(PANE)
    isOpen = true
  }
  $.ui.invalidate('ui.render') // the band's show button appears/disappears
  return isOpen
}

// Prompt-cache TTL for the main conversation, per Claude Code's own
// `promptCacheTtl` setting description: CLAUDE_CODE_PROMPT_CACHE_TTL wins,
// then the setting, then automatic (1 hour on a Claude subscription within its
// usage limits, 5 minutes on an API key, Bedrock, Vertex or Foundry).
// rateLimits is empty off a subscription; any window at 100% means over limits.
// ponytail: where FORCE_PROMPT_CACHING_5M / ENABLE_PROMPT_CACHING_1H sit
// against the setting is not documented; they rank just under the env TTL.
export function resolveTtl(i: {
  envTtl?: string
  force5m?: string
  enable1h?: string
  setting?: unknown
  rateLimits: { percentUsed: number }[]
}): { minutes: 5 | 60; source: string } {
  if (i.envTtl === '1h') return { minutes: 60, source: 'env' }
  if (i.envTtl === '5m') return { minutes: 5, source: 'env' }
  if (i.force5m === '1') return { minutes: 5, source: 'env' }
  if (i.enable1h === '1') return { minutes: 60, source: 'env' }
  if (i.setting === '1h') return { minutes: 60, source: 'setting' }
  if (i.setting === '5m') return { minutes: 5, source: 'setting' }
  if (i.rateLimits.length === 0) return { minutes: 5, source: 'API key' }
  if (i.rateLimits.some(r => r.percentUsed >= 100)) return { minutes: 5, source: 'over limit' }
  return { minutes: 60, source: 'subscription' }
}

// Output tokens per second over the streaming span (first piece -> last piece).
// Under MIN_SPAN_MS the span is mostly network burst, not generation: a reply
// that lands in one or two chunks would read as thousands of tok/s, so no
// reading is taken (null) and the previous one stays on screen.
const MIN_SPAN_MS = 500
export function speed(tokens: number, firstAt: number, lastAt: number): number | null {
  const spanMs = lastAt - firstAt
  if (tokens <= 0 || spanMs < MIN_SPAN_MS) return null
  return round1((tokens / spanMs) * 1000)
}

// ---- Tasks ----
// Two task tools exist: TodoWrite sends the whole list every call; TaskCreate /
// TaskUpdate add or change one task at a time, by id.
type TaskStatus = 'pending' | 'in_progress' | 'completed'
type Task = { id: string; title: string; active?: string; status: TaskStatus }
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
const asStatus = (v: unknown): TaskStatus | null =>
  v === 'pending' || v === 'in_progress' || v === 'completed' ? v : null
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const taskDone = (list: Task[]) => list.filter(t => t.status === 'completed').length

export function applyTodoWrite(todos: unknown): Task[] {
  if (!Array.isArray(todos)) return []
  return todos.flatMap((t, i) => {
    const title = str(t?.content)
    return title ? [{ id: String(i), title, active: str(t?.activeForm), status: asStatus(t?.status) ?? 'pending' }] : []
  })
}

export function applyTaskCreate(list: Task[], args: Record<string, unknown>, result: unknown, text?: string): Task[] {
  const title = str(args.subject)
  if (!title) return list
  // The new id comes back in the result: its record, or "Task #12 created ...".
  const rec = (result as { task?: { id?: unknown } } | null)?.task?.id
  const id = rec !== undefined ? String(rec) : (/#(\w+)/.exec(text ?? '')?.[1] ?? `new-${list.length}`)
  return [...list.filter(t => t.id !== id), { id, title, active: str(args.activeForm), status: 'pending' }]
}

export function applyTaskUpdate(list: Task[], args: Record<string, unknown>): Task[] {
  const id = str(String(args.taskId ?? ''))
  if (!id) return list
  if (args.status === 'deleted') return list.filter(t => t.id !== id)
  return list.map(t =>
    t.id !== id
      ? t
      : {
          ...t,
          status: asStatus(args.status) ?? t.status,
          title: str(args.subject) ?? t.title,
          active: str(args.activeForm) ?? t.active,
        },
  )
}

// The line under the bar: the task in progress (in its "-ing" form), else the
// next one up, else a done note.
function TaskNow(props: { tasks: Task[]; el: any }) {
  const { tasks, el } = props
  const now = tasks.find(t => t.status === 'in_progress')
  if (now) return <el.Text wrap="truncate">▸ {now.active ?? now.title}</el.Text>
  const next = tasks.find(t => t.status === 'pending')
  if (next) return <el.Text color={C.muted} wrap="truncate">Next: {next.title}</el.Text>
  return <el.Text color={C.ok}>All done</el.Text>
}
