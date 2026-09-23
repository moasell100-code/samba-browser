import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  CircleCheck,
  ExternalLink,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  UsersRound
} from 'lucide-react'
import type { IpcResult } from '@shared/ipc'
import type { JajaAccountView, JajaIdentityState, JajaStatus } from '@shared/jaja'
import { PrimaryButton, SecondaryButton } from '@renderer/components/settings/shared'
import { useUiStore } from '@renderer/stores/uiStore'
import { cn } from '@renderer/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@renderer/components/ui/dialog'

const SITE_NAMES: Record<string, string> = {
  MUSINSA: '무신사',
  '29CM': '29CM',
  LOTTEON: '롯데ON',
  SSG: 'SSG',
  ABCMART: 'ABC마트',
  GRANDSTAGE: '그랜드스테이지',
  NAVERSTORE: '네이버',
  REXMONDE: '렉스몬드'
}
const IDENTITY: Record<JajaIdentityState, { label: string; color: string }> = {
  unchecked: { label: '로그인 확인 전', color: 'bg-slate-100 text-slate-600' },
  verified: { label: '로그인 계정 확인됨', color: 'bg-emerald-50 text-emerald-700' },
  unknown: { label: '로그인 확인 필요', color: 'bg-amber-50 text-amber-800' },
  mismatch: { label: '다른 계정으로 로그인됨', color: 'bg-red-50 text-red-700' },
  expired: { label: '재로그인 필요', color: 'bg-amber-50 text-amber-800' }
}
const REASONS: Record<string, string> = {
  page_only: '이 소싱처는 브라우저에서 직접 확인하는 방식입니다. 쿠키 동기화는 지원하지 않습니다.',
  unsupported_site: '이 소싱처의 쿠키 동기화는 아직 지원하지 않습니다.',
  no_cookie: '로그인 정보가 없습니다. 로그인 공간을 열어 해당 계정으로 로그인하세요.',
  session_cookie_missing_or_capture_stale:
    '최신 로그인 정보가 필요합니다. 로그인 공간에서 페이지를 새로고침하세요.',
  ssg_auth_pair_missing: 'SSG 로그인 정보가 완전하지 않습니다. 로그인 공간에서 다시 확인하세요.',
  identity_mismatch:
    '등록 계정과 실제 로그인 계정이 다릅니다. 로그인 공간에서 올바른 계정을 확인하세요.',
  login_expired: '로그인이 만료되었습니다. 로그인 공간에서 다시 로그인하세요.',
  session_expired: '로그인이 만료되었습니다. 로그인 공간에서 다시 로그인하세요.',
  cookie_missing: '로그인 정보가 없습니다. 로그인 공간에서 로그인하세요.',
  registered_order_identity_missing:
    '최근 주문에서 등록 계정과 일치하는 주문을 확인하지 못했습니다. 기존 공급 방식은 유지됩니다.',
  owner_lookup_failed: '로그인 정보가 어느 계정에 속하는지 확인하지 못했습니다.',
  session_invalid: '로그인이 유효하지 않습니다. 로그인 공간에서 다시 확인하세요.',
  manual_login_required: '이 버전에서는 로그인과 재인증을 로그인 공간에서 직접 진행합니다.',
  identity_baseline_missing:
    '등록 계정을 확인할 기준 정보가 없습니다. 기존 방식으로 계정을 확인한 뒤 다시 시도하세요.',
  positive_identity_adapter_pending: '이 소싱처의 계정 확인 방식은 아직 지원하지 않습니다.',
  account_identity_mismatch:
    '등록 계정과 실제 로그인 계정이 다릅니다. 로그인 공간에서 올바른 계정으로 로그인하세요.',
  identity_probe_unavailable: '로그인 계정을 확인하지 못했습니다. 잠시 후 상태를 다시 확인하세요.',
  registered_identity_and_live_session: '등록 계정과 현재 로그인 상태를 확인했습니다.',
  synced: '확인된 로그인 정보를 자자에 동기화했습니다.',
  observed: '비교 확인을 완료했습니다. 기존 쿠키 공급은 유지됩니다.',
  connection_failed: '자자 서버에 연결하지 못했습니다. 연결 상태를 확인하세요.',
  state_changed: '공급 상태가 변경되었습니다. 새로고침한 뒤 다시 확인하세요.',
  payment_in_progress: '결제 진행 중에는 계정 작업을 잠시 기다려 주세요.',
  cookies_changed: '로그인 정보가 변경되었습니다. 상태를 다시 확인하세요.',
  login_required: '로그인 공간을 열어 해당 계정으로 로그인하세요.'
}
type Confirmation = { kind: 'activate' | 'release'; accountId: string } | { kind: 'disconnect' }

