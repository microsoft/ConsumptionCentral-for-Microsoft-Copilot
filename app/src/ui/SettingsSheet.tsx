import { useData, DEFAULT_SETTINGS, type Settings } from '../data/store'
import { DateField, NumberField } from './primitives'
import { Sheet } from './Sheet'

type NumKey = Exclude<keyof Settings, 'changeDate'>

const GROUPS: { title: string; note: string; fields: { key: NumKey; label: string; step: number }[] }[] = [
  {
    title: 'Cowork & Work IQ',
    note: 'Prepaid capacity packs draw first; anything above the pack balance bills at the pay-as-you-go rate.',
    fields: [
      { key: 'coworkPayg', label: 'Pay-as-you-go $/credit', step: 0.001 },
      { key: 'coworkPrepaid', label: 'Prepaid $/credit', step: 0.001 },
      { key: 'pack', label: 'Capacity pack balance (credits)', step: 1000 },
    ],
  },
  {
    title: 'Copilot Studio',
    note: 'Applied to the tenant prepaid and pay-as-you-go credit quantities.',
    fields: [
      { key: 'studioPayg', label: 'Pay-as-you-go $/credit', step: 0.001 },
      { key: 'studioPrepaid', label: 'Prepaid $/credit', step: 0.001 },
    ],
  },
  {
    title: 'GitHub Copilot',
    note: 'Seat prices and included credits per seat. The new allowance applies to months ending on or after the change date.',
    fields: [
      { key: 'githubRate', label: 'Credit rate $/credit', step: 0.001 },
      { key: 'bizSeat', label: 'Business seat $/month', step: 1 },
      { key: 'entSeat', label: 'Enterprise seat $/month', step: 1 },
      { key: 'bizStd', label: 'Business included credits (new)', step: 100 },
      { key: 'entStd', label: 'Enterprise included credits (new)', step: 100 },
    ],
  },
]

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, setSettings } = useData()
  const set = (k: NumKey, v: string) => {
    const n = Number(v)
    if (v === '' || !Number.isFinite(n) || n < 0) return
    setSettings({ ...settings, [k]: n })
  }
  return (
    <Sheet open={open} onClose={onClose} title="Rates and settings">
      <div className="settings-form">
        <p className="section-note">Commercial assumptions behind every cost figure. Changes apply straight away and are not saved when you close the app.</p>
        {GROUPS.map((g) => (
          <fieldset key={g.title}>
            <legend>{g.title}</legend>
            <p className="section-note" style={{ gridColumn: '1 / -1', margin: 0 }}>
              {g.note}
            </p>
            {g.fields.map((f) => (
              <NumberField key={f.key} label={f.label} value={settings[f.key]} min={0} step={f.step} onChange={(v) => set(f.key, v)} />
            ))}
            {g.title === 'GitHub Copilot' && (
              <DateField label="Allowance change date" value={settings.changeDate} onChange={(v) => v && setSettings({ ...settings, changeDate: v })} />
            )}
          </fieldset>
        ))}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setSettings(DEFAULT_SETTINGS)}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Sheet>
  )
}
