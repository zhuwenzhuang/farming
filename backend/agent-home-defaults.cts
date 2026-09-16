import type { AcpConfigChange, AcpConfigOption } from './agent-manager-provider-types.js';

export interface AgentHomeDefaults {
  model: string;
  reasoning: string;
  fast: 'inherit' | 'on' | 'off';
}

function optionKind(option: AcpConfigOption): keyof AgentHomeDefaults | null {
  const identity = `${option.id} ${option.category || ''}`;
  if (/(^|[\s_-])model([\s_-]|$)/i.test(identity)) return 'model';
  if (/(reasoning|thought|effort)/i.test(identity)) return 'reasoning';
  if (/(fast|speed|service[_-]?tier)/i.test(identity)) return 'fast';
  return null;
}

/** Only explicit user choices become defaults; ordinary session snapshots do not. */
export function acpHomeDefaultsPatch(
  result: unknown,
  changes: AcpConfigChange[],
): Partial<AgentHomeDefaults> {
  if (!result || typeof result !== 'object') return {};
  const response = result as { configOptions?: AcpConfigOption[]; deferred?: boolean };
  if (!Array.isArray(response.configOptions)) return {};
  const changed = new Map(changes.map(change => [change.configId, change.value]));
  const patch: Partial<AgentHomeDefaults> = {};
  const changesModel = response.configOptions.some(option => changed.has(option.id) && optionKind(option) === 'model');
  for (const option of response.configOptions) {
    const kind = optionKind(option);
    // A model switch may normalize its effort; remember that confirmed pair.
    if (!kind || (!changed.has(option.id) && !(changesModel && kind === 'reasoning' && !response.deferred))) continue;
    const value = response.deferred ? changed.get(option.id) : option.currentValue;
    if (kind === 'fast') {
      if (value === true || value === 'priority' || value === 'fast' || value === 'on') patch.fast = 'on';
      if (value === false || value === 'default' || value === 'standard' || value === 'off') patch.fast = 'off';
    } else if (typeof value === 'string' && value.trim()) {
      patch[kind] = value;
    }
  }
  return patch;
}
