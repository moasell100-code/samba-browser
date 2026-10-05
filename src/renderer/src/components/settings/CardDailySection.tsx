import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { CARD_DAILY_ISSUERS, type CardDailyStatus } from '@shared/card-daily'
import { Switch } from '@renderer/components/ui/switch'
import { SettingsRow, SettingsSection, SettingsToggleRow, type SectionProps } from './shared'

const ISSUER_NAMES = {
  hyundai_card: '현대카드',
  samsung_card: '삼성카드',
  lotte_card: '롯데카드'
}

function timeKst(value: string, language: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}

export function CardDailySection({ settings, update }: SectionProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<CardDailyStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.samba.cardDaily.onChanged((next) => {
      if (!active) return
      receivedEvent = true
      setStatus(next)
      setUnavailable(false)
    })
    void window.samba.cardDaily
      .status()
      .then((result) => {
        if (!active || receivedEvent) return
        if (result.ok) setStatus(result.data)
        else setUnavailable(true)
      })
      .catch(() => {
        if (active && !receivedEvent) setUnavailable(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return (
    <>
      <SettingsSection title={t('cardDaily.title')} description={t('cardDaily.description')}>
        <SettingsToggleRow label={t('cardDaily.enable')} description={t('cardDaily.deviceOnly')}>
          <Switch
            aria-label={t('cardDaily.enable')}
            checked={settings.financeDailyEnabled}
            onCheckedChange={(enabled) => update({ financeDailyEnabled: enabled })}
          />
        </SettingsToggleRow>
        <SettingsRow label={t('cardDaily.hour')}>
          <select
            aria-label={t('cardDaily.hour')}
            className="h-9 rounded-lg border border-[var(--line)] bg-white px-3 text-[12px] text-[var(--text)]"
            value={settings.financeDailyHourKst}
            onChange={(event) => update({ financeDailyHourKst: Number(event.target.value) })}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={hour}>
                {String(hour).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </SettingsRow>
        <p className="text-[11px] leading-relaxed text-[var(--text2)]">
          {t('cardDaily.requirements')}
        </p>
      </SettingsSection>
      <SettingsSection title={t('cardDaily.statusTitle')}>
        <div aria-live="polite" className="space-y-3 text-[12px] text-[var(--text)]">
          {unavailable && <p role="alert">{t('cardDaily.unavailable')}</p>}
          {!status && !unavailable && <p>{t('cardDaily.loading')}</p>}
          {status && (
            <>
              <div className="flex items-center justify-between gap-3">
                <strong>{t(`cardDaily.phases.${status.phase}`)}</strong>
                {status.runDate && <span className="text-[var(--text2)]">{status.runDate}</span>}
              </div>
              {status.reason && <p>{t(`cardDaily.reasons.${status.reason}`)}</p>}
              {status.nextRunAt && (
                <p className="text-[var(--text2)]">
                  {t('cardDaily.nextRun', { time: timeKst(status.nextRunAt, i18n.language) })}
                </p>
              )}
              {status.finishedAt && (
                <p className="text-[var(--text2)]">
                  {t('cardDaily.finished', { time: timeKst(status.finishedAt, i18n.language) })}
                </p>
              )}
              {status.gapDays > 0 && (
                <p className="rounded-lg bg-amber-50 p-3 text-amber-900" role="alert">
                  {t('cardDaily.gap', { count: status.gapDays })}
                </p>
              )}
              <ul className="space-y-2">
                {CARD_DAILY_ISSUERS.map((issuer) => {
                  const result = status.results.find((row) => row.issuer === issuer)
                  return (
                    <li key={issuer} className="rounded-lg border border-[var(--line)] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <strong>{ISSUER_NAMES[issuer]}</strong>
                        <span>
                          {result?.state === 'saved' && !result.complete
                            ? t(
                                result.approvalComplete
                                  ? 'cardDaily.approvalsSaved'
                                  : 'cardDaily.partialSaved'
                              )
                            : t(`cardDaily.states.${result?.state ?? 'pending'}`)}
                        </span>
                      </div>
                      {result?.reason && (
                        <p className="mt-1 text-[var(--text2)]">
                          {t(`cardDaily.reasons.${result.reason}`)}
                        </p>
                      )}
                      {result?.state === 'saved' && (
                        <>
                          <p className="mt-1 text-[var(--text2)]">
                            {t('cardDaily.counts', {
                              total: result.totalRows ?? 0,
                              inserted: result.insertedRows ?? 0,
                              updated: result.updatedRows ?? 0,
                              review: result.reviewRows ?? 0
                            })}
                          </p>
                          {!result.complete && (
                            <p className="mt-1 text-amber-800">
                              {t(
                                result.approvalComplete
                                  ? 'cardDaily.partial'
                                  : 'cardDaily.approvalsIncomplete'
                              )}
                            </p>
                          )}
                        </>
                      )}
                      {result?.reconciliation && (
                        <p className="mt-1 text-[var(--text2)]">
                          {t(`cardDaily.reconciliation.${result.reconciliation.state}`, {
                            count: result.reconciliation.checkedDays
                          })}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </SettingsSection>
    </>
  )
}
