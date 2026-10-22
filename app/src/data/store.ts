import { createContext, useContext } from 'react'
import type { Dataset, SourceInfo } from './types'

/** Everything commercial the report knows (the Settings table and its parameters). */
export interface Settings {
  coworkPayg: number
  coworkPrepaid: number
  studioPayg: number
  studioPrepaid: number
  /** Prepaid capacity pack balance in credits (the Capacity Pack Balance slicer). */
  pack: number
  githubRate: number
  bizSeat: number
  entSeat: number
  /** Date the GitHub included-credit standards change. */
  changeDate: string
  bizStd: number
  entStd: number
}

export const DEFAULT_SETTINGS: Settings = {
  coworkPayg: 0.01,
  coworkPrepaid: 0.008,
  studioPayg: 0.01,
  studioPrepaid: 0.008,
  pack: 0,
  githubRate: 0.01,
  bizSeat: 19,
  entSeat: 39,
  changeDate: '2026-09-01',
  bizStd: 1900,
  entStd: 3900,
}

/** Slicer state. Keys are page-specific; an empty string means "all" or the default. */
export type Filters = Record<string, string>

export interface DataState {
  ds: Dataset
  settings: Settings
  setSettings: (s: Settings) => void
  filters: Filters
  setFilter: (k: string, v: string) => void
  resetFilters: () => void
  loadFiles: (files: File[]) => Promise<SourceInfo[]>
  loadSample: () => Promise<void>
}

export const DataContext = createContext<DataState | null>(null)

export function useData(): DataState {
  const v = useContext(DataContext)
  if (!v) throw new Error('useData must be used inside DataProvider')
  return v
}
