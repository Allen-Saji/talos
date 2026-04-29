import { tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolAnnotations } from '@/mcp-host'
import { NativeToolSource } from '@/tools/native'

const ECHO = tool({
  description: 'Echo back the input text',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
})

const READ_ONLY: ToolAnnotations = {
  mutates: false,
  readOnly: true,
  destructive: false,
}

describe('NativeToolSource', () => {
  it('returns the configured tools via getTools()', async () => {
    const src = new NativeToolSource({
      name: 'demo',
      tools: { demo_echo: ECHO },
      annotations: { demo_echo: READ_ONLY },
    })
    const tools = await src.getTools()
    expect(Object.keys(tools)).toEqual(['demo_echo'])
    expect(typeof tools.demo_echo?.execute).toBe('function')
  })

  it('exposes per-tool annotations', () => {
    const src = new NativeToolSource({
      name: 'demo',
      tools: { demo_echo: ECHO },
      annotations: { demo_echo: READ_ONLY },
    })
    expect(src.annotations('demo_echo')).toEqual(READ_ONLY)
    expect(src.annotations('unknown_tool')).toBeUndefined()
  })

  it('lists tool names contributed by the source', () => {
    const src = new NativeToolSource({
      name: 'demo',
      tools: { demo_echo: ECHO, demo_pong: ECHO },
      annotations: { demo_echo: READ_ONLY, demo_pong: READ_ONLY },
    })
    expect(src.toolNames().sort()).toEqual(['demo_echo', 'demo_pong'])
  })

  it('records the source name (used in logs)', () => {
    const src = new NativeToolSource({
      name: 'lifi',
      tools: {},
      annotations: {},
    })
    expect(src.name).toBe('lifi')
  })
})
