import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPrinter } from '@/channels/cli/printer'

function memSink(): { sink: Writable; output: () => string } {
  let buf = ''
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      cb()
    },
  })
  return { sink, output: () => buf }
}

describe('createPrinter — text-delta', () => {
  it('writes raw text with no surrounding decoration', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'text-delta', text: 'hello ' })
    printer.print({ type: 'text-delta', text: 'world' })
    expect(output()).toBe('hello world')
  })
})

describe('createPrinter — tool events', () => {
  it('prints tool-call name on its own line', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'tool-call', toolName: 'aave_v3_supply', toolCallId: 'tc-1' })
    expect(output()).toBe('> aave_v3_supply\n')
  })

  it('prints tool-result inline indicator', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'tool-result', toolName: 'x', toolCallId: 'tc-1', output: {} })
    expect(output()).toBe('  done\n')
  })

  it('prints tool-error with message', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'tool-error', error: { message: 'boom' } })
    expect(output()).toBe('  error: boom\n')
  })
})

describe('createPrinter — finish', () => {
  it('prints token usage footer', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'text-delta', text: 'hi' })
    printer.print({ type: 'finish', totalUsage: { inputTokens: 12, outputTokens: 3 } })
    expect(output()).toBe('hi\n[in=12 out=3]\n')
  })

  it('prints nothing if usage missing', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'finish' })
    expect(output()).toBe('')
  })
})

describe('createPrinter — abort + error', () => {
  it('prints [aborted] line for abort event', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'text-delta', text: 'partial' })
    printer.print({ type: 'abort', reason: 'aborted' })
    expect(output()).toBe('partial\n[aborted]\n')
  })

  it('prints error line', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'error', error: { message: 'rate limit' } })
    expect(output()).toBe('error: rate limit\n')
  })
})

describe('createPrinter — endLine', () => {
  it('emits newline only if line is dirty', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    printer.print({ type: 'text-delta', text: 'foo' })
    printer.endLine()
    printer.endLine() // no-op
    expect(output()).toBe('foo\n')
  })
})

describe('createPrinter — ignored events', () => {
  it('drops start/start-step/text-start/text-end/finish-step/etc', () => {
    const { sink, output } = memSink()
    const printer = createPrinter({ out: sink, noColor: true })
    for (const t of [
      'start',
      'start-step',
      'text-start',
      'text-end',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'finish-step',
      'source',
      'file',
      'raw',
    ]) {
      printer.print({ type: t })
    }
    expect(output()).toBe('')
  })
})