function siteName(site: string): string {
  return SITE_NAMES[site.toUpperCase()] ?? site
}
function when(value: string | null | undefined): string {
  if (!value) return '아직 없음'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '확인 필요'
    : date.toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}
function reason(code: string | undefined, fallback: string): string {
  return (code && REASONS[code]) || fallback
}
function identityState(account: JajaAccountView): JajaIdentityState {
  return account.browserIdentityState ?? account.session?.identityState ?? 'unchecked'
}

export function JajaAccountsPage(): React.JSX.Element {
  const [status, setStatus] = useState<JajaStatus | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [site, setSite] = useState('all')
  const [customOrigin, setCustomOrigin] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const setView = useUiStore((s) => s.setView)

  useEffect(() => {
    let alive = true
    let changed = false
    const unsubscribe = window.samba.jaja.onChanged((next) => {
      changed = true
      if (alive) setStatus(next)
    })
    void window.samba.jaja
      .status()
      .then((result) => {
        if (!alive || changed) return
        if (result.ok) setStatus(result.data)
        else setNotice('연결 상태를 불러오지 못했습니다. 잠시 후 다시 시도하세요.')
      })
      .catch(() => {
        if (alive) setNotice('연결 상태를 불러오지 못했습니다. 잠시 후 다시 시도하세요.')
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const run = async (
    key: string,
    action: () => Promise<IpcResult<JajaStatus | void>>,
    errorMessage: string,
    openBrowser = false
  ): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(key)
    setNotice(null)
    try {
      const result = await action()
      if (!result.ok) {
        setNotice(errorMessage)
        return
      }
      if (result.data) setStatus(result.data)
      else {
        const current = await window.samba.jaja.status()
        if (current.ok) setStatus(current.data)
      }
      if (openBrowser) setView('browser')
      setConfirmation(null)
    } catch {
      setNotice(errorMessage)
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }

  const accounts = status?.accounts ?? []
  const sites = [...new Set(accounts.map((account) => account.site))].sort()
  const search = query.trim().toLocaleLowerCase()
  const shown = accounts.filter(
    (account) =>
      (site === 'all' || account.site === site) &&
      `${account.label} ${account.usernameHint} ${account.site} ${siteName(account.site)}`
        .toLocaleLowerCase()
        .includes(search)
  )
  const confirmedAccount =
    confirmation && confirmation.kind !== 'disconnect'
      ? accounts.find((account) => account.accountId === confirmation.accountId)
      : undefined
  const canActivate = (account: JajaAccountView): boolean =>
    account.syncSupported &&
    account.session?.syncSupported !== false &&
    account.session?.identityState === 'verified' &&
    identityState(account) === 'verified' &&
    !account.busy
  const confirmEnabled =
    confirmation?.kind === 'disconnect' ||
    (confirmedAccount && (confirmation?.kind !== 'activate' || canActivate(confirmedAccount)))

  const applyConfirmation = (): void => {
    if (!confirmation || !confirmEnabled) return
    if (confirmation.kind === 'disconnect') {
      void run(
        'disconnect',
        () => window.samba.jaja.disconnect(),
        '연결을 해제하지 못했습니다. 서버 연결을 확인한 뒤 다시 시도하세요.'
      )
    } else if (confirmation.kind === 'activate') {
      void run(
        confirmation.accountId,
        () => window.samba.jaja.activate(confirmation.accountId),
        '동기화로 전환하지 못했습니다. 계정의 로그인 상태를 다시 확인하세요.'
      )
    } else {
      void run(
        confirmation.accountId,
        () => window.samba.jaja.release(confirmation.accountId),
        '기존 방식으로 전환하지 못했습니다. 서버 연결을 확인한 뒤 다시 시도하세요.'
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[1060px] flex-col gap-5 p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">소싱 계정</h1>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text2)]">
              계정마다 로그인 공간을 분리하고, 확인된 계정의 로그인 정보를 자자에 연결합니다.
            </p>
          </div>
          {status?.connected && (
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
                {status.validation ? '검증 서버 연결됨' : '자자 연결됨'}
              </span>
              <SecondaryButton
                disabled={pending !== null}
                onClick={() => setConfirmation({ kind: 'disconnect' })}
              >
                연결 해제
              </SecondaryButton>
            </div>
          )}
        </header>

        {status?.validation && (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-[13px] text-violet-900">
            <strong>검증 전용 · 운영 미연결</strong>
            <p className="mt-1 text-[12px] leading-relaxed">
              합성 계정과 별도 로컬 서버를 사용합니다. 기존 자자의 계정·쿠키·자동발주에는 연결하지
              않습니다. 이 화면의 동기화와 전환도 검증 데이터에만 적용됩니다.
            </p>
          </div>
        )}

        {!confirmation && (notice || status?.error) && (
          <div
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900"
          >
            {notice ||
              '최근 연결 작업을 완료하지 못했습니다. 연결 상태를 새로고침하고 다시 확인하세요.'}
          </div>
        )}

        {!status?.connected ? (
          <section className="rounded-2xl border border-[var(--line)] bg-white p-7">
            <UsersRound className="mb-4 h-8 w-8 text-[var(--text2)]" />
            <h2 className="text-[16px] font-semibold">
              {status?.validation ? '검증 계정을 연결하세요' : '자자 계정을 연결하세요'}
            </h2>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--text2)]">
              연결하면 자자에 등록한 소싱 계정을 가져옵니다. 각 계정의 로그인 공간을 열어 로그인한
              뒤, 계정이 맞는지 확인할 수 있습니다.
            </p>
            <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-[var(--text2)]">
              처음에는 비교 모드로 시작합니다. 기존 발주 PC의 쿠키 공급은 유지되며, 동기화 전환은
              계정마다 직접 선택합니다.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <PrimaryButton
                disabled={pending !== null || status?.connecting}
                onClick={() =>
                  void run(
                    'connect',
                    () => window.samba.jaja.connect(customOrigin.trim() || undefined),
                    '자자 로그인 화면을 열지 못했습니다. 연결 주소를 확인하세요.',
                    true
                  )
                }
              >
                <span className="flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  {status?.connecting
                    ? '로그인 대기 중'
                    : status?.validation
                      ? '검증 서버 연결'
                      : '자자 연결'}
                </span>
              </PrimaryButton>
              {status?.connecting && (
                <SecondaryButton onClick={() => setView('browser')}>
                  로그인 화면 보기
                </SecondaryButton>
              )}
              <SecondaryButton
                disabled={pending !== null}
                onClick={() =>
                  void run(
                    'refresh',
                    () => window.samba.jaja.refresh(),
                    '연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.'
                  )
                }
              >
                연결 상태 확인
              </SecondaryButton>
            </div>
            {status?.connecting && (
              <p className="mt-3 text-[12px] text-blue-700">
                열린 자자 로그인 탭에서 연결을 완료해 주세요.
              </p>
            )}
            <details className="mt-6 border-t border-[var(--line)] pt-3 text-[12px] text-[var(--text2)]">
              <summary className="cursor-pointer">고급 · 로컬 개발 서버 연결</summary>
              <label className="mt-3 block">
                서버 주소
                <input
                  aria-label="자자 개발 서버 주소"
                  type="url"
                  placeholder={
                    status?.validation
                      ? '검증 전용: http://127.0.0.1:18300'
                      : '기본: https://api.ja-ja.org'
                  }
                  value={customOrigin}
                  onChange={(event) => setCustomOrigin(event.target.value)}
                  disabled={pending !== null || status?.connecting}
                  className="mt-1 block w-full max-w-md rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[var(--text)]"
                />
              </label>
              <p className="mt-2">
                일반 사용은 비워 두세요. 로컬 개발 서버에서 검증할 때만 주소를 입력합니다.
              </p>
            </details>
          </section>
        ) : (
          <>
            <section className="grid grid-cols-3 gap-3" aria-label="계정 현황">
              {[
                ['등록 계정', accounts.length],
                [
                  '로그인 확인됨',
                  accounts.filter((a) => a.session?.identityState === 'verified').length
                ],
                ['동기화 중', accounts.filter((a) => a.session?.state === 'active').length]
              ].map(([label, count]) => (
                <div key={label} className="rounded-xl border border-[var(--line)] bg-white p-4">
                  <div className="text-[11px] text-[var(--text2)]">{label}</div>
                  <div className="mt-1 text-[24px] font-semibold tabular-nums">{count}</div>
                </div>
              ))}
            </section>
            <div className="rounded-xl bg-blue-50/70 px-4 py-3 text-[12px] leading-relaxed text-slate-700">
              <strong className="font-semibold">
                비교 모드에서는 기존 운영 쿠키를 유지합니다.
              </strong>{' '}
              로그인 계정을 확인한 뒤 동기화로 전환하세요. 자자 연결 상태와 각 쇼핑몰의 로그인
              상태는 별도로 표시됩니다.
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3">
                <Search className="h-4 w-4 text-[var(--text2)]" />
                <input
                  aria-label="소싱 계정 검색"
                  placeholder="계정 이름 또는 소싱처 검색"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                />
              </label>
              <select
                aria-label="소싱처 필터"
                value={site}
                onChange={(event) => setSite(event.target.value)}
                className="rounded-lg border border-[var(--line)] bg-white px-3 text-[12px]"
              >
                <option value="all">모든 소싱처</option>
                {sites.map((value) => (
                  <option key={value} value={value}>
                    {siteName(value)}
                  </option>
                ))}
              </select>
              <SecondaryButton
                disabled={pending !== null}
                onClick={() =>
                  void run(
                    'refresh',
                    () => window.samba.jaja.refresh(),
                    '계정 목록을 불러오지 못했습니다. 서버 연결을 확인하세요.'
                  )
                }
              >
                <span className="flex items-center gap-1.5">
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', pending === 'refresh' && 'animate-spin')}
                  />
                  새로고침
                </span>
              </SecondaryButton>
            </div>
            {shown.length === 0 && (
              <div className="rounded-xl border border-dashed border-[var(--line)] p-8 text-center text-[13px] text-[var(--text2)]">
                {accounts.length
                  ? '검색 조건에 맞는 계정이 없습니다.'
                  : '등록된 소싱 계정이 없습니다. 자자에서 계정을 등록한 뒤 새로고침하세요.'}
              </div>
            )}
            <div className="grid gap-3 xl:grid-cols-2">
              {shown.map((account) => {
                const currentIdentity = identityState(account)
                const identity = IDENTITY[currentIdentity]
                const identityReason =
                  account.browserIdentityReason ?? account.session?.identityReason
                const state = account.session?.state ?? 'observe'
                const blocked = pending !== null || account.busy
                const supported = account.syncSupported && account.session?.syncSupported !== false
                return (
                  <article
                    key={account.accountId}
                    aria-label={`${siteName(account.site)} ${account.label}`}
                    className="flex flex-col rounded-2xl border border-[var(--line)] bg-white p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium text-[var(--text2)]">
                          {siteName(account.site)}
                        </p>
                        <h2 className="mt-1 truncate text-[15px] font-semibold">{account.label}</h2>
                        {account.usernameHint && (
                          <p className="mt-0.5 truncate text-[11px] text-[var(--text2)]">
                            {account.usernameHint}
                          </p>
                        )}
                      </div>
                      {account.busy && (
                        <LoaderCircle
                          aria-label="계정 확인 중"
                          className="h-4 w-4 shrink-0 animate-spin text-[var(--text2)]"
                        />
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px]',
                          identity.color
                        )}
                      >
                        {currentIdentity === 'verified' && <CircleCheck className="h-3 w-3" />}
                        {identity.label}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-1 text-[11px]',
                          state === 'active'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-slate-100 text-slate-600'
                        )}
                      >
                        {state === 'active'
                          ? '동기화 중'
                          : state === 'paused'
                            ? '동기화 일시중지'
                            : state === 'released'
                              ? '기존 방식 사용'
                              : '비교 모드'}
                      </span>
                    </div>
                    {!supported && (
                      <p className="mt-3 text-[12px] leading-relaxed text-amber-800">
                        {reason(
                          account.syncBlockedReason ?? account.session?.syncBlockedReason,
                          '이 소싱처는 아직 쿠키 동기화를 지원하지 않습니다. 로그인 공간은 열어 사용할 수 있습니다.'
                        )}
                      </p>
                    )}
                    {currentIdentity !== 'verified' && identityReason && (
                      <p className="mt-2 text-[12px] leading-relaxed text-[var(--text2)]">
                        {reason(
                          identityReason,
                          '로그인 공간에서 해당 계정으로 로그인한 뒤 상태를 확인하세요.'
                        )}
                      </p>
                    )}
                    {account.message &&
                      account.message !== identityReason &&
                      REASONS[account.message] && (
                        <p className="mt-2 text-[12px] leading-relaxed text-[var(--text2)]">
                          {REASONS[account.message]}
                        </p>
                      )}
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--line)] pt-3 text-[11px]">
                      <div>
                        <dt className="text-[var(--text2)]">로그인 확인</dt>
                        <dd className="mt-0.5">{when(account.lastCheckedAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--text2)]">최근 동기화</dt>
                        <dd className="mt-0.5">{when(account.session?.lastSyncedAt)}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <SecondaryButton
                        disabled={blocked}
                        onClick={() =>
                          void run(
                            account.accountId,
                            () => window.samba.jaja.open(account.accountId),
                            '로그인 공간을 열지 못했습니다. 잠시 후 다시 시도하세요.',
                            true
                          )
                        }
                      >
                        <span className="flex items-center gap-1.5">
                          로그인 공간 열기
                          <ExternalLink className="h-3 w-3" />
                        </span>
                      </SecondaryButton>
                      <SecondaryButton
                        disabled={blocked || !account.session}
                        onClick={() =>
                          void run(
                            account.accountId,
                            () => window.samba.jaja.check(account.accountId),
                            '로그인 상태를 확인하지 못했습니다. 로그인 공간에서 해당 계정을 확인하세요.'
                          )
                        }
                      >
                        상태 확인
                      </SecondaryButton>
                      {state === 'active' ? (
                        <SecondaryButton
                          disabled={blocked}
                          onClick={() =>
                            void run(
                              account.accountId,
                              () => window.samba.jaja.pause(account.accountId),
                              '동기화를 일시중지하지 못했습니다. 서버 연결을 확인하세요.'
                            )
                          }
                        >
                          일시중지
                        </SecondaryButton>
                      ) : (
                        <PrimaryButton
                          disabled={blocked || !canActivate(account)}
                          onClick={() =>
                            setConfirmation({ kind: 'activate', accountId: account.accountId })
                          }
                        >
                          {state === 'paused' ? '동기화 재개' : '동기화로 전환'}
                        </PrimaryButton>
                      )}
                      {(state === 'active' || state === 'paused') && (
                        <SecondaryButton
                          disabled={blocked}
                          onClick={() =>
                            setConfirmation({ kind: 'release', accountId: account.accountId })
                          }
                        >
                          기존 방식으로 전환
                        </SecondaryButton>
                      )}
                    </div>
                    <div className="mt-4 border-t border-[var(--line)] pt-3">
                      <p className="text-[11px] leading-relaxed text-[var(--text2)]">
                        로그인과 추가 인증은 로그인 공간에서 직접 진행합니다. 저장된 로그인 세션은
                        유지됩니다.
                      </p>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </div>
      {confirmation && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) setConfirmation(null)
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="gap-0 rounded-2xl bg-white p-5 sm:max-w-md"
          >
            <DialogTitle className="text-[16px] font-semibold">
              {confirmation.kind === 'disconnect'
                ? '자자 연결을 해제할까요?'
                : confirmation.kind === 'activate'
                  ? '이 브라우저에서 동기화할까요?'
                  : '기존 공급 방식으로 돌아갈까요?'}
            </DialogTitle>
            {confirmedAccount && (
              <p className="mt-3 rounded-lg bg-slate-50 p-3 text-[13px] font-medium">
                {siteName(confirmedAccount.site)} · {confirmedAccount.label}
              </p>
            )}
            <DialogDescription className="mt-3 text-[13px] leading-relaxed text-[var(--text2)]">
              {confirmation.kind === 'disconnect'
                ? '이 브라우저의 쿠키 공급을 종료하고 기존 공급 방식으로 돌아갑니다. 저장된 쇼핑몰 로그인은 삭제하지 않습니다.'
                : confirmation.kind === 'activate'
                  ? '이 계정의 쿠키 공급을 기존 확장앱에서 이 브라우저로 전환합니다. 이후 이 브라우저에서 확인한 로그인 정보가 자자에 반영됩니다. 자동발주를 시작하는 동작은 아닙니다.'
                  : '이 브라우저의 쿠키 공급을 종료하고 기존 확장앱의 공급을 다시 허용합니다. 기존 발주 PC가 실행 중이고 해당 계정으로 로그인되어 있는지 확인하세요.'}
            </DialogDescription>
            {notice && (
              <p role="alert" className="mt-3 text-[12px] text-amber-800">
                {notice}
              </p>
            )}
            {confirmation.kind === 'activate' &&
              confirmedAccount &&
              !canActivate(confirmedAccount) && (
                <p role="alert" className="mt-3 text-[12px] text-amber-800">
                  로그인 계정 확인이 필요합니다. 상태를 다시 확인한 뒤 전환하세요.
                </p>
              )}
            <div className="mt-5 flex justify-end gap-2">
              <SecondaryButton disabled={pending !== null} onClick={() => setConfirmation(null)}>
                취소
              </SecondaryButton>
              <PrimaryButton
                disabled={pending !== null || !confirmEnabled}
                onClick={applyConfirmation}
              >
                {pending
                  ? '처리 중…'
                  : confirmation.kind === 'activate'
                    ? '확인하고 동기화 시작'
                    : confirmation.kind === 'disconnect'
                      ? '연결 해제'
                      : '기존 방식으로 전환'}
              </PrimaryButton>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
