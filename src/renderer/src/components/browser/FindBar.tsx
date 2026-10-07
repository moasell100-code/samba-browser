import { useEffect, useRef } from 'react'
import type React from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PAGE_FIND_MAX_QUERY } from '@shared/page-find'
import { usePageFindStore } from '@renderer/stores/pageFindStore'

/** A layout row keeps the native page visible BELOW the finder, without overlay capture. */
export function FindBar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const find = usePageFindStore()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (find.open) {
      input.current?.focus()
      input.current?.select()
    }
  }, [find.open, find.focusVersion])
  if (!find.open) return null
  return (
    <div
      role="search"
      aria-label={t('pageFind.label')}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') {
          event.preventDefault()
          void find.close()
        }
      }}
      className="flex shrink-0 items-center justify-end gap-2 border-b border-[var(--line)] bg-[var(--bg)] px-3 py-2"
    >
      <input
        ref={input}
        aria-label={t('pageFind.label')}
        placeholder={t('pageFind.label')}
        maxLength={PAGE_FIND_MAX_QUERY}
        value={find.query}
        onChange={(event) => void find.setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter/Escape must first finish a Korean IME composition.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void find.next(!event.shiftKey)
          }
        }}
        className="h-8 w-60 rounded-lg border border-[var(--line)] bg-white px-3 text-[12.5px] outline-none focus:border-[var(--text2)]"
      />
      <span
        aria-label={t('pageFind.result')}
        aria-live="polite"
        className="min-w-20 text-center text-xs text-[var(--text2)]"
      >
        {find.error
          ? t('pageFind.error')
          : find.query
            ? `${find.activeMatchOrdinal} / ${find.matches}`
            : ''}
      </span>
      <button
        type="button"
        title={t('pageFind.previous')}
        aria-label={t('pageFind.previous')}
        disabled={!find.query}
        onClick={() => void find.next(false)}
        className="rounded-lg p-1.5 hover:bg-black/5 disabled:opacity-40"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        title={t('pageFind.next')}
        aria-label={t('pageFind.next')}
        disabled={!find.query}
        onClick={() => void find.next(true)}
        className="rounded-lg p-1.5 hover:bg-black/5 disabled:opacity-40"
      >
        <ArrowDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        title={t('pageFind.close')}
        aria-label={t('pageFind.close')}
        onClick={() => void find.close()}
        className="rounded-lg p-1.5 hover:bg-black/5"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
