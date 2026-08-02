export class TargetBindingRegistry<Binding> {
  private readonly targets = new Map<string, Map<string, Binding>>()
  private readonly targetsBySource = new Map<string, Set<string>>()

  set(sourceKey: string, targetKey: string, binding: Binding) {
    const sourceBindings = this.targets.get(targetKey) || new Map<string, Binding>()
    sourceBindings.delete(sourceKey)
    sourceBindings.set(sourceKey, binding)
    this.targets.set(targetKey, sourceBindings)
    const sourceTargets = this.targetsBySource.get(sourceKey) || new Set<string>()
    sourceTargets.add(targetKey)
    this.targetsBySource.set(sourceKey, sourceTargets)
  }

  get(targetKey: string) {
    const sourceBindings = this.targets.get(targetKey)
    if (!sourceBindings) return undefined
    const bindings = Array.from(sourceBindings.values())
    return bindings[bindings.length - 1]
  }

  deleteSource(sourceKey: string) {
    const sourceTargets = this.targetsBySource.get(sourceKey)
    if (!sourceTargets) return
    sourceTargets.forEach(targetKey => {
      const entry = this.targets.get(targetKey)
      if (entry) {
        entry.delete(sourceKey)
        if (entry.size === 0) this.targets.delete(targetKey)
      }
    })
    this.targetsBySource.delete(sourceKey)
  }

  get size() {
    return this.targets.size
  }
}
