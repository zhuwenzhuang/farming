const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizedValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedReasoning(value) {
  const normalized = normalizedValue(value).replace(/[\s_-]+/g, '');
  if (normalized === 'extrahigh') return 'xhigh';
  return normalized;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function codexServiceTierConfirmations(outputText) {
  const text = stripAnsi(outputText).replace(/\r/g, '\n');
  return Array.from(text.matchAll(/(?:^|\n)\s*[•●]\s+Service tier set to\s+(priority|default)\b/gi))
    .map(match => ({
      serviceTier: normalizedValue(match[1]) === 'priority' ? 'priority' : 'default',
      fast: normalizedValue(match[1]) === 'priority',
    }));
}

function newCodexServiceTierConfirmation(previousOutput, currentOutput) {
  const previous = stripAnsi(previousOutput);
  const current = stripAnsi(currentOutput);
  const previousConfirmations = codexServiceTierConfirmations(previous);
  const currentConfirmations = codexServiceTierConfirmations(current);
  if (current.startsWith(previous)) {
    return codexServiceTierConfirmations(current.slice(previous.length)).at(-1) || null;
  }
  if (currentConfirmations.length > previousConfirmations.length) {
    return currentConfirmations.at(-1) || null;
  }
  const previousLast = previousConfirmations.at(-1) || null;
  const currentLast = currentConfirmations.at(-1) || null;
  if (!currentLast) return null;
  if (!previousLast || currentLast.serviceTier !== previousLast.serviceTier) return currentLast;
  return null;
}

function terminalCommand(command) {
  return [{ type: 'paste', text: command }, '\r'];
}

function numberedOptionsAfter(previewText, headingPattern) {
  const text = String(previewText || '');
  const matches = Array.from(text.matchAll(headingPattern));
  const heading = matches[matches.length - 1];
  if (!heading || typeof heading.index !== 'number') return null;

  const options = [];
  const body = text.slice(heading.index + heading[0].length);
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[>›❯]\s*)?(\d{1,2})[.)]?\s+(.+?)\s*$/u);
    if (!match) continue;
    options.push({
      input: match[1],
      label: match[2].replace(/\s{2,}.*$/, '').trim(),
      line: match[2].trim(),
    });
  }
  return options;
}

function codexModelMenuOptions(previewText) {
  return numberedOptionsAfter(previewText, /Select Model and Effort/gi);
}

function codexReasoningMenuOptions(previewText) {
  return numberedOptionsAfter(previewText, /Select Reasoning Level for\s+[^\r\n]+/gi);
}

function codexAdvancedReasoningMenuOptions(previewText) {
  return numberedOptionsAfter(previewText, /Advanced Reasoning/gi);
}

function modelSelectionInput(previewText, model) {
  const target = normalizedValue(model);
  const options = codexModelMenuOptions(previewText);
  if (!options) return null;
  const option = options.find(item => {
    const firstToken = item.line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\b/)?.[1];
    return normalizedValue(firstToken) === target;
  });
  return option?.input || '';
}

function reasoningSelectionInput(previewText, effort) {
  const target = normalizedReasoning(effort);
  const options = codexAdvancedReasoningMenuOptions(previewText)
    || codexReasoningMenuOptions(previewText);
  if (!options) return null;
  const option = options.find(item => {
    const label = normalizedReasoning(item.label);
    const line = normalizedReasoning(item.line);
    return label === target || line === target || line.startsWith(target);
  });
  return option?.input || '';
}

function moreReasoningSelectionInput(previewText) {
  const options = codexReasoningMenuOptions(previewText);
  if (!options) return null;
  const option = options.find(item => normalizedReasoning(item.label).startsWith('morereasoning'));
  return option?.input || '';
}

function codexTerminalProfileFromPreview(previewText) {
  const text = String(previewText || '');
  const matches = Array.from(text.matchAll(
    /\b([A-Za-z0-9][A-Za-z0-9._:/-]*-[A-Za-z0-9._-]+)\s+(minimal|low|medium|high|xhigh|extra\s+high|max|ultra)\b(\s+fast\b)?/gi
  ));
  const match = matches[matches.length - 1];
  if (!match) return null;
  const confirmedTier = codexServiceTierConfirmations(text).at(-1) || null;
  return {
    model: normalizedValue(match[1]),
    effort: normalizedReasoning(match[2]),
    fast: match[3] ? true : (confirmedTier ? confirmedTier.fast : null),
  };
}

