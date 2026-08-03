const MAX_CAPABILITY_CLI_CHARS = 100_000;

interface CapabilityArtifact extends Record<string, unknown> {
  path?: unknown;
}

interface CapabilityEnvelope {
  ok: true;
  capability: string;
  operation: string;
  result: unknown;
  artifacts: CapabilityArtifact[];
  warnings: string[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractArtifacts(value: unknown): CapabilityArtifact[] {
  const record = recordValue(value);
  const direct = Array.isArray(record.artifacts) ? record.artifacts : [];
  const single = record.artifact ? [record.artifact] : [];
  return [...direct, ...single]
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => ({ ...(item as CapabilityArtifact) }));
}

function resultWithoutArtifacts(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  delete result.artifact;
  delete result.artifacts;
  return result;
}

function boundedEnvelope(envelope: CapabilityEnvelope): CapabilityEnvelope {
  const normalized = {
    ...envelope,
    artifacts: envelope.artifacts.slice(0, 64),
    warnings: envelope.warnings.slice(0, 32).map(warning => String(warning).slice(0, 2_000)),
  };
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_CAPABILITY_CLI_CHARS) return normalized;
  const resultText = JSON.stringify(normalized.result);
  const warnings = [
    ...normalized.warnings,
    `Result exceeded ${MAX_CAPABILITY_CLI_CHARS} characters. Narrow the next observation.`,
  ];
  let lower = 0;
  let upper = Math.min(resultText.length, MAX_CAPABILITY_CLI_CHARS);
  let bounded = { ...normalized, result: { truncated: true, originalChars: resultText.length, preview: '' }, warnings };
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = {
      ...normalized,
      result: {
        truncated: true,
        originalChars: resultText.length,
        preview: resultText.slice(0, middle),
      },
      warnings,
    };
    if (JSON.stringify(candidate).length <= MAX_CAPABILITY_CLI_CHARS) {
      bounded = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return bounded;
}

function boundedOutput(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_CAPABILITY_CLI_CHARS) return value;
  const record = recordValue(value);
  const originalMessage = String(record.message || 'Capability output exceeded the fixed safety boundary');
  const base = {
    ok: false,
    capability: String(record.capability || 'unknown'),
    operation: String(record.operation || 'unknown'),
    code: String(record.code || 'CAPABILITY_OUTPUT_TOO_LARGE'),
    message: '',
    uncertain: record.uncertain === true,
    retryable: false,
    hint: 'Narrow the next observation or inspect a smaller result.',
    truncated: true,
    originalChars: serialized.length,
  };
  let lower = 0;
  let upper = Math.min(originalMessage.length, MAX_CAPABILITY_CLI_CHARS);
  let bounded = base;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = { ...base, message: originalMessage.slice(0, middle) };
    if (JSON.stringify(candidate).length <= MAX_CAPABILITY_CLI_CHARS) {
      bounded = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return bounded;
}

function capabilityEnvelope(
  capability: string,
  operation: string,
  result: unknown,
  warnings: string[] = [],
): CapabilityEnvelope {
  return boundedEnvelope({
    ok: true,
    capability,
    operation,
    result: resultWithoutArtifacts(result),
    artifacts: extractArtifacts(result),
    warnings,
  });
}

function capabilityError(error: unknown, capability: string, operation: string) {
  const value = recordValue(error);
  const message = error instanceof Error ? error.message : String(error || 'Capability command failed');
  const uncertain = value.uncertain === true || /uncertain outcome/i.test(message);
  return {
    ok: false,
    capability,
    operation,
    code: String(value.code || (uncertain ? 'CAPABILITY_ACTION_UNCERTAIN' : 'CAPABILITY_COMMAND_FAILED')),
    message,
    uncertain,
    retryable: value.retryable === true,
    hint: String(value.hint || (uncertain
      ? `Observe the current ${capability} state before deciding whether to retry.`
      : 'Inspect the command help and current capability state, then retry only if safe.')),
  };
}

function writeCapabilityJson(stream: { write(chunk: string): unknown }, value: unknown): void {
  stream.write(`${JSON.stringify(boundedOutput(value))}\n`);
}

export {
  MAX_CAPABILITY_CLI_CHARS,
  capabilityEnvelope,
  capabilityError,
  writeCapabilityJson,
};
