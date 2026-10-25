import { createContext } from 'react'

/** True inside a view or KPI row whose source files weren't supplied: KPIs there show a dash, not 0. */
export const NotSupplied = createContext(false)
