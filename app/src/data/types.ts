/** One row per person on the Cowork roster (the report's CoworkBilling table). */
export interface CoworkPerson {
  upn: string
  name: string
  policyId: string
  policyName: string
  /** MonthlyCreditLimit: the person's seat limit, 0 when none is recorded. */
  limit: number
  licensed: boolean
  /** MonthlyCreditsUsed: rounded credits in the last four weekly records. */
  used: number
  cohort: string
  bucket: 'Under Limit' | 'Approaching' | 'Over Limit'
  weeksActive: number
  weeksOver: number
  persistence: number | null
  recommended: number
  delta: number
  action: string
}

/** One weekly credit record (CreditsWeekly). */
export interface CreditRow {
  upn: string
  date: string
  service: string
  credits: number
}

export interface Policy {
  id: string
  name: string
  planLimit: number
  userLimit: number
}

export interface StudioTenantRow {
  envId: string
  env: string
  entitled: number
  prepaid: number
  payg: number
  date: string
}

export interface StudioAgentRow {
  agent: string
  product: string
  feature: string
  billed: number
  nonBilled: number
  model: string
  env: string
}

export interface StudioUserRow {
  email: string
  name: string
  agent: string
  billable: number
  credits: number
  licensed: boolean
}

export interface GhUsageRow {
  date: string
  username: string
  model: string
  credits: number
  gross: number
  discount: number
  net: number
  costCenter: string
  usageType: 'Chat and inline' | 'Coding agent'
  tier: '1. Lightweight' | '2. Versatile' | '3. Powerful'
}

export interface GhUser {
  username: string
  upn: string
  name: string
  plan: string
  enterprise: boolean
  included: number
}

export interface AzureDailyRow {
  date: string
  service: string
  cost: number
}

export interface AzureSolutionRow {
  date: string
  subscription: string
  resource: string
  application: string
  department: string
  service: string
  category: string
  actual: number
  amortized: number
  currency: string
  tokensM: number
  paygTokensM: number
  paygTokenCost: number
  requests: number
  speechHours: number
  pages: number
  images: number
  tagged: boolean
}

export interface AzureHealthRow {
  snapshot: string
  date: string
  subscription: string
  identity: string
  deployment: string
  application: string
  model: string
  sku: string
  region: string
  capacity: number
  util: number
  peak: number
  requests: number
  errors: number
  throttles: number
  latency: number
}

export interface ReconRow {
  period: string
  start: string
  end: string
  product: string
  pool: string
  representation: string
  amount: number
  currency: string
  status: string
  evidenceType: string
}

export interface TaskRow {
  date: string
  category: string
  type: string
  credits: number | null
  tasks: number
  org: string
}

export type SourceKind =
  | 'coworkMetrics'
  | 'policyMap'
  | 'peopleMeta'
  | 'policies'
  | 'org'
  | 'studioTenant'
  | 'studioAgent'
  | 'studioUser'
  | 'ghUsage'
  | 'ghUsers'
  | 'azureDaily'
  | 'azureSolution'
  | 'azureHealth'
  | 'recon'
  | 'tasks'

export interface SourceInfo {
  kind: SourceKind
  file: string
  rows: number
}

export interface Dataset {
  label: string
  sample: boolean
  sources: SourceInfo[]
  // Cowork
  people: CoworkPerson[]
  credits: CreditRow[]
  policies: Policy[]
  coworkMax: string
  // Org and Group By
  groupAttrs: string[]
  /** Lower-case UPN -> attribute -> group value. */
  groups: Map<string, Record<string, string>>
  // Studio
  studioTenant: StudioTenantRow[]
  studioAgents: StudioAgentRow[]
  studioUsers: StudioUserRow[]
  // GitHub
  ghUsage: GhUsageRow[]
  ghUsers: GhUser[]
  /** username (lower) -> UPN (lower) */
  ghUpn: Map<string, string>
  // Azure
  azureDaily: AzureDailyRow[]
  azureSolution: AzureSolutionRow[]
  azureHealth: AzureHealthRow[]
  recon: ReconRow[]
  // Cowork tasks
  tasks: TaskRow[]
  tasksLoaded: boolean
  /** Earliest and latest date across every dated source. */
  minDate: string
  maxDate: string
}

export const ZERO_GUID = '00000000-0000-0000-0000-000000000000'
export const NOT_SET = '(Not set)'
export const ALL_USERS = 'All users'
export const INTENSITY = {
  cowork: 'Usage Intensity (Cowork)',
  studio: 'Usage Intensity (Studio)',
  github: 'Usage Intensity (GitHub)',
} as const