function codexTerminalProfileFromOutput(outputText) {
  const text = stripAnsi(outputText).replace(/\r/g, '\n');
  const matches = Array.from(text.matchAll(
    /(?:^|\n)\s*[•●]\s+Model changed to\s+([A-Za-z0-9][A-Za-z0-9._:/-]*-[A-Za-z0-9._-]+)\s+(minimal|low|medium|high|xhigh|extra\s+high|max|ultra)\b/gi
  ));
  const match = matches.at(-1);
  if (!match) return null;
  const confirmedTier = codexServiceTierConfirmations(text).at(-1) || null;
  return {
    model: normalizedValue(match[1]),
    effort: normalizedReasoning(match[2]),
    fast: confirmedTier ? confirmedTier.fast : null,
  };
}

function profileMatches(current, target, options = {}) {
  if (!current) return false;
  if (normalizedValue(current.model) !== normalizedValue(target.model)) return false;
  if (normalizedReasoning(current.effort) !== normalizedReasoning(target.effort)) return false;
  if (options.includeFast === true) {
    return current.fast === (target.serviceTier === 'priority');
  }
  return true;
}

async function waitForPreview(readPreview, predicate, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const preview = String(await readPreview() || '');
    const result = predicate(preview);
    if (result) return { preview, result };
    if (Date.now() >= deadline) throw new Error(options.timeoutMessage || 'Timed out waiting for Codex Terminal');
    await sleepFn(pollIntervalMs);
  }
}

function validateTargetProfile(profile) {
  const model = String(profile?.model || '').trim();
  const effort = String(profile?.effort || '').trim();
  const serviceTier = profile?.serviceTier === 'priority' ? 'priority' : 'default';
  if (!model || model.length > 120 || /[\u0000-\u001f\u007f\s]/.test(model)) {
    throw new Error('A valid Codex model is required');
  }
  if (!effort || effort.length > 40 || /[\u0000-\u001f\u007f]/.test(effort)) {
    throw new Error('A valid Codex reasoning effort is required');
  }
  return { model, effort, serviceTier };
}

