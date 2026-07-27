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
import {
  PET_SETTINGS_EVENT,
  REST_REMINDER_BREAK_MINUTES,
  REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
  REST_REMINDER_SNOOZE_MINUTES,
  isPetSettingsStorageKey,
  normalizeRestReminderIntervalSeconds,
  readPetAppearance,
  readRestReminderIntervalSeconds,
  savePetAppearance,
  saveRestReminderIntervalSeconds,
  restReminderEntryCountdownSeconds,
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
    disable: zh ? '关闭' : 'Turn off',
    appearanceTitle: zh ? '选择休息提醒的样式' : 'Choose a reminder style',
    appearanceBody: zh
      ? '它只会在需要提醒休息时出现。之后可在设置的“Farming Pet”中更改。'
      : 'It appears only when it is time for a break. You can change it later under “Farming Pet” in Settings.',
    softGlow: zh ? '柔光' : 'Soft glow',
    softGlowHint: zh ? '温和的磨砂提示' : 'A quiet frosted reminder',
    defaultAppearance: zh ? '默认' : 'Default',
    blackHole: zh ? '黑洞' : 'Black hole',
    blackHoleHint: zh ? '更醒目的动态提示' : 'A more noticeable animated reminder',
    dueTitle: zh ? '休息提醒' : 'Break reminder',
    dueAnnouncement: (intervalSeconds: number) => {
      const countdownSeconds = restReminderEntryCountdownSeconds(intervalSeconds)
      return zh
        ? `休息提醒已出现。暂停操作 ${countdownSeconds} 秒后，开始 ${REST_REMINDER_BREAK_MINUTES} 分钟休息。`
        : `Break reminder shown. Pause for ${countdownSeconds} sec to start a ${REST_REMINDER_BREAK_MINUTES} min break.`
    },
    dueBody: (intervalSeconds: number, countdownSeconds: number) => zh
      ? <>已专注 {formatActivityInterval(language, intervalSeconds)}。<br />暂停操作 <strong className="code-pet-countdown">{countdownSeconds} 秒</strong>后，开始 {REST_REMINDER_BREAK_MINUTES} 分钟休息。</>
      : <>Focused for {formatActivityInterval(language, intervalSeconds)}.<br />Pause <strong className="code-pet-countdown">{countdownSeconds} sec</strong> for a {REST_REMINDER_BREAK_MINUTES} min break.</>,
    cancelBreak: zh ? '取消' : 'Cancel',
    snooze: zh ? `${REST_REMINDER_SNOOZE_MINUTES} 分钟后` : `In ${REST_REMINDER_SNOOZE_MINUTES} min`,
    restingTitle: zh ? '休息一下' : 'Take a break',
    restingBody: zh ? '让眼睛和注意力暂停片刻。' : 'Pause for a moment and rest your eyes and attention.',
    restingStatus: zh ? '休息中' : 'Resting',
    blackHoleError: zh ? '黑洞显示失败' : 'Black hole unavailable',
    restStartedAnnouncement: zh
      ? `${REST_REMINDER_BREAK_MINUTES} 分钟休息已经开始。可随时选择结束休息。`
      : `Your ${REST_REMINDER_BREAK_MINUTES}-minute break has started. You can end it at any time.`,
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
  const [intervalSeconds, setIntervalSeconds] = useState<number | null>(readRestReminderIntervalSeconds)
  const [appearance, setAppearance] = useState<PetAppearance>(() => (
    readPetAppearance(undefined, defaultAppearance)
  ))
  const [restReminderSetupOption, setRestReminderSetupOption] = useState<'appearance' | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [persistenceNoticeDismissed, setPersistenceNoticeDismissed] = useState(false)
  const [countdownNow, setCountdownNow] = useState(Date.now)
  const {
    state: restReminder,
    pageVisible,
    persistenceFailed,
    dismiss: dismissRestReminder,
    snooze: snoozeRestReminder,
  } = useRestReminderCapability(intervalSeconds, restReminderEntryBlocked)

  useEffect(() => {
    const syncSetting = (
      intervalValue: unknown,
      appearanceValue?: PetAppearance,
      clearSaveError = false,
    ) => {
      const nextInterval = normalizeRestReminderIntervalSeconds(intervalValue)
      setIntervalSeconds(nextInterval)
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
    if (!pageVisible || restReminder?.phase !== 'due') return undefined
    setCountdownNow(Date.now())
    const interval = window.setInterval(() => setCountdownNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [pageVisible, restReminder?.phase, restReminder?.restStartsAt])

  const tryRestReminder = useCallback(() => {
    if (saveRestReminderIntervalSeconds(
      REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
      undefined,
      defaultAppearance,
    )) {
      setSettingsError('')
      setRestReminderSetupOption('appearance')
    } else {
      setSettingsError(copy.settingsSaveFailed)
    }
  }, [copy.settingsSaveFailed, defaultAppearance])
  const disableRestReminder = useCallback(() => {
    if (saveRestReminderIntervalSeconds(0, undefined, defaultAppearance)) {
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
    if (restReminderEntryBlocked && restReminder?.phase !== 'resting') return null
    const notificationIntent = resolvePetNotificationIntent(
      intervalSeconds,
      restReminderSetupOption,
    )
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
    restReminder,
    restReminderEntryBlocked,
    restReminderSetupOption,
  ])

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
            {copy.restStartedAnnouncement}
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
          <button
            type="button"
            className={appearance === 'glass' ? 'selected' : undefined}
            aria-pressed={appearance === 'glass'}
            onClick={() => chooseAppearance('glass')}
          >
            <span className="code-pet-appearance-icon glass" aria-hidden="true" />
            <span>
              <strong>{copy.softGlow}</strong>
              <small>{copy.softGlowHint}</small>
            </span>
            {defaultAppearance === 'glass' && <em>{copy.defaultAppearance}</em>}
          </button>
          <button
            type="button"
            className={appearance === 'black-hole' ? 'selected' : undefined}
            aria-pressed={appearance === 'black-hole'}
            onClick={() => chooseAppearance('black-hole')}
          >
            <span className="code-pet-appearance-icon black-hole" aria-hidden="true" />
            <span>
              <strong>{copy.blackHole}</strong>
              <small>{copy.blackHoleHint}</small>
            </span>
            {defaultAppearance === 'black-hole' && <em>{copy.defaultAppearance}</em>}
          </button>
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
      onClose={disableRestReminder}
      actions={[
        { label: copy.tryReminder, primary: true, onClick: tryRestReminder },
        { label: copy.disable, onClick: disableRestReminder },
      ]}
    />
  )
}
