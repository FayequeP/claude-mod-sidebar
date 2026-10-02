/* @jsx h */
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { resolveTtl, speed } from './register'

tier('user')

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'test-model',
}

const PANE_PROPS = {
  title: 'Claude Code Sidebar',
  isFocused: false,
  bodyColumns: 38,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

describe('register', () => {
  test('the meter pane shows context, tokens, cache and activity', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, {})

    on('session.usage', async () => ({
      value: {
        context: { tokens: 85400, window: 272000, percent: 31 },
        rateLimits: [],
      },
    }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'D:\\Buisness\\Claude-tps-mod\\tps-meter' }))
    on('session.repo', async () => ({ value: null }))
    on('session.messages', async () => ({ value: [] }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.open', async () => ({ value: undefined }))
    on('ui.invalidate', async () => ({ value: undefined }))
    on('ui.log', async () => ({ value: undefined }))

    on('turn.step', async function* ($, e) {
      yield { kind: 'text', index: 0, text: 'hello world from the model, nicely streamed' }
      yield { kind: 'text', index: 0, text: ' and a second piece two seconds later' }
      yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'hello world',
        toolUses: [],
        stopReason: 'end_turn',
        usage: USAGE,
      }
    })

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: 'D:\\Buisness\\Claude-tps-mod\\tps-meter',
    })

    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })
    await stream.next()
    clock.advance(2000)
    // Drain the stream: the mod's generator only finishes (and records the
    // finished step) once the consumer pulls past its last yield.
    let step = await stream.next()
    while (!step.done) step = await stream.next()
    await stream.result

    const probes = [/^Context$/, /31\.4%/, /85\.4k/, /^Tokens$/, /Cache read/, /^Cache$/, /Expires in/, /[45]:[0-5][0-9]/, /^Speed$/, /First token/, /^Output$/, /^Workspace$/, /tps-meter/]
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'meter-sidebar',
        surface,
        component: 'Pane',
        requestId: 'meter',
        props: PANE_PROPS,
      })
      const missing: string[] = []
      for (const p of probes) {
        if (!(await ui.find({ type: 'Text', text: p }))) missing.push(String(p))
      }
      expect([surface, ...missing]).toEqual([surface])
      await ui.unmount()
    }

    // Inline (main-screen terminal): compact strip, not the tall sidebar.
    const strip = await $.ui.mount({
      plugin: 'meter-sidebar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'meter',
      props: { ...PANE_PROPS, placement: 'inline' as const },
    })
    expect(await strip.find({ type: 'Text', text: /31\.4%/ })).toBeDefined()
    expect(await strip.find({ type: 'Text', text: /First token/ })).toBeUndefined()
    await strip.unmount()
  })

  test('before any turn: labels still draw, values are placeholders', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})

    on('session.usage', async () => ({
      value: { context: { tokens: 0, window: 272000 }, rateLimits: [] },
    }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\\work' }))
    on('session.repo', async () => ({ value: null }))
    on('session.messages', async () => ({ value: [] }))

    const ui = await $.ui.mount({
      plugin: 'meter-sidebar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'meter',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /—/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tps-meter/ })).toBeUndefined()
    await ui.unmount()
  })
  test('/sidebar toggles the pane', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const calls: string[] = []
    on('ui.open', async () => { calls.push('open'); return { value: { isPlaced: true } } })
    on('ui.close', async () => { calls.push('close'); return { value: undefined } })
    on('command.register', async () => ({ value: undefined }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' })
    expect((await $.command.run({ command: 'sidebar' })).text).toMatch(/hidden/)
    expect((await $.command.run({ command: 'sidebar' })).text).toMatch(/shown/)
    expect(calls).toEqual(['open', 'close', 'open'])
  })
  test('a 1M context window reads 1M, not 1000.0k', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    on('session.usage', async () => ({
      value: { context: { tokens: 999_950, window: 1_000_000 }, rateLimits: [] },
    }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\work' }))

    const ui = await $.ui.mount({
      plugin: 'meter-sidebar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'meter',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /^1M \/ 1M tokens$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1000/ })).toBeUndefined()
    await ui.unmount()
  })
  test('cache TTL resolves like Claude Code', async () => {
    const sub = [{ percentUsed: 40 }]
    expect(resolveTtl({ rateLimits: sub })).toEqual({ minutes: 60, source: 'subscription' })
    expect(resolveTtl({ rateLimits: [] })).toEqual({ minutes: 5, source: 'API key' })
    expect(resolveTtl({ rateLimits: [{ percentUsed: 100 }] })).toEqual({ minutes: 5, source: 'over limit' })
    expect(resolveTtl({ rateLimits: sub, setting: '5m' })).toEqual({ minutes: 5, source: 'setting' })
    expect(resolveTtl({ rateLimits: [], setting: '1h' })).toEqual({ minutes: 60, source: 'setting' })
    expect(resolveTtl({ rateLimits: sub, setting: '1h', envTtl: '5m' })).toEqual({ minutes: 5, source: 'env' })
    expect(resolveTtl({ rateLimits: sub, force5m: '1' })).toEqual({ minutes: 5, source: 'env' })
    expect(resolveTtl({ rateLimits: [], enable1h: '1' })).toEqual({ minutes: 60, source: 'env' })
  })
  test('speed ignores bursts and measures first to last piece', async () => {
    expect(speed(20, 0, 2000)).toBe(10) // 20 tokens over 2s
    expect(speed(300, 1000, 1004)).toBeNull() // one burst: no reading, not 75,000 tok/s
    expect(speed(0, 0, 5000)).toBeNull()
    expect(speed(100, 0, 500)).toBe(200)
  })
})
