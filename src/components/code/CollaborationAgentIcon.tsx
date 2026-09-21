import { AgentBotGlyph, AgentSpeechBotGlyph, AgentChipGlyph, AgentSmartToyGlyph, AgentDroneGlyph, AgentManufacturingGlyph } from '../IconGlyphs'
import { agentIcon, eventTone } from './acp/acp-collaboration'

export function CollaborationAgentIcon({ sessionId }: { sessionId: string }) {
  const Glyph = [AgentBotGlyph, AgentSpeechBotGlyph, AgentChipGlyph, AgentSmartToyGlyph, AgentDroneGlyph, AgentManufacturingGlyph][agentIcon(sessionId)] || AgentBotGlyph
  return <span className="code-collaboration-agent-icon" aria-hidden="true"
    style={{ color: `var(--code-collaboration-tone-${eventTone(sessionId) + 1})` }}><Glyph /></span>
}
