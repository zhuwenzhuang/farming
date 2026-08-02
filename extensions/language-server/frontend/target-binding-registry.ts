export class TargetBindingRegistry<Binding> {
  private readonly targets = new Map<string, { sourceKey: string; binding: Binding }>()
  private readonly targetsBySource = new Map<string, Set<string>>()

  set(sourceKey: string, targetKey: string, binding: Binding) {
    const previous = this.targets.get(targetKey)
    if (previous && previous.sourceKey !== sourceKey) {
      const previousTargets = this.targetsBySource.get(previous.sourceKey)
      previousTargets?.delete(targetKey)
      if (previousTargets?.size === 0) this.targetsBySource.delete(previous.sourceKey)
    }
    this.targets.set(targetKey, { sourceKey, binding })
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
      if (this.targets.get(targetKey)?.sourceKey === sourceKey) this.targets.delete(targetKey)
    })
    this.targetsBySource.delete(sourceKey)
  }

  get size() {
    return this.targets.size
  }
}
