import { useCallback, useEffect, useMemo, useState } from 'react'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, PeriodPicker, SkeletonRows, usePeriod } from '../../components/admin'
import { IconDownload, IconHistory, IconShield } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState } from '../../components/ui'
import {
  AUDIT_CATEGORIES, categoryOf, describe, fieldChanges, isSensitive, summary, type AuditCategory, type AuditContext,
} from '../../lib/audit'
import { friendlyError } from '../../lib/errors'
import { dateTime, formatDay, timeOfDay, cafeDate } from '../../lib/format'
import type { AuditEntry } from '../../lib/types'
import { usePublicData } from '../../state/publicData'

const PAGE = 100

export function AuditLogPage() {
  const { data } = usePublicData()
  const [period, setPeriod] = usePeriod('audit', '7d')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<AuditCategory | 'all'>('all')
  const [person, setPerson] = useState('all')
  const [sensitive, setSensitive] = useState(false)
  const [open, setOpen] = useState<AuditEntry | null>(null)

  const ctx: AuditContext = useMemo(
    () => ({ categoryName: (id) => data?.menu.categories.find((c) => c.id === id)?.name ?? null }),
    [data],
  )

  const load = useCallback(async () => {
    setError(null)
    setEntries(null)
    try {
      const rows = await backend.listAudit({ fromDay: period.from, toDay: period.to, limit: PAGE })
      setEntries(rows)
      setMore(rows.length === PAGE)
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [period.from, period.to])

  useEffect(() => {
    void load()
  }, [load])

  async function loadMore() {
    if (!entries?.length) return
    setLoadingMore(true)
    try {
      const rows = await backend.listAudit({ fromDay: period.from, toDay: period.to, beforeId: entries[entries.length - 1].id, limit: PAGE })
      setEntries([...entries, ...rows])
      setMore(rows.length === PAGE)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const people = useMemo(() => [...new Set((entries ?? []).map((e) => e.actor_name))].sort(), [entries])
  const shown = useMemo(
    () =>
      (entries ?? []).filter(
        (e) => (category === 'all' || categoryOf(e) === category) && (person === 'all' || e.actor_name === person) && (!sensitive || isSensitive(e)),
      ),
    [entries, category, person, sensitive],
  )
  const days = useMemo(() => {
    const groups: { day: string; rows: AuditEntry[] }[] = []
    for (const e of shown) {
      const day = cafeDate(new Date(e.at))
      const g = groups[groups.length - 1]
      if (g && g.day === day) g.rows.push(e)
      else groups.push({ day, rows: [e] })
    }
    return groups
  }, [shown])
  const filtered = category !== 'all' || person !== 'all' || sensitive

  function exportCsv() {
    const rows: string[][] = [['Time', 'Person', 'What happened', 'Field', 'Before', 'After']]
    for (const e of shown) {
      const changes = fieldChanges(e, ctx)
      const base = [dateTime(e.at), e.actor_name, describe(e)]
      if (changes.length === 0) rows.push([...base, '', '', ''])
      for (const c of changes) rows.push([...base, c.label, c.before, c.after])
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    a.download = `bite-and-sip-audit-${period.from}-to-${period.to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <PageBody>
      <PageHeader
        title="Audit log"
        subtitle="Every change to prices, stock, payments, staff and settings — who did it and when. Entries can’t be edited or deleted."
        actions={<Button size="sm" variant="secondary" onClick={exportCsv} disabled={!shown.length}><IconDownload size={16} /> Export CSV</Button>}
      >
        <PeriodPicker value={period} onChange={setPeriod} maxDays={366} />
      </PageHeader>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by area">
          {[{ value: 'all' as const, label: 'Everything' }, ...AUDIT_CATEGORIES].map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={category === c.value}
              onClick={() => setCategory(c.value)}
              className={`min-h-9 rounded-full border px-3 text-sm font-semibold ${category === c.value ? 'border-ink bg-ink text-white' : 'border-line-strong bg-surface hover:border-ink'}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <select aria-label="Filter by person" className="field-input !min-h-9 !w-auto !rounded-md !py-1 text-sm" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="all">Everyone</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="size-4 accent-ink" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
          Sensitive only
        </label>
        {filtered && (
          <button type="button" className="text-sm font-semibold underline" onClick={() => { setCategory('all'); setPerson('all'); setSensitive(false) }}>Clear filters</button>
        )}
      </div>

      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner>}

      {!entries ? (
        !error && <div className="card"><SkeletonRows rows={8} label="Loading audit log" /></div>
      ) : shown.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconHistory size={28} />} title={filtered ? 'Nothing matches these filters' : 'No changes in this period'}>
            {filtered ? 'Try another area or person.' : 'Changes to the menu, stock, payments, staff and settings will appear here.'}
          </EmptyState>
        </div>
      ) : (
        <div className="space-y-4">
          {days.map((g) => (
            <Panel key={g.day} title={g.day === cafeDate() ? 'Today' : formatDay(g.day)} flush>
              <ul className="divide-y divide-line">
                {g.rows.map((e) => {
                  const line = summary(e, ctx)
                  return (
                    <li key={e.id}>
                      <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[#fafaf8] sm:px-5" onClick={() => setOpen(e)}>
                        <span className="tabular w-16 shrink-0 pt-0.5 text-xs text-muted" title={dateTime(e.at)}>{timeOfDay(e.at)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm">
                            <span className="font-bold">{e.actor_name}</span> {describe(e)}
                            {isSensitive(e) && (
                              <span className="ml-2 inline-flex items-center gap-1 rounded bg-[#fdf0dc] px-1.5 py-0.5 align-middle text-[11px] font-bold text-[#8a4b00]">
                                <IconShield size={11} /> Sensitive
                              </span>
                            )}
                          </span>
                          {line && <span className="mt-0.5 block truncate text-[13px] text-muted">{line}</span>}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Panel>
          ))}
          {more && (
            <div className="text-center">
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>Load older changes</Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={!!open} onClose={() => setOpen(null)} drawer title="Change details">
        {open && (
          <div className="space-y-5 p-5">
            <div>
              <p className="text-base"><span className="font-bold">{open.actor_name}</span> {describe(open)}</p>
              <p className="mt-1 text-sm text-muted">{dateTime(open.at)}</p>
            </div>
            {fieldChanges(open, ctx).length > 0 ? (
              <table className="dt overflow-hidden rounded-lg border border-line">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldChanges(open, ctx).map((c) => (
                    <tr key={c.field}>
                      <th scope="row" className="!bg-transparent !text-[13px] !text-ink-2">{c.label}</th>
                      <td className={`text-danger ${c.before !== '—' ? 'line-through' : ''} ${c.mono ? 'font-mono text-[13px]' : ''}`}>{c.before}</td>
                      <td className={`font-semibold text-ready ${c.mono ? 'font-mono text-[13px]' : ''}`}>{c.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">No field values are recorded for this action.</p>
            )}
            <p className="text-xs text-muted">Entry #{open.id} · recorded by the database, cannot be edited.</p>
          </div>
        )}
      </Dialog>
    </PageBody>
  )
}
