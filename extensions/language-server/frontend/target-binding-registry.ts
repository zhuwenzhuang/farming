export class TargetBindingRegistry<Binding> {
  private readonly targets = new Map<string, { sources: Set<string>; binding: Binding }>()
  private readonly targetsBySource = new Map<string, Set<string>>()

  set(sourceKey: string, targetKey: string, binding: Binding) {
    const existing = this.targets.get(targetKey)
    if (existing) {
      existing.sources.add(sourceKey)
      existing.binding = binding
    } else {
      this.targets.set(targetKey, { sources: new Set([sourceKey]), binding })
    }
    const sourceTargets = this.targetsBySource.get(sourceKey) || new Set<string>()
    sourceTargets.add(targetKey)
    this.targetsBySource.set(sourceKey, sourceTargets)
  }

  get(targetKey: string) {
    return this.targets.get(targetKey)?.binding
  }

  deleteSource(sourceKey: string) {
    const sourceTargets = this.targetsBySource.get(sourceKey)
    if (!sourceTargets) return
    sourceTargets.forEach(targetKey => {
      const entry = this.targets.get(targetKey)
      if (entry) {
        entry.sources.delete(sourceKey)
        if (entry.sources.size === 0) this.targets.delete(targetKey)
      }
    })
    this.targetsBySource.delete(sourceKey)
  }

  get size() {
    return this.targets.size
  }
}
