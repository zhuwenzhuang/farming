import { useEffect, useState } from 'react'
import { appPath } from '@/lib/base-path'

interface SkillCatalogEntry {
  id: string
  name: string
  trigger: string
  summary: string
  commands: string[]
}

interface SkillsDialogProps {
  open: boolean
  onClose: () => void
}

export function SkillsDialog({ open, onClose }: SkillsDialogProps) {
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    fetch(appPath('/api/skills'))
      .then(r => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<{ skills?: SkillCatalogEntry[] }>
      })
      .then(data => setSkills(Array.isArray(data.skills) ? data.skills : []))
      .catch(() => setError('failed to load'))

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-overlay" data-testid="skills-overlay">
      <div className="history-dialog fx-crt-panel skills-dialog" data-testid="skills-dialog">
        <div className="dialog-header fx-crt-panel-compact">
          <div className="dialog-header-copy">
            <div className="dialog-header-title">Skills</div>
          </div>
          <button type="button" className="close-btn" onClick={onClose}>Close [Esc]</button>
        </div>

        {error ? (
          <div className="history-empty">{error}</div>
        ) : skills.length === 0 ? (
          <div className="history-empty">Loading…</div>
        ) : (
          <div className="skills-list">
            {skills.map(skill => (
              <div key={skill.id} className="skill-card fx-crt-panel fx-crt-panel-compact">
                <div className="skill-title">{skill.name}</div>
                <div className="skill-id">{skill.id}</div>
                <div className="skill-block">{skill.trigger}</div>
                <div className="skill-block">{skill.summary}</div>
                <ul className="skill-commands">
                  {skill.commands.map(cmd => (
                    <li key={cmd}>{cmd}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
