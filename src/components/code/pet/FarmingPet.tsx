import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import type { UiAppearance, UiLanguage } from '@/lib/ui-preferences'
import {
  resolvePetNotificationIntent,
  type PetIntent,
} from '@/lib/pet/intents'
import { PlayGlyph } from '@/components/IconGlyphs'
import {
  PET_APPEARANCE_PREVIEW_EVENT,
  PET_SETTINGS_EVENT,
  PET_REST_REMINDER_INVITATION_STORAGE_KEY,
  REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
  REST_REMINDER_SNOOZE_MINUTES,
  isPetSettingsStorageKey,
  loadRestReminderIntervalSeconds,
  normalizeRestReminderIntervalSeconds,
  persistRestReminderIntervalSeconds,
  readPetAppearance,
  readRestReminderIntervalSeconds,
  requestPetAppearancePreview,
  restReminderBreakMinutes,
  savePetAppearance,
  restReminderEntryCountdownSeconds,
  restReminderInvitationMs,
  type PetAppearance,
} from '@/lib/pet/rest-reminder'
import { BlackHolePetRestScene } from './BlackHolePetRestScene'
import { GlassPetRestScene } from './GlassPetRestScene'
import { PetBubble } from './PetBubble'
import { usePetDefaultAppearance } from './usePetDefaultAppearance'
import { useRestReminderCapability } from './useRestReminderCapability'

interface FarmingPetProps {
  language: UiLanguage
  appearancePreference: UiAppearance
  restReminderEntryBlocked?: boolean
}

const PET_OWNER_ATTRIBUTE = 'data-farming-pet-owner'
const PET_OWNER_EVENT = 'farming:pet-owner-change'
const PET_APPEARANCE_PREVIEW_SECONDS = 30

interface StoredInvitationRuntime {
  version: 1
  foregroundMs: number
  foregroundStartedAt: number | null
}

function readInvitationRuntime(): StoredInvitationRuntime {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(PET_REST_REMINDER_INVITATION_STORAGE_KEY) ?? 'null',
    ) as Partial<StoredInvitationRuntime> | null
    if (
      parsed?.version === 1
      && typeof parsed.foregroundMs === 'number'
      && Number.isFinite(parsed.foregroundMs)
      && parsed.foregroundMs >= 0
      && (parsed.foregroundStartedAt === null
        || (typeof parsed.foregroundStartedAt === 'number'
          && Number.isFinite(parsed.foregroundStartedAt)))
    ) {
      return {
        version: 1,
        foregroundMs: parsed.foregroundMs,
        foregroundStartedAt: parsed.foregroundStartedAt,
      }
    }
  } catch {
    // Start a fresh invitation timer when session storage is unavailable or invalid.
  }
  return { version: 1, foregroundMs: 0, foregroundStartedAt: null }
}

function useRestReminderInvitationReady(enabled: boolean) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setReady(false)
      return undefined
    }

    const invitationMs = restReminderInvitationMs(
      window.location.search,
      Boolean((window as Window & { __FARMING_E2E__?: boolean }).__FARMING_E2E__),
    )
    let runtime = readInvitationRuntime()
    let timeout: number | null = null
    const persist = () => {
      try {
        window.sessionStorage.setItem(
          PET_REST_REMINDER_INVITATION_STORAGE_KEY,
          JSON.stringify(runtime),
        )
      } catch {
        // The delayed invitation still works for this page lifetime.
      }
    }
    const elapsedAt = (now: number) => runtime.foregroundMs + (
      runtime.foregroundStartedAt === null ? 0 : Math.max(0, now - runtime.foregroundStartedAt)
    )
    const schedule = () => {
      if (timeout !== null) window.clearTimeout(timeout)
      timeout = null
      const now = Date.now()
      const elapsed = elapsedAt(now)
      if (elapsed >= invitationMs) {
        runtime = { version: 1, foregroundMs: invitationMs, foregroundStartedAt: null }
        persist()
        setReady(true)
        return
      }
      if (document.visibilityState === 'hidden') return
      if (runtime.foregroundStartedAt === null) {
        runtime = { ...runtime, foregroundStartedAt: now }
        persist()
      }
      timeout = window.setTimeout(schedule, invitationMs - elapsed)
    }
    const onVisibilityChange = () => {
      const now = Date.now()
      if (document.visibilityState === 'hidden') {
        runtime = {
          version: 1,
          foregroundMs: Math.min(invitationMs, elapsedAt(now)),
          foregroundStartedAt: null,
        }
        persist()
        if (timeout !== null) window.clearTimeout(timeout)
        timeout = null
        return
      }
      schedule()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timeout !== null) window.clearTimeout(timeout)
      if (runtime.foregroundStartedAt !== null) {
        const now = Date.now()
        runtime = {
          version: 1,
          foregroundMs: Math.min(invitationMs, elapsedAt(now)),
          foregroundStartedAt: null,
        }
        persist()
      }
    }
  }, [enabled])

  return ready
}

