import { useMemo } from 'react'
import { useData } from '../data/store'
import { ALL_USERS } from '../data/types'
import { groupAttr } from '../metrics/common'
import { Select } from '../ui/primitives'
import { GROWTH_OPTIONS, groupValues } from './helpers'

/** Group By attribute and value: the report's GROUP BY slicer, plus a group filter. */
export function GroupByFields() {
  const { ds, filters, setFilter } = useData()
  const attr = groupAttr(ds, filters)
  const attrs = ds.groupAttrs
  const values = useMemo(() => groupValues(ds, attr), [ds, attr])
  return (
    <>
      <Select
        label="Group by"
        value={attr}
        onChange={(v) => {
          setFilter('group', v)
          setFilter('groupValue', '')
        }}
        options={attrs.map((a) => ({ value: a, label: a }))}
      />
      {attr !== ALL_USERS && (
        <Select label={attr} value={filters.groupValue ?? ''} onChange={(v) => setFilter('groupValue', v)} options={values.map((v) => ({ value: v, label: v }))} allLabel="All" />
      )}
    </>
  )
}

export function GrowthField() {
  const { filters, setFilter } = useData()
  return <Select label="Growth assumption" value={filters.growth ?? ''} onChange={(v) => setFilter('growth', v)} options={GROWTH_OPTIONS} allLabel="Fitted from history" />
}
