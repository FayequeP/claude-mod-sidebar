/* @jsx h */
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'test-model',
}

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

describe('register', () => {
  test('a streamed step sets TPS and TTFT, drawn under the prompt', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, {})

    // Beneath every plugin: the hint line the engine would draw under the prompt.
    on('ui.render', { component: 'PromptHint' }, async ($, e) => {
      const { Box, Text } = await $.ui.resolve(e)
      return (
        <Box>
          <Text>{e.props.hint}</Text>
        </Box>
      )
    })

    on('turn.step', async function* ($, e) {
      yield { kind: 'text', index: 0, text: 'hello world from the model, nicely streamed' }
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

    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })
    await stream.next() // first text chunk
    clock.advance(2000) // two seconds of streaming before the stop lands
    await stream.next() // stop chunk
    await stream.result

    const ui = await $.ui.mount({
      plugin: 'tps-meter',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: true, hint: '? for shortcuts' },
    })
    expect(await ui.find({ type: 'Text', text: /TPS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ttft/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /avg/ })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop app gets the stats through SessionMode', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, {})

    on('ui.render', { component: 'SessionMode' }, async ($, e) => {
      const { Box, Text } = await $.ui.resolve(e)
      return (
        <Box>
          <Text>{e.props.modes.join(' & ')}</Text>
        </Box>
      )
    })

    let statusText: string | undefined
    on('ui.status', async ($, e) => {
      statusText = e.text
      return { value: undefined }
    })

    on('turn.step', async function* ($, e) {
      yield { kind: 'text', index: 0, text: 'hello world from the model, nicely streamed' }
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

    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })
    await stream.next()
    clock.advance(2000)
    await stream.next()
    await stream.result

    const ui = await $.ui.mount({
      plugin: 'tps-meter',
      surface: 'desktop',
      component: 'SessionMode',
      props: { modes: ['manual mode on'] },
    })
    expect(await ui.find({ type: 'Text', text: /TPS · avg/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ttft/ })).toBeDefined()
    await ui.unmount()
    expect(statusText).toMatch(/TPS · avg .* · ttft/)
  })

  test('no stats yet: the hint line is left untouched', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})

    on('ui.render', { component: 'PromptHint' }, async ($, e) => {
      const { Box, Text } = await $.ui.resolve(e)
      return (
        <Box>
          <Text>{e.props.hint}</Text>
        </Box>
      )
    })

    const ui = await $.ui.mount({
      plugin: 'tps-meter',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect(await ui.find({ type: 'Text', text: /TPS/ })).toBeUndefined()
    await ui.unmount()
  })
})
