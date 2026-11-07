// Keep per-model capabilities attached to the authoritative model catalog.
export function integrateCodexModelConfig(source: string): string {
  const boundary = `function modelOptions(availableModels, currentBaseModelId) {
  const options = availableModels.map((model) => ({
    value: model.id,
    name: formatModelDisplayName(model.displayName),
    description: model.description
  }));`;
  if (source.split(boundary).length !== 2) {
    throw new Error('Expected one Codex model options boundary');
  }
  return source.replace(boundary, boundary.replace('description: model.description', `description: model.description,
    _meta: { farming: { modelConfig: {
      version: 1,
      reasoningOptions: model.supportedReasoningEfforts.map((option) => ({
        value: option.reasoningEffort,
        name: capitalize(option.reasoningEffort)
      }))
    } } }`));
}
