import { useState } from 'react'
import { useData } from '../data/store'
import type { SourceKind } from '../data/types'
import { dateLabel, int } from './format'
import { Sheet } from './Sheet'

const KIND_LABEL: Record<SourceKind, string> = {
  coworkMetrics: 'Cowork credit metrics',
  policyMap: 'Cowork user-to-policy map',
  peopleMeta: 'People metadata',
  policies: 'Cowork spending policies',
  org: 'Organisation data (Viva / Entra)',
  tasks: 'Cowork task categories',
  studioTenant: 'Copilot Studio tenant consumption',
  studioAgent: 'Copilot Studio agent consumption',
  studioUser: 'Copilot Studio user consumption',
  ghUsage: 'GitHub Copilot usage report',
  ghUsers: 'GitHub Copilot seats',
  azureDaily: 'Azure AI daily cost',
  azureSolution: 'Azure AI solution cost',
  azureHealth: 'Azure AI deployment health',
  recon: 'Billing reconciliation',
}

const PRODUCT_KINDS: [string, SourceKind[]][] = [
  ['Cowork & Work IQ', ['coworkMetrics', 'policyMap', 'policies', 'peopleMeta', 'org', 'tasks']],
  ['Copilot Studio', ['studioTenant', 'studioAgent', 'studioUser']],
  ['GitHub Copilot', ['ghUsage', 'ghUsers']],
  ['Azure AI Foundry', ['azureDaily', 'azureSolution', 'azureHealth', 'recon']],
]

export function DataSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ds, loadFiles, loadSample } = useData()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setMsg(null)
    try {
      const found = await loadFiles([...files])
      const kinds = new Set(found.map((f) => f.kind))
      const missing = (Object.keys(KIND_LABEL) as SourceKind[]).filter((k) => !kinds.has(k))
      setMsg({
        ok: true,
        text: `Loaded ${[...kinds].map((k) => KIND_LABEL[k]).join(', ')}.${missing.length ? ` Not supplied: ${missing.map((k) => KIND_LABEL[k]).join(', ')}, so related measures show a dash.` : ''}`,
      })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Data source">
      <div className="source">
        <dl className="kv">
          <dt>Now showing</dt>
          <dd>{ds.sample ? 'Synthetic sample data (fictional people and amounts)' : ds.label}</dd>
          <dt>Dates</dt>
          <dd>
            {dateLabel(ds.minDate)} to {dateLabel(ds.maxDate)}
          </dd>
        </dl>
        {PRODUCT_KINDS.map(([product, kinds]) => (
          <div key={product}>
            <div className="mini-title">{product}</div>
            <dl className="kv">
              {kinds.map((k) => {
                const files = ds.sources.filter((s) => s.kind === k)
                return (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{KIND_LABEL[k]}</dt>
                    <dd>{files.length ? `${int(files.reduce((a, f) => a + f.rows, 0))} rows` : 'Not supplied'}</dd>
                  </div>
                )
              })}
            </dl>
          </div>
        ))}
        <h3>Use your own exports</h3>
        <p>
          Select the CSV exports described in the README: Cowork credit metrics and policies, Copilot Studio consumption, the GitHub Copilot usage report and seats, and Azure AI cost and health. Supply any subset; products without files show a dash. Files are read in your browser and never uploaded.
        </p>
        <label className="drop">
          <input type="file" accept=".csv,text/csv" multiple disabled={busy} onChange={(e) => void pick(e.target.files)} />
          <span className="btn btn-primary">{busy ? 'Reading files…' : 'Choose CSV files'}</span>
          <small>Files are recognised by their column headers, so names don't matter.</small>
        </label>
        {msg && (
          <p className={msg.ok ? 'notice' : 'notice notice-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
        {!ds.sample && (
          <button type="button" className="link-btn" onClick={() => void loadSample().then(() => setMsg({ ok: true, text: 'Back to the sample data.' }))}>
            Go back to the sample data
          </button>
        )}
      </div>
    </Sheet>
  )
}