export function FarmingPet(props: FarmingPetProps) {
  const [ownerId] = useState(() => (
    `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  ))
  const [ownsPet, setOwnsPet] = useState(false)

  useLayoutEffect(() => {
    const syncOwnership = () => {
      setOwnsPet(
        document.documentElement.getAttribute(PET_OWNER_ATTRIBUTE) === ownerId,
      )
    }
    window.addEventListener(PET_OWNER_EVENT, syncOwnership)
    document.documentElement.setAttribute(PET_OWNER_ATTRIBUTE, ownerId)
    syncOwnership()
    window.dispatchEvent(new Event(PET_OWNER_EVENT))
    return () => {
      window.removeEventListener(PET_OWNER_EVENT, syncOwnership)
      if (
        document.documentElement.getAttribute(PET_OWNER_ATTRIBUTE) === ownerId
      ) {
        document.documentElement.removeAttribute(PET_OWNER_ATTRIBUTE)
        window.dispatchEvent(new Event(PET_OWNER_EVENT))
      }
    }
  }, [ownerId])

  return ownsPet ? <FarmingPetController {...props} /> : null
}

function formatActivityInterval(language: UiLanguage, seconds: number) {
  if (seconds < 60) return language === 'zh' ? `${seconds} 秒` : `${seconds} sec`
  const minutes = seconds / 60
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return language === 'zh' ? `${hours} 小时` : `${hours} hr`
  }
  return language === 'zh' ? `${minutes} 分钟` : `${minutes} min`
}

function petCopy(language: UiLanguage) {
  const zh = language === 'zh'
  const defaultInterval = formatActivityInterval(language, REST_REMINDER_DEFAULT_INTERVAL_SECONDS)
  return {
    startupTitle: zh ? '需要长时使用休息提醒吗？' : 'Need a reminder during long Farming sessions?',
    startupBody: zh
      ? `连续操作 Farming ${defaultInterval}后提醒休息。之后可随时在设置的“Farming Pet”中调整或关闭。`
      : `Get a break reminder after ${defaultInterval} of continuous Farming activity. You can adjust or turn it off anytime under “Farming Pet” in Settings.`,
    tryReminder: zh ? '试用一下' : 'Try it',
    disable: zh ? '不使用提醒' : 'Don’t use reminders',
    appearanceTitle: zh ? '选择休息提醒的样式' : 'Choose a reminder style',
    appearanceBody: zh
      ? '它只会在需要提醒休息时出现。之后可在设置的“Farming Pet”中更改。'
      : 'It appears only when it is time for a break. You can change it later under “Farming Pet” in Settings.',
    softGlow: zh ? '柔光' : 'Soft glow',
    softGlowHint: zh ? '温和的磨砂提示' : 'A quiet frosted reminder',
    defaultAppearance: zh ? '默认' : 'Default',
    blackHole: zh ? '黑洞' : 'Black hole',
    blackHoleHint: zh ? '更醒目的动态提示' : 'A more noticeable animated reminder',
    previewAppearance: (appearance: PetAppearance) => {
      const appearanceName = appearance === 'black-hole'
        ? (zh ? '黑洞' : 'black hole')
        : (zh ? '柔光' : 'soft glow')
      return zh ? `预览${appearanceName}效果` : `Preview ${appearanceName}`
    },
    previewTitle: (appearance: PetAppearance) => appearance === 'black-hole'
      ? (zh ? '黑洞预览' : 'Black hole preview')
      : (zh ? '柔光预览' : 'Soft glow preview'),
    previewBody: zh ? '这是休息开始时看到的效果。' : 'This is the scene shown when a break starts.',
    endPreview: zh ? '结束预览' : 'End preview',
    dueTitle: zh ? '休息提醒' : 'Break reminder',
    dueAnnouncement: (intervalSeconds: number) => {
      const countdownSeconds = restReminderEntryCountdownSeconds(intervalSeconds)
      const breakMinutes = restReminderBreakMinutes(intervalSeconds)
      return zh
        ? `休息提醒已出现。暂停操作 ${countdownSeconds} 秒后，开始 ${breakMinutes} 分钟休息。`
        : `Break reminder shown. Pause for ${countdownSeconds} sec to start a ${breakMinutes} min break.`
    },
    dueBody: (intervalSeconds: number, countdownSeconds: number) => {
      const breakMinutes = restReminderBreakMinutes(intervalSeconds)
      return zh
        ? <>已连续操作 Farming {formatActivityInterval(language, intervalSeconds)}。<br />暂停操作 <strong className="code-pet-countdown">{countdownSeconds} 秒</strong>后，开始 {breakMinutes} 分钟休息。</>
        : <>Used Farming continuously for {formatActivityInterval(language, intervalSeconds)}.<br />Pause <strong className="code-pet-countdown">{countdownSeconds} sec</strong> for a {breakMinutes} min break.</>
    },
    cancelBreak: zh ? '取消' : 'Cancel',
    snooze: zh ? `${REST_REMINDER_SNOOZE_MINUTES} 分钟后` : `In ${REST_REMINDER_SNOOZE_MINUTES} min`,
    restingTitle: zh ? '休息一下' : 'Take a break',
    restingBody: zh ? '让眼睛和注意力暂停片刻。' : 'Pause for a moment and rest your eyes and attention.',
    restingStatus: zh ? '休息中' : 'Resting',
    blackHoleError: zh ? '黑洞显示失败' : 'Black hole unavailable',
    restStartedAnnouncement: (intervalSeconds: number) => {
      const breakMinutes = restReminderBreakMinutes(intervalSeconds)
      return zh
        ? `${breakMinutes} 分钟休息已经开始。可随时选择结束休息。`
        : `Your ${breakMinutes}-minute break has started. You can end it at any time.`
    },
    endBreak: zh ? '结束休息' : 'End break',
    settingsSaveFailed: zh ? '无法保存 Pet 设置，请重试。' : 'Could not save Pet settings. Try again.',
    runtimeSaveTitle: zh ? 'Pet 计时无法保存' : 'Pet timer cannot be saved',
    runtimeSaveBody: zh
      ? '本次提醒仍可使用，但刷新页面后计时会重新开始。'
      : 'The reminder still works, but its timer will restart after a page reload.',
    acknowledge: zh ? '知道了' : 'Got it',
    closeStartup: zh ? '关闭' : 'Close',
    closeAppearance: (appearance: PetAppearance) => {
      const appearanceName = appearance === 'black-hole'
        ? (zh ? '黑洞' : 'Black hole')
        : (zh ? '柔光' : 'Soft glow')
      return zh ? `关闭并使用${appearanceName}` : `Close and use ${appearanceName}`
    },
    closeDue: zh ? '取消本次休息' : 'Cancel this break',
  }
}

function FarmingPetController({
  language,
  appearancePreference,
  restReminderEntryBlocked = false,
}: FarmingPetProps) {
  const copy = useMemo(() => petCopy(language), [language])
  const defaultAppearance = usePetDefaultAppearance(appearancePreference)
  const [intervalSeconds, setIntervalSeconds] = useState<number | null>(
    readRestReminderIntervalSeconds,
  )
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [appearance, setAppearance] = useState<PetAppearance>(() => (
    readPetAppearance(undefined, defaultAppearance)
  ))
  const [appearancePreview, setAppearancePreview] = useState<{
    appearance: PetAppearance
    restUntil: number
  } | null>(null)
  const [startupInvitationDismissed, setStartupInvitationDismissed] = useState(false)
  const [restReminderSetupOption, setRestReminderSetupOption] = useState<'appearance' | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [persistenceNoticeDismissed, setPersistenceNoticeDismissed] = useState(false)
  const [countdownNow, setCountdownNow] = useState(Date.now)
  const invitationReady = useRestReminderInvitationReady(
    settingsLoaded && intervalSeconds === null,
  )
  const {
    state: restReminder,
    pageVisible,
    persistenceFailed,
    dismiss: dismissRestReminder,
    snooze: snoozeRestReminder,
  } = useRestReminderCapability(intervalSeconds, restReminderEntryBlocked)

  useEffect(() => {
    let cancelled = false
    loadRestReminderIntervalSeconds(defaultAppearance).then(nextInterval => {
      if (cancelled) return
      setIntervalSeconds(nextInterval)
      setSettingsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [defaultAppearance])

  useEffect(() => {
    const syncSetting = (
      intervalValue: unknown,
      appearanceValue?: PetAppearance,
      clearSaveError = false,
    ) => {
      const nextInterval = normalizeRestReminderIntervalSeconds(intervalValue)
      setIntervalSeconds(nextInterval)
      setSettingsLoaded(true)
      setAppearance(appearanceValue ?? readPetAppearance(undefined, defaultAppearance))
      setRestReminderSetupOption(null)
      if (clearSaveError) setSettingsError('')
    }
    const onSetting = (event: Event) => {
      const detail = (event as CustomEvent<{
        intervalSeconds?: number
        appearance?: PetAppearance
      }>).detail
      syncSetting(detail?.intervalSeconds, detail?.appearance, true)
    }
    const onStorage = (event: StorageEvent) => {
      if (isPetSettingsStorageKey(event.key)) {
        syncSetting(
          readRestReminderIntervalSeconds(),
          readPetAppearance(undefined, defaultAppearance),
        )
      }
    }
    window.addEventListener(PET_SETTINGS_EVENT, onSetting)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PET_SETTINGS_EVENT, onSetting)
      window.removeEventListener('storage', onStorage)
    }
  }, [defaultAppearance])

  useEffect(() => {
    setAppearance(readPetAppearance(undefined, defaultAppearance))
  }, [defaultAppearance])

  useEffect(() => {
    const onPreview = (event: Event) => {
      const nextAppearance = (event as CustomEvent<{ appearance?: unknown }>).detail?.appearance
      if (nextAppearance !== 'glass' && nextAppearance !== 'black-hole') return
      setAppearancePreview({
        appearance: nextAppearance,
        restUntil: Date.now() + PET_APPEARANCE_PREVIEW_SECONDS * 1000,
      })
    }
    window.addEventListener(PET_APPEARANCE_PREVIEW_EVENT, onPreview)
    return () => window.removeEventListener(PET_APPEARANCE_PREVIEW_EVENT, onPreview)
  }, [])

  useEffect(() => {
    if (!pageVisible || restReminder?.phase !== 'due') return undefined
    setCountdownNow(Date.now())
    const interval = window.setInterval(() => setCountdownNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [pageVisible, restReminder?.phase, restReminder?.restStartsAt])

  useEffect(() => {
    if (!appearancePreview) return undefined
    const timeout = window.setTimeout(
      () => setAppearancePreview(null),
      Math.max(0, appearancePreview.restUntil - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [appearancePreview])

  const tryRestReminder = useCallback(async () => {
    if (await persistRestReminderIntervalSeconds(
      REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
      defaultAppearance,
    )) {
      setSettingsError('')
      setRestReminderSetupOption('appearance')
    } else {
      setSettingsError(copy.settingsSaveFailed)
    }
  }, [copy.settingsSaveFailed, defaultAppearance])
  const disableRestReminder = useCallback(async () => {
    if (await persistRestReminderIntervalSeconds(0, defaultAppearance)) {
      setSettingsError('')
    } else {
      setSettingsError(copy.settingsSaveFailed)
    }
  }, [copy.settingsSaveFailed, defaultAppearance])
  const chooseAppearance = useCallback((nextAppearance: PetAppearance) => {
    if (!savePetAppearance(nextAppearance)) {
      setSettingsError(copy.settingsSaveFailed)
      return
    }
    setSettingsError('')
    setAppearance(nextAppearance)
    setRestReminderSetupOption(null)
  }, [copy.settingsSaveFailed])

  const intent = useMemo<PetIntent | null>(() => {
    if (!settingsLoaded) return null
    if (restReminderEntryBlocked && restReminder?.phase !== 'resting') return null
    const notificationIntent = resolvePetNotificationIntent(
      intervalSeconds,
      restReminderSetupOption,
    )
    if (
      !invitationReady
      && notificationIntent?.option === 'invitation'
    ) return null
    if (
      startupInvitationDismissed
      && notificationIntent?.option === 'invitation'
    ) return null
    if (notificationIntent) return notificationIntent
    if (restReminder?.phase === 'due' && restReminder.restStartsAt !== null) {
      return {
        kind: 'capability',
        capability: 'rest-reminder',
        phase: 'due',
        restStartsAt: restReminder.restStartsAt,
      }
    }
    if (restReminder?.phase === 'resting' && restReminder.restUntil !== null) {
      return {
        kind: 'capability',
        capability: 'rest-reminder',
        phase: 'resting',
        restUntil: restReminder.restUntil,
      }
    }
    return null
  }, [
    intervalSeconds,
    invitationReady,
    restReminder,
    restReminderEntryBlocked,
    restReminderSetupOption,
    settingsLoaded,
    startupInvitationDismissed,
  ])

  if (appearancePreview) {
    const endPreview = () => setAppearancePreview(null)
    if (appearancePreview.appearance === 'black-hole') {
      return (
        <BlackHolePetRestScene
          statusLabel={copy.previewTitle('black-hole')}
          errorLabel={copy.blackHoleError}
          endLabel={copy.endPreview}
          restUntil={appearancePreview.restUntil}
          active={pageVisible}
          onEnd={endPreview}
        />
      )
    }
    return (
      <GlassPetRestScene
        title={copy.previewTitle('glass')}
        body={copy.previewBody}
        endLabel={copy.endPreview}
        restUntil={appearancePreview.restUntil}
        active={pageVisible}
        onEnd={endPreview}
      />
    )
  }

  if (!intent) {
    if (!persistenceFailed || persistenceNoticeDismissed) return null
    return (
      <PetBubble
        title={copy.runtimeSaveTitle}
        body={copy.runtimeSaveBody}
        closeLabel={copy.acknowledge}
        testId="pet-runtime-save-warning"
        onClose={() => setPersistenceNoticeDismissed(true)}
        actions={[
          { label: copy.acknowledge, onClick: () => setPersistenceNoticeDismissed(true) },
        ]}
      />
    )
  }

  if (
    intent.kind === 'capability'
    && intent.capability === 'rest-reminder'
    && intent.phase === 'resting'
  ) {
    if (appearance === 'black-hole') {
      return (
        <>
          <span className="code-visually-hidden" role="status" aria-live="polite">
            {copy.restStartedAnnouncement(
              restReminder?.intervalSeconds ?? REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
            )}
          </span>
          <BlackHolePetRestScene
            statusLabel={copy.restingStatus}
            errorLabel={copy.blackHoleError}
            endLabel={copy.endBreak}
            restUntil={intent.restUntil}
            active={pageVisible}
            onEnd={dismissRestReminder}
          />
        </>
      )
    }
    return (
      <GlassPetRestScene
        title={copy.restingTitle}
        body={copy.restingBody}
        endLabel={copy.endBreak}
        restUntil={intent.restUntil}
        active={pageVisible}
        onEnd={dismissRestReminder}
      />
    )
  }

  if (
    intent.kind === 'capability'
    && intent.capability === 'rest-reminder'
    && intent.phase === 'due'
  ) {
    const countdownSeconds = Math.max(
      0,
      Math.ceil((intent.restStartsAt - countdownNow) / 1000),
    )
    return (
      <PetBubble
        title={copy.dueTitle}
        body={copy.dueBody(
          restReminder?.intervalSeconds ?? REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
          countdownSeconds,
        )}
        closeLabel={copy.closeDue}
        testId="pet-rest-reminder"
        announcement={copy.dueAnnouncement(
          restReminder?.intervalSeconds ?? REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
        )}
        error={settingsError || undefined}
        onClose={dismissRestReminder}
        actions={[
          { label: copy.cancelBreak, onClick: dismissRestReminder },
          ...(!restReminder?.snoozeUsed
            ? [{ label: copy.snooze, onClick: snoozeRestReminder }]
            : []),
        ]}
      />
    )
  }

  if (
    intent.kind === 'notification'
    && intent.notification === 'rest-reminder-setup'
    && intent.option === 'appearance'
  ) {
    return (
      <PetBubble
        title={copy.appearanceTitle}
        body={copy.appearanceBody}
        closeLabel={copy.closeAppearance(appearance)}
        testId="pet-appearance-choice"
        error={settingsError || undefined}
        onClose={() => chooseAppearance(appearance)}
        actions={[]}
      >
        <div className="code-pet-appearance-options" role="group" aria-label={copy.appearanceTitle}>
          {(['glass', 'black-hole'] as const).map(option => (
            <div className="code-pet-appearance-option" key={option}>
              <button
                type="button"
                className={`code-pet-appearance-select${appearance === option ? ' selected' : ''}`}
                aria-pressed={appearance === option}
                onClick={() => chooseAppearance(option)}
              >
                <span className={`code-pet-appearance-icon ${option}`} aria-hidden="true" />
                <span>
                  <strong>{option === 'glass' ? copy.softGlow : copy.blackHole}</strong>
                  <small>{option === 'glass' ? copy.softGlowHint : copy.blackHoleHint}</small>
                </span>
                {defaultAppearance === option && <em>{copy.defaultAppearance}</em>}
              </button>
              <button
                type="button"
                className="code-pet-appearance-preview"
                aria-label={copy.previewAppearance(option)}
                title={copy.previewAppearance(option)}
                onClick={() => requestPetAppearancePreview(option)}
              >
                <PlayGlyph />
              </button>
            </div>
          ))}
        </div>
      </PetBubble>
    )
  }

  return (
    <PetBubble
      title={copy.startupTitle}
      body={copy.startupBody}
      closeLabel={copy.closeStartup}
      testId="pet-rest-invitation"
      error={settingsError || undefined}
      onClose={() => setStartupInvitationDismissed(true)}
      actions={[
        { label: copy.tryReminder, primary: true, onClick: tryRestReminder },
        { label: copy.disable, onClick: disableRestReminder },
      ]}
    />
  )
}