async function applyCodexTerminalProfile({
  profile,
  readPreview,
  readOutput,
  sendInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep: sleepFn,
}) {
  const target = validateTargetProfile(profile);
  const waitOptions = { timeoutMs, pollIntervalMs, sleep: sleepFn };
  let preview = String(await readPreview() || '');
  let current = codexTerminalProfileFromPreview(preview);
  if (!current) {
    throw new Error('Codex Terminal is not idle; wait for its composer before changing the model');
  }
  if (
    codexModelMenuOptions(preview)
    || codexReasoningMenuOptions(preview)
    || codexAdvancedReasoningMenuOptions(preview)
  ) {
    throw new Error('Close the active Codex Terminal menu before changing the model');
  }

  let pickerDepth = 0;
  try {
    if (!profileMatches(current, target)) {
      await sendInput(terminalCommand('/model'));
      pickerDepth = 1;
      const modelMenu = await waitForPreview(
        readPreview,
        text => {
          const options = codexModelMenuOptions(text);
          return options && options.length > 0 ? options : null;
        },
        {
          ...waitOptions,
          timeoutMessage: 'Codex did not open its model menu',
        }
      );
      const modelInput = modelSelectionInput(modelMenu.preview, target.model);
      if (!modelInput) {
        throw new Error(`Model ${target.model} is not available in this Codex CLI`);
      }
      await sendInput(modelInput);

      const reasoningStep = await waitForPreview(
        readPreview,
        text => {
          const nextProfile = codexTerminalProfileFromPreview(text);
          if (profileMatches(nextProfile, target)) return { complete: true };
          const options = codexReasoningMenuOptions(text);
          return options && options.length > 0 ? { options } : null;
        },
        {
          ...waitOptions,
          timeoutMessage: `Codex did not open the reasoning menu for ${target.model}`,
        }
      );

      if (!reasoningStep.result.complete) {
        let reasoningInput = reasoningSelectionInput(reasoningStep.preview, target.effort);
        if (!reasoningInput) {
          const moreInput = moreReasoningSelectionInput(reasoningStep.preview);
          if (moreInput) {
            await sendInput(moreInput);
            pickerDepth = 2;
            const advancedStep = await waitForPreview(
              readPreview,
              text => {
                const options = codexAdvancedReasoningMenuOptions(text);
                return options && options.length > 0 ? options : null;
              },
              {
                ...waitOptions,
                timeoutMessage: `Codex did not open advanced reasoning for ${target.model}`,
              }
            );
            reasoningInput = reasoningSelectionInput(advancedStep.preview, target.effort);
          }
        }
        if (!reasoningInput) {
          throw new Error(`Reasoning effort ${target.effort} is not available for ${target.model}`);
        }
        await sendInput(reasoningInput);
        const applied = await waitForPreview(
          readPreview,
          text => profileMatches(codexTerminalProfileFromPreview(text), target),
          {
            ...waitOptions,
            timeoutMessage: `Codex did not confirm ${target.model} ${target.effort}`,
          }
        );
        pickerDepth = 0;
        preview = applied.preview;
        current = codexTerminalProfileFromPreview(preview);
      } else {
        pickerDepth = 0;
        preview = reasoningStep.preview;
        current = codexTerminalProfileFromPreview(preview);
      }
    }

    const wantsFast = target.serviceTier === 'priority';
    if (!current) current = codexTerminalProfileFromPreview(String(await readPreview() || ''));
    if (!current) throw new Error('Codex Terminal stopped reporting its active model');
    if (current.fast !== wantsFast) {
      if (typeof readOutput === 'function') {
        let previousOutput = String(await readOutput() || '');
        const toggleFastAndConfirm = async () => {
          await sendInput(terminalCommand('/fast'));
          const confirmation = await waitForPreview(
            readOutput,
            output => {
              const explicit = newCodexServiceTierConfirmation(previousOutput, output);
              if (explicit) return explicit;
              const renderedProfile = codexTerminalProfileFromPreview(stripAnsi(output));
              if (profileMatches(renderedProfile, target, { includeFast: true })) {
                return { serviceTier: wantsFast ? 'priority' : 'default', fast: wantsFast };
              }
              return null;
            },
            {
              ...waitOptions,
              timeoutMessage: `Codex did not confirm its Fast mode service tier`,
            }
          );
          previousOutput = confirmation.preview;
          return confirmation.result;
        };
        let confirmed = await toggleFastAndConfirm();
        if (confirmed.fast !== wantsFast) {
          confirmed = await toggleFastAndConfirm();
        }
        if (confirmed.fast !== wantsFast) {
          throw new Error(`Codex did not ${wantsFast ? 'enable' : 'disable'} Fast mode`);
        }
        current = { ...current, fast: confirmed.fast };
      } else {
        await sendInput(terminalCommand('/fast'));
        const fastApplied = await waitForPreview(
          readPreview,
          text => profileMatches(codexTerminalProfileFromPreview(text), target, { includeFast: true }),
          {
            ...waitOptions,
            timeoutMessage: `Codex did not ${wantsFast ? 'enable' : 'disable'} Fast mode`,
          }
        );
        preview = fastApplied.preview;
        current = codexTerminalProfileFromPreview(preview);
      }
    }

    return {
      model: current.model,
      effort: current.effort,
      serviceTier: current.fast ? 'priority' : 'default',
    };
  } catch (error) {
    while (pickerDepth > 0) {
      try {
        await sendInput('\x1b');
      } catch {
        break;
      }
      pickerDepth -= 1;
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  applyCodexTerminalProfile,
  codexServiceTierConfirmations,
  codexTerminalProfileFromOutput,
  codexAdvancedReasoningMenuOptions,
  codexModelMenuOptions,
  codexReasoningMenuOptions,
  codexTerminalProfileFromPreview,
  modelSelectionInput,
  moreReasoningSelectionInput,
  newCodexServiceTierConfirmation,
  normalizedReasoning,
  reasoningSelectionInput,
  terminalCommand,
  validateTargetProfile,
  waitForPreview,
};
