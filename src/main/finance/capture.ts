import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { FinanceCaptureReceipt } from '../../shared/finance-capture'
import type { FinanceCaptureStore } from './capture-store'

/** Tool wiring calls this with the active Tab and a run-scoped store, never model supplied rows. */
export async function captureCurrentFinancePage(
  tab: Tab,
  store: FinanceCaptureStore
): Promise<FinanceCaptureReceipt> {
  const page = await pageBridge.financeTables(tab)
  return store.save(page)
}
