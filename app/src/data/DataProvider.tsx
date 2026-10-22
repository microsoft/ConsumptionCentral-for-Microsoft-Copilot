import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DataContext, DEFAULT_SETTINGS, type DataState, type Filters, type Settings } from './store'
import type { Dataset } from './types'
import { loadFiles as readFiles, loadSample as readSample } from './load'

export function DataProvider({ children }: { children: ReactNode }) {
  const [ds, setDs] = useState<Dataset | null>(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Filters>({})
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

  const loadSample = useCallback(async () => {
    setError('')
    try {
      setDs(await readSample())
      setFilters({})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadFiles = useCallback(async (files: File[]) => {
    const { dataset, found } = await readFiles(files)
    setDs(dataset)
    setFilters({})
    return found
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadSample()
  }, [loadSample])

  const setFilter = useCallback((k: string, v: string) => setFilters((f) => ({ ...f, [k]: v })), [])
  const resetFilters = useCallback(() => setFilters({}), [])

  const value = useMemo<DataState | null>(
    () => ds && { ds, settings, setSettings, filters, setFilter, resetFilters, loadFiles, loadSample },
    [ds, settings, filters, setFilter, resetFilters, loadFiles, loadSample],
  )

  if (!value)
    return (
      <div className="boot" role="status">
        {error ? (
          <>
            <h1>Couldn't load the sample data</h1>
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => void loadSample()}>
              Try again
            </button>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <p>Loading consumption data…</p>
          </>
        )}
      </div>
    )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}
