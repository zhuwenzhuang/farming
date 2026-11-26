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
  source = source.replace(boundary, boundary.replace('description: model.description', `description: model.description,
    _meta: { farming: { modelConfig: {
      version: 1,
      reasoningOptions: model.supportedReasoningEfforts.map((option) => ({
        value: option.reasoningEffort,
        name: capitalize(option.reasoningEffort)
      }))
    } } }`));
  const replace = (from: string, to: string, count = 1) => {
    if (source.split(from).length !== count + 1) throw new Error(`Unexpected Codex model config boundary: ${from}`);
    source = source.replaceAll(from, to);
  };
  replace('withAirMeta(void 0, AIR_MODEL_REASONING_EFFORTS_KEY, efforts)',
    'withAirMeta(option._meta, AIR_MODEL_REASONING_EFFORTS_KEY, efforts)');
  replace('function modelSupportsFast(model) {', `function modelTierOptions(model) {
  if (model?.serviceTiers?.length) return model.serviceTiers.map(({ id, name, description }) => ({ value: id, name, description }));
  return (model?.additionalSpeedTiers ?? []).map(tier => tier === "fast"
    ? { value: "priority", name: "Fast" } : { value: tier, name: capitalize(tier) });
}
function selectedServiceTier(options, tier) {
  const value = tier === "fast" ? "priority" : tier;
  return options.some(option => option.value === value) ? value : "default";
}
function modelSupportsFast(model) {`);
  replace(
    'fastModeEnabled: serviceTierEnablesFast(metadata.currentServiceTier),\n      currentModelSupportsFast: modelSupportsFast(model),',
    'serviceTier: selectedServiceTier(modelTierOptions(model), metadata.currentServiceTier),\n      tierOptions: modelTierOptions(model),',
  );
  replace(
    '{ configId: FAST_MODE_CONFIG_ID, type: "boolean", value: previous.fastModeEnabled },',
    '{ configId: FAST_MODE_CONFIG_ID, value: previous.serviceTier },',
  );
  replace(
    'currentServiceTier: previous.fastModeEnabled ? "fast" : null,',
    'currentServiceTier: previous.serviceTier === "default" ? null : previous.serviceTier,',
  );
  for (const model of ['currentModel', 'model']) {
    replace(`sessionState.currentModelSupportsFast = modelSupportsFast(${model});`, `sessionState.tierOptions = modelTierOptions(${model});
      sessionState.serviceTier = selectedServiceTier(sessionState.tierOptions, sessionState.serviceTier);`);
  }
  replace(`    if (typeof value === "boolean") {
      sessionState.fastModeEnabled = value;
      return;
    }
    if (value !== FAST_MODE_ON && value !== FAST_MODE_OFF) {
      throw RequestError.invalidParams();
    }
    sessionState.fastModeEnabled = value === FAST_MODE_ON;`, `    const tier = value === true || value === FAST_MODE_ON ? "priority"
      : value === false || value === FAST_MODE_OFF ? "default" : value;
    if (tier !== selectedServiceTier(sessionState.tierOptions, tier)) throw RequestError.invalidParams();
    sessionState.serviceTier = tier;`);
  replace('if (sessionState.currentModelSupportsFast) {', `if (sessionState.tierOptions.some(option => option.value !== "priority")) {
      configOptions.push({ id: FAST_MODE_CONFIG_ID, name: "Service tier", category: FAST_MODE_CATEGORY,
        type: "select", currentValue: sessionState.serviceTier,
        options: [{ value: "default", name: "Standard" }, ...sessionState.tierOptions] });
    } else if (sessionState.tierOptions.length) {`);
  replace('sessionState.fastModeEnabled,\n        this.booleanConfigOptionsSupported', 'sessionState.serviceTier === "priority",\n        this.booleanConfigOptionsSupported');
  replace(`resolveFastServiceTier(
        sessionState.fastModeEnabled,
        sessionState.currentModelSupportsFast
      )`, 'sessionState.serviceTier === "default" ? null : sessionState.serviceTier');
  return source;
}
