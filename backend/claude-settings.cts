function normalizeClaudeModelValue(model: unknown): string {
  if (typeof model !== 'string') return '';
  const value = model.trim();
  if (!value || value.length > 200) return '';
  if (/[\s\x00-\x1f\x7f]/.test(value)) return '';
  if (value.startsWith('-')) return '';
  return value;
}

export { normalizeClaudeModelValue };
