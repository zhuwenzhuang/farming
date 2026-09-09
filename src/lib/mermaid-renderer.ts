type MermaidApi = Pick<typeof import('mermaid').default, 'initialize' | 'parse' | 'render'>
export type MermaidConfig = Parameters<MermaidApi['initialize']>[0]
export type MermaidDiagram = Awaited<ReturnType<MermaidApi['render']>>
export type MermaidRenderer = (id: string, source: string, config: MermaidConfig, current: () => boolean) => Promise<MermaidDiagram>

// initialize/parse/render share a singleton configuration. Keep the entire
// operation serialized, including lazy loading, across all diagram consumers.
export function createMermaidRenderer(load: () => Promise<MermaidApi>): MermaidRenderer {
  let tail: Promise<unknown> = Promise.resolve()
  return (id, source, config, current) => {
    const check = () => { if (!current()) throw new Error('Diagram render superseded') }
    const next = tail.catch(() => {}).then(async () => {
      check()
      const mermaid = await load()
      check()
      mermaid.initialize(config)
      await mermaid.parse(source)
      check()
      return mermaid.render(id, source)
    })
    tail = next
    return next
  }
}

