interface AcpUsageUpdate {
  used?: number
  size?: number
  cost?: {
    amount?: number
    currency?: string
  } | null
}

export interface AcpContextUsage {
  usedTokens: number
  limitTokens: number
  percentUsed: number
  percentLeft: number
  costLabel: string
}

export function acpContextUsage(usage?: AcpUsageUpdate | null): AcpContextUsage | null {
  const usedTokens = Number(usage?.used)
  const limitTokens = Number(usage?.size)
  if (!Number.isFinite(usedTokens) || usedTokens < 0 || !Number.isFinite(limitTokens) || limitTokens <= 0) {
    return null
  }

  const percentUsed = Math.max(0, Math.min(100, Math.round((usedTokens / limitTokens) * 100)))
  const amount = Number(usage?.cost?.amount)
  const currency = String(usage?.cost?.currency || '').trim().toUpperCase()
  const costLabel = Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency)
    ? `${amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${currency}`
    : ''

  return {
    usedTokens,
    limitTokens,
    percentUsed,
    percentLeft: 100 - percentUsed,
    costLabel,
  }
}
