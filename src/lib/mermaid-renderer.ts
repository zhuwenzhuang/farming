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
      // Mermaid measures live SVG and HTML labels. Keep its temporary nodes
      // measurable without letting them paint or resize the workspace.
      const host = document.createElement('div')
      host.style.cssText = 'position: fixed; inset: 0; visibility: hidden; pointer-events: none; overflow: hidden'
      host.inert = true
      document.body.append(host)
      try {
        return await mermaid.render(id, source, host)
      } finally {
        host.remove()
      }
    })
    tail = next
    return next
  }
}

