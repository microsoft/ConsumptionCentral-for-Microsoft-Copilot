import { addDays, detectDayFirst, getter, has, hkey, num, numOrNull, parseCsv, toIso, truthy, type Rec } from './csv'
import type {
  AzureDailyRow,
  AzureHealthRow,
  AzureSolutionRow,
  CoworkPerson,
  CreditRow,
  Dataset,
  GhUsageRow,
  GhUser,
  Policy,
  ReconRow,
  SourceInfo,
  SourceKind,
  StudioAgentRow,
  StudioTenantRow,
  StudioUserRow,
  TaskRow,
} from './types'
import { ALL_USERS, INTENSITY, NOT_SET, ZERO_GUID } from './types'
import { intensityBand } from '../metrics/stats'

interface Parsed {
  name: string
  headers: string[]
  rows: Rec[]
}

/** Works out which export a file is from its headers, falling back to the file name. */
export function detectKind(headers: string[], name: string): SourceKind | null {
  const n = hkey(name)
  if (has(headers, 'Total Cowork tasks') || (has(headers, 'TaskCategory') && has(headers, 'MetricDate'))) return 'tasks'
  if (has(headers, 'Total Copilot Credits used') || (has(headers, 'MetricDate') && has(headers, 'ServiceName'))) return 'coworkMetrics'
  if (has(headers, 'SpendingPolicyId', 'PlanLimit')) return 'policies'
  if (has(headers, 'PersonId', 'SpendingPolicyId')) return 'policyMap'
  if (has(headers, 'PeopleHistoricalId') && !has(headers, 'PersonId')) return 'peopleMeta'
  if (has(headers, 'Prepaid Consumed Quantity') || has(headers, 'Entitled Quantity')) return 'studioTenant'
  if (has(headers, 'Non-billed credit') || has(headers, 'Billed credit')) return 'studioAgent'
  if (has(headers, 'Billable credit used') || has(headers, 'Billable credits used')) return 'studioUser'
  if (has(headers, 'username', 'gross_amount')) return 'ghUsage'
  if (has(headers, 'username', 'plan')) return 'ghUsers'
  if (has(headers, 'DeploymentId', 'PtuCapacity')) return 'azureHealth'
  if (has(headers, 'Representation', 'PoolName')) return 'recon'
  if (has(headers, 'ServiceCategory', 'ActualCost')) return 'azureSolution'
  if (has(headers, 'MeterCategory', 'Cost') || (has(headers, 'UsageDate', 'Cost') && has(headers, 'ServiceName'))) return 'azureDaily'
  const upn = has(headers, 'userPrincipalName') || has(headers, 'upn') || has(headers, 'email') || has(headers, 'mail')
  if (upn && (has(headers, 'department') || has(headers, 'jobTitle') || has(headers, 'costCenter') || has(headers, 'country'))) return 'org'
  if (upn && (n.includes('entra') || n.includes('orgdata') || n.includes('users'))) return 'org'
  return null
}

const lower = (s: string) => s.trim().toLowerCase()
const beforeAt = (s: string) => (s.includes('@') ? s.slice(0, s.indexOf('@')) : s)

function datesOf(rows: Rec[], col: (r: Rec) => string) {
  const dayFirst = detectDayFirst(rows.slice(0, 5000).map(col))
  return (r: Rec) => toIso(col(r), dayFirst)
}

// ---------- Cowork ----------

interface MetricRow {
  personId: string
  upn: string
  phid: string
  service: string
  policyId: string
  date: string
  credits: number
  userLimit: number
}

function readMetrics(p: Parsed): MetricRow[] {
  const h = p.headers
  const pid = getter(h, 'PersonId')
  const upn = getter(h, 'UserPrincipalName', 'upn')
  const phid = getter(h, 'PeopleHistoricalId')
  const svc = getter(h, 'ServiceName')
  const pol = getter(h, 'SpendingPolicyId')
  const date = datesOf(p.rows, getter(h, 'MetricDate'))
  const cr = getter(h, 'Total Copilot Credits used', 'CreditsUsed')
  const ul = getter(h, 'User limit', 'UserLimit')
  return p.rows
    .map((r) => {
      const u = upn(r)
      return {
        personId: pid(r) || u,
        upn: u,
        phid: phid(r),
        service: svc(r) || 'Other',
        policyId: pol(r),
        date: date(r),
        credits: num(cr(r)),
        userLimit: num(ul(r)),
      }
    })
    .filter((r) => r.date && r.personId)
}

function readPolicies(p: Parsed | undefined): Policy[] {
  if (!p) return []
  const h = p.headers
  const id = getter(h, 'SpendingPolicyId')
  const name = getter(h, 'Name', 'Policy Name')
  const plan = getter(h, 'PlanLimit')
  const user = getter(h, 'UserLimit')
  return p.rows.map((r) => ({ id: id(r), name: name(r), planLimit: num(plan(r)), userLimit: num(user(r)) })).filter((x) => x.id)
}

interface Meta {
  org: string
  licensed: boolean | null
}

function readPeopleMeta(files: Parsed[]): Map<string, Meta> {
  const map = new Map<string, Meta>()
  for (const p of files) {
    const id = getter(p.headers, 'PeopleHistoricalId')
    const org = getter(p.headers, 'Organization', 'Organisation')
    const lic = getter(p.headers, 'IsCopilotLicensed')
    for (const r of p.rows) {
      const k = lower(id(r))
      if (!k) continue
      const prev = map.get(k)
      const l = lic(r)
      map.set(k, { org: org(r) || prev?.org || '', licensed: l ? truthy(l) : (prev?.licensed ?? null) })
    }
  }
  return map
}

interface RosterRow {
  personId: string
  upn: string
  name: string
  policyId: string
  policyName: string
  limit: number
  licensed: boolean
  org: string
}

function buildRoster(metrics: MetricRow[], map: Parsed | undefined, policies: Policy[], meta: Map<string, Meta>): RosterRow[] {
  const pol = new Map(policies.map((p) => [p.id, p]))
  const out = new Map<string, RosterRow>()
  if (map) {
    const h = map.headers
    const pid = getter(h, 'PersonId')
    const phid = getter(h, 'PeopleHistoricalId')
    const upn = getter(h, 'userPrincipalName', 'upn')
    const name = getter(h, 'displayName')
    const pId = getter(h, 'SpendingPolicyId')
    for (const r of map.rows) {
      const id = pid(r)
      if (!id) continue
      const u = upn(r) || id
      const p = pol.get(pId(r))
      const m = meta.get(lower(phid(r)))
      out.set(id, {
        personId: id,
        upn: u,
        name: name(r) || beforeAt(u),
        policyId: pId(r),
        policyName: p?.name ?? '',
        limit: p?.userLimit ?? 0,
        licensed: m?.licensed === true,
        org: m?.org ?? '',
      })
    }
    return [...out.values()]
  }
  const byPerson = new Map<string, MetricRow[]>()
  for (const r of metrics) {
    const l = byPerson.get(r.personId)
    if (l) l.push(r)
    else byPerson.set(r.personId, [r])
  }
  for (const [id, rows] of byPerson) {
    const u = rows.find((r) => r.upn)?.upn || id
    const real = rows.find((r) => r.policyId && r.policyId !== ZERO_GUID)
    const policyId = (real ?? rows[0]).policyId
    const p = pol.get(policyId)
    const inline = Math.max(0, ...rows.map((r) => r.userLimit))
    const m = meta.get(lower(rows.find((r) => r.phid)?.phid ?? ''))
    out.set(id, {
      personId: id,
      upn: u,
      name: beforeAt(u),
      policyId,
      policyName: p?.name ?? '',
      limit: inline > 0 ? inline : (p?.userLimit ?? 0),
      licensed: m?.licensed === true,
      org: m?.org ?? '',
    })
  }
  return [...out.values()]
}

function seatAction(p: { weeksActive: number; used: number; limit: number; persistence: number | null }): string {
  const util = p.limit ? p.used / p.limit : null
  const pers = p.persistence
  if (p.weeksActive === 0) return '1. Reclaim - never used'
  if (p.used === 0) return '2. Review - no usage in billing period'
  if (p.limit === 0) return '0. Set a limit - none recorded'
  if (util !== null && util < 0.25) return '3. Downsize - under 25% used'
  if (pers !== null && pers > 0 && pers < 0.3) return '4. Hold - spiky, not structural'
  if (util !== null && util >= 0.85 && (pers ?? 0) < 0.6) return '5. Monitor - near limit'
  if (pers !== null && pers >= 0.6) return '6. Upgrade - persistently over'
  return '7. Correctly sized'
}

function buildCowork(metrics: MetricRow[], roster: RosterRow[]) {
  const upnOf = new Map(roster.map((r) => [r.personId, r.upn]))
  const credits: CreditRow[] = metrics.map((m) => ({
    upn: lower(m.upn || upnOf.get(m.personId) || m.personId),
    date: m.date,
    service: m.service,
    credits: m.credits,
  }))
  let max = ''
  for (const c of credits) if (c.date > max) max = c.date
  const start = max ? addDays(max, -21) : ''
  const periodUsed = new Map<string, number>()
  const lastDate = new Map<string, string>()
  for (const m of metrics) {
    if (m.date >= start) periodUsed.set(m.personId, (periodUsed.get(m.personId) ?? 0) + m.credits)
    if (m.date > (lastDate.get(m.personId) ?? '')) lastDate.set(m.personId, m.date)
  }
  // Weeks Active / Weeks Over Limit use every week for the UPN.
  const weekly = new Map<string, Map<string, number>>()
  for (const c of credits) {
    let w = weekly.get(c.upn)
    if (!w) weekly.set(c.upn, (w = new Map()))
    w.set(c.date, (w.get(c.date) ?? 0) + c.credits)
  }
  const used = roster.map((r) => Math.round(periodUsed.get(r.personId) ?? 0))
  const sorted = [...used].sort((a, b) => a - b)
  const people: CoworkPerson[] = roster.map((r, i) => {
    const u = used[i]
    const key = lower(r.upn)
    const weeks = weekly.get(key)
    const weeksActive = weeks?.size ?? 0
    const wl = r.limit / 4.345
    const weeksOver = r.limit === 0 || !weeks ? 0 : [...weeks.values()].filter((v) => v > wl).length
    const persistence = weeksActive ? weeksOver / weeksActive : null
    const ratio = r.limit ? u / r.limit : null
    const bucket: CoworkPerson['bucket'] =
      (r.limit === 0 && u > 0) || (ratio !== null && ratio > 1) ? 'Over Limit' : ratio !== null && ratio >= 0.85 ? 'Approaching' : 'Under Limit'
    const recommended = u === 0 ? 0 : Math.max(250, Math.ceil((u * 1.15) / 250) * 250)
    return {
      upn: key,
      name: r.name,
      policyId: r.policyId,
      policyName: r.policyName,
      limit: r.limit,
      licensed: r.licensed,
      used: u,
      cohort: intensityBand(u, sorted, false),
      bucket,
      weeksActive,
      weeksOver,
      persistence,
      recommended,
      delta: r.limit - recommended,
      action: seatAction({ weeksActive, used: u, limit: r.limit, persistence }),
    }
  })
  return { people, credits, max }
}

// ---------- Org and Group By ----------

const ORG_FIELDS: [string, string[]][] = [
  ['Department', ['Department', 'dept', 'Organization', 'Organisation']],
  ['Business Unit', ['BusinessUnit', 'division', 'segment', 'company']],
  ['Cost Center', ['CostCenter', 'costcentre']],
  ['Job Family', ['JobFamily', 'function', 'functiontype']],
  ['Job Title', ['JobTitle', 'title', 'role']],
  ['Country', ['Country', 'countryorregion', 'region']],
  ['City', ['City', 'officelocation', 'location']],
  ['Manager', ['Manager', 'managername']],
]

function readOrg(p: Parsed | undefined) {
  const out = new Map<string, Record<string, string>>()
  if (!p) return out
  const upn = getter(p.headers, 'userPrincipalName', 'upn', 'email', 'mail')
  const name = getter(p.headers, 'displayName', 'name', 'fullname')
  const fields = ORG_FIELDS.map(([label, al]) => [label, getter(p.headers, ...al)] as const)
  for (const r of p.rows) {
    const k = lower(upn(r))
    if (!k) continue
    const rec: Record<string, string> = { User: name(r) }
    for (const [label, g] of fields) rec[label] = g(r)
    out.set(k, rec)
  }
  return out
}

// ---------- Studio ----------

function latestSnapshot(p: Parsed): Rec[] {
  const snap = getter(p.headers, 'snapshot_month', 'Snapshot Month')
  if (!has(p.headers, 'snapshot_month')) return p.rows
  const month = (v: string) => (/^\d{6}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4)}` : toIso(/^\d{4}-\d{1,2}$/.test(v) ? `${v}-01` : v).slice(0, 7))
  let last = ''
  for (const r of p.rows) if (month(snap(r)) > last) last = month(snap(r))
  return p.rows.filter((r) => month(snap(r)) === last)
}

function readStudioTenant(p: Parsed | undefined): StudioTenantRow[] {
  if (!p) return []
  const h = p.headers
  const envId = getter(h, 'Environment Id')
  const env = getter(h, 'Environment Name')
  const ent = getter(h, 'Entitled Quantity')
  const pre = getter(h, 'Prepaid Consumed Quantity')
  const payg = getter(h, 'Pay as you go Consumed Quantity')
  const date = datesOf(p.rows, getter(h, 'Usage Date'))
  return p.rows
    .map((r) => ({ envId: envId(r) || env(r), env: env(r), entitled: num(ent(r)), prepaid: num(pre(r)), payg: num(payg(r)), date: date(r) }))
    .filter((r) => r.date)
}

function readStudioAgents(p: Parsed | undefined): StudioAgentRow[] {
  if (!p) return []
  const rows = latestSnapshot(p)
  const h = p.headers
  const agent = getter(h, 'Agent Name')
  const product = getter(h, 'Product')
  const feature = getter(h, 'AI Feature/Billable Feature', 'Billable Feature', 'AI Feature')
  const billed = getter(h, 'Billed credit', 'Billed credits')
  const nb = getter(h, 'Non-billed credit', 'Non-billed credits')
  const model = getter(h, 'LLM Model')
  const env = getter(h, 'Environment Name')
  return rows.map((r) => ({
    agent: agent(r),
    product: product(r),
    feature: feature(r),
    billed: num(billed(r)),
    nonBilled: num(nb(r)),
    model: model(r),
    env: env(r),
  }))
}

function readStudioUsers(p: Parsed | undefined): StudioUserRow[] {
  if (!p) return []
  const rows = latestSnapshot(p)
  const h = p.headers
  const id = getter(h, 'User Id')
  const email = getter(h, 'User Email', 'UserPrincipalName', 'UPN')
  const agent = getter(h, 'Agent Name')
  const billable = getter(h, 'Billable credit used', 'Billable credits used')
  const credits = getter(h, 'Credits used', 'Credit used')
  const lic = getter(h, 'M365 Copilot Licensed')
  return rows.map((r) => {
    const e = lower(email(r) || id(r))
    return { email: e, name: beforeAt(e), agent: agent(r), billable: num(billable(r)), credits: num(credits(r)), licensed: truthy(lic(r)) }
  })
}

// ---------- GitHub ----------

export function modelTier(model: string): GhUsageRow['tier'] {
  const m = model.toLowerCase()
  if (['opus', 'codex', 'gpt-5.5', 'sol', 'pro'].some((s) => m.includes(s))) return '3. Powerful'
  if (['mini', 'nano', 'haiku', 'flash', 'luna'].some((s) => m.includes(s))) return '1. Lightweight'
  return '2. Versatile'
}

function readGhUsage(p: Parsed | undefined): GhUsageRow[] {
  if (!p) return []
  const h = p.headers
  const date = datesOf(p.rows, getter(h, 'date'))
  const user = getter(h, 'username')
  const sku = getter(h, 'sku')
  const model = getter(h, 'model')
  const qty = getter(h, 'quantity')
  const gross = getter(h, 'gross_amount')
  const disc = getter(h, 'discount_amount')
  const net = getter(h, 'net_amount')
  const cc = getter(h, 'cost_center_name', 'cost_centre')
  return p.rows
    .map((r) => {
      const m = model(r)
      return {
        date: date(r),
        username: user(r),
        model: m,
        credits: num(qty(r)),
        gross: num(gross(r)),
        discount: num(disc(r)),
        net: num(net(r)),
        costCenter: cc(r),
        usageType: sku(r).includes('coding_agent') ? ('Coding agent' as const) : ('Chat and inline' as const),
        tier: modelTier(m),
      }
    })
    .filter((r) => r.date)
}

function readGhUsers(p: Parsed | undefined): GhUser[] {
  if (!p) return []
  const h = p.headers
  const user = getter(h, 'username')
  const upn = getter(h, 'userPrincipalName')
  const name = getter(h, 'displayName')
  const plan = getter(h, 'plan')
  const inc = getter(h, 'included_credits')
  return p.rows
    .map((r) => ({
      username: user(r),
      upn: lower(upn(r)),
      name: name(r) || user(r),
      plan: plan(r),
      enterprise: plan(r) === 'Copilot Enterprise',
      included: num(inc(r)),
    }))
    .filter((u) => u.username)
}

// ---------- Azure ----------

function readAzureDaily(p: Parsed | undefined): AzureDailyRow[] {
  if (!p) return []
  const h = p.headers
  const date = datesOf(p.rows, getter(h, 'UsageDate', 'Date'))
  const svc = getter(h, 'ServiceName')
  const cost = getter(h, 'Cost', 'CostInBillingCurrency')
  return p.rows.map((r) => ({ date: date(r), service: svc(r), cost: num(cost(r)) })).filter((r) => r.date)
}

function readAzureSolution(p: Parsed | undefined): AzureSolutionRow[] {
  if (!p) return []
  const h = p.headers
  const g = (...a: string[]) => getter(h, ...a)
  const date = datesOf(p.rows, g('UsageDate'))
  const [sub, res, app, dept, svc, cat, act, amo, cur, tok, ptok, ic, oc, cc, req, sh, pg, img, alloc] = [
    g('SubscriptionName'),
    g('ResourceName'),
    g('Application'),
    g('DepartmentTag'),
    g('ServiceName'),
    g('ServiceCategory'),
    g('ActualCost'),
    g('AmortizedCost'),
    g('Currency'),
    g('TotalTokensM'),
    g('PaygTokensM'),
    g('InputPaygCost'),
    g('OutputPaygCost'),
    g('CachedPaygCost'),
    g('Requests'),
    g('SpeechHours'),
    g('DocumentPages'),
    g('Images'),
    g('AllocationStatus'),
  ]
  return p.rows
    .map((r) => ({
      date: date(r),
      subscription: sub(r),
      resource: res(r),
      application: app(r),
      department: dept(r),
      service: svc(r),
      category: cat(r),
      actual: num(act(r)),
      amortized: num(amo(r)),
      currency: cur(r),
      tokensM: num(tok(r)),
      paygTokensM: num(ptok(r)),
      paygTokenCost: num(ic(r)) + num(oc(r)) + num(cc(r)),
      requests: num(req(r)),
      speechHours: num(sh(r)),
      pages: num(pg(r)),
      images: num(img(r)),
      tagged: alloc(r) === 'Tagged',
    }))
    .filter((r) => r.date)
}

function readAzureHealth(p: Parsed | undefined): AzureHealthRow[] {
  if (!p) return []
  const h = p.headers
  const g = (...a: string[]) => getter(h, ...a)
  const snap = datesOf(p.rows, g('SnapshotDate'))
  const date = datesOf(p.rows, g('MetricDate'))
  const [sub, rid, did, dname, app, model, sku, region, cap, util, peak, req, err, thr, lat] = [
    g('SubscriptionName'),
    g('ResourceId'),
    g('DeploymentId'),
    g('DeploymentName'),
    g('Application'),
    g('ModelName'),
    g('SkuName'),
    g('Region'),
    g('PtuCapacity'),
    g('MeanUtilizationPct'),
    g('PeakUtilizationPct'),
    g('Requests'),
    g('ServerErrors5xx'),
    g('Throttles429'),
    g('MeanLatencyMs'),
  ]
  return p.rows.map((r) => ({
    snapshot: snap(r),
    date: date(r),
    subscription: sub(r),
    identity: `${lower(rid(r))}/deployments/${lower(did(r))}`,
    deployment: dname(r) || did(r),
    application: app(r),
    model: model(r),
    sku: sku(r),
    region: region(r),
    capacity: num(cap(r)),
    util: num(util(r)),
    peak: num(peak(r)),
    requests: num(req(r)),
    errors: num(err(r)),
    throttles: num(thr(r)),
    latency: num(lat(r)),
  }))
}

function readRecon(p: Parsed | undefined): ReconRow[] {
  if (!p) return []
  const h = p.headers
  const g = (...a: string[]) => getter(h, ...a)
  const start = datesOf(p.rows, g('PeriodStart'))
  const end = datesOf(p.rows, g('PeriodEnd'))
  const [period, product, pool, rep, amount, cur, status, ev] = [
    g('Period'),
    g('Product'),
    g('PoolName'),
    g('Representation'),
    g('Amount'),
    g('Currency'),
    g('Status'),
    g('EvidenceType'),
  ]
  return p.rows.map((r) => ({
    period: period(r),
    start: start(r),
    end: end(r),
    product: product(r),
    pool: pool(r),
    representation: rep(r),
    amount: num(amount(r)),
    currency: cur(r),
    status: status(r),
    evidenceType: ev(r),
  }))
}

// ---------- Cowork tasks ----------

function readTasks(p: Parsed | undefined, meta: Map<string, Meta>): TaskRow[] {
  if (!p) return []
  const h = p.headers
  const g = (...a: string[]) => getter(h, ...a)
  const date = datesOf(p.rows, g('MetricDate', 'metric_date'))
  const cat = g('TaskCategory', 'task_category')
  const type = g('TaskType', 'task_type')
  const cr = g('Total credits used', 'CreditsUsed', 'credits_used')
  const cnt = g('Total Cowork tasks', 'TaskCount', 'task_count')
  const phid = g('PeopleHistoricalId', 'people_historical_id')
  const org = g('Organization', 'Organisation')
  return p.rows
    .map((r) => ({
      date: date(r),
      category: cat(r) || 'Not supplied',
      type: type(r) || 'Not supplied',
      credits: numOrNull(cr(r)),
      tasks: num(cnt(r)),
      org: org(r) || meta.get(lower(phid(r)))?.org || 'Not supplied',
    }))
    .filter((r) => r.date)
}

// ---------- Assemble ----------

export function buildDataset(files: Parsed[], label: string, sample: boolean): { dataset: Dataset; found: SourceInfo[] } {
  const byKind = new Map<SourceKind, Parsed[]>()
  const sources: SourceInfo[] = []
  for (const f of files) {
    const k = detectKind(f.headers, f.name)
    if (!k) continue
    const l = byKind.get(k)
    if (l) l.push(f)
    else byKind.set(k, [f])
    sources.push({ kind: k, file: f.name, rows: f.rows.length })
  }
  const one = (k: SourceKind): Parsed | undefined => {
    const l = byKind.get(k)
    if (!l?.length) return undefined
    return l.length === 1 ? l[0] : { name: l[0].name, headers: l[0].headers, rows: l.flatMap((x) => x.rows) }
  }

  const metrics = one('coworkMetrics') ? readMetrics(one('coworkMetrics')!) : []
  const policies = readPolicies(one('policies'))
  const taskPeople = (byKind.get('peopleMeta') ?? []).filter((p) => has(p.headers, 'FunctionType'))
  const meta = readPeopleMeta(byKind.get('peopleMeta') ?? [])
  const roster = metrics.length ? buildRoster(metrics, one('policyMap'), policies, meta) : []
  const cowork = buildCowork(metrics, roster)
  const taskMeta = readPeopleMeta(taskPeople.length ? taskPeople : (byKind.get('peopleMeta') ?? []))

  const studioTenant = readStudioTenant(one('studioTenant'))
  const studioAgents = readStudioAgents(one('studioAgent'))
  const studioUsers = readStudioUsers(one('studioUser'))
  const ghUsage = readGhUsage(one('ghUsage'))
  const ghUsers = readGhUsers(one('ghUsers'))
  const ghUpn = new Map(ghUsers.filter((u) => u.upn).map((u) => [u.username.toLowerCase(), u.upn]))

  // Org: Entra wins per attribute; Viva Organization fills Department through the policy map.
  const org = readOrg(one('org'))
  const vivaOrg = new Map<string, string>()
  const pm = one('policyMap')
  if (pm) {
    const upn = getter(pm.headers, 'userPrincipalName', 'upn')
    const phid = getter(pm.headers, 'PeopleHistoricalId')
    for (const r of pm.rows) {
      const o = meta.get(lower(phid(r)))?.org
      if (o && upn(r)) vivaOrg.set(lower(upn(r)), o)
    }
  }

  const names = new Map<string, string>()
  for (const [k, v] of org) if (v.User) names.set(k, v.User)
  for (const p of cowork.people) if (!names.has(p.upn)) names.set(p.upn, p.name)
  for (const u of studioUsers) if (u.email && !names.has(u.email)) names.set(u.email, u.name)
  for (const u of ghUsers) if (u.upn && !names.has(u.upn)) names.set(u.upn, u.name)

  const all = new Set<string>([...org.keys(), ...cowork.people.map((p) => p.upn), ...studioUsers.map((u) => u.email).filter(Boolean), ...ghUsers.map((u) => u.upn).filter(Boolean)])

  const counts = new Map<string, number>()
  const groups = new Map<string, Record<string, string>>()
  for (const k of all) {
    const o = org.get(k)
    const rec: Record<string, string> = { [ALL_USERS]: ALL_USERS, User: names.get(k) || beforeAt(k) }
    for (const [label] of ORG_FIELDS) {
      let v = o?.[label] ?? ''
      if (!v && label === 'Department') v = vivaOrg.get(k) ?? ''
      if (v) counts.set(label, (counts.get(label) ?? 0) + 1)
      rec[label] = v || NOT_SET
    }
    groups.set(k, rec)
  }
  const orgAttrs = ORG_FIELDS.map(([l]) => l).filter((l) => (counts.get(l) ?? 0) >= Math.max(1, all.size * 0.05))

  // Usage Intensity, one attribute per product.
  const intensity: string[] = []
  const assign = (attr: string, used: Map<string, number>, zeroIsNotUsed: boolean) => {
    if (!used.size) return
    intensity.push(attr)
    const sorted = [...used.values()].sort((a, b) => a - b)
    for (const k of all) {
      const v = used.get(k)
      groups.get(k)![attr] = v === undefined ? '0. Not used' : intensityBand(v, sorted, zeroIsNotUsed)
    }
  }
  assign(INTENSITY.cowork, new Map(cowork.people.map((p) => [p.upn, p.used])), false)
  const su = new Map<string, number>()
  for (const u of studioUsers) if (u.email) su.set(u.email, (su.get(u.email) ?? 0) + u.credits)
  assign(INTENSITY.studio, su, true)
  const byUser = new Map<string, number>()
  for (const r of ghUsage) byUser.set(r.username.toLowerCase(), (byUser.get(r.username.toLowerCase()) ?? 0) + r.credits)
  const gu = new Map<string, number>()
  for (const u of ghUsers) if (u.upn) gu.set(u.upn, (gu.get(u.upn) ?? 0) + (byUser.get(u.username.toLowerCase()) ?? 0))
  assign(INTENSITY.github, gu, true)

  const azureDaily = readAzureDaily(one('azureDaily'))
  const azureSolution = readAzureSolution(one('azureSolution'))
  const azureHealth = readAzureHealth(one('azureHealth'))
  const recon = readRecon(one('recon'))
  const tasks = readTasks(one('tasks'), taskMeta)

  let minDate = ''
  let maxDate = ''
  const see = (d: string) => {
    if (!d) return
    if (!minDate || d < minDate) minDate = d
    if (d > maxDate) maxDate = d
  }
  for (const r of cowork.credits) see(r.date)
  for (const r of studioTenant) see(r.date)
  for (const r of ghUsage) see(r.date)
  for (const r of azureDaily) see(r.date)

  const dataset: Dataset = {
    label,
    sample,
    sources,
    people: cowork.people,
    credits: cowork.credits,
    policies,
    coworkMax: cowork.max,
    groupAttrs: [ALL_USERS, ...orgAttrs, 'User', ...intensity],
    groups,
    studioTenant,
    studioAgents,
    studioUsers,
    ghUsage,
    ghUsers,
    ghUpn,
    azureDaily,
    azureSolution,
    azureHealth,
    recon,
    tasks,
    tasksLoaded: byKind.has('tasks'),
    minDate,
    maxDate,
  }
  return { dataset, found: sources }
}

export async function loadFiles(files: File[]) {
  const parsed: Parsed[] = []
  for (const f of files) {
    const { headers, rows } = parseCsv(await f.text())
    parsed.push({ name: f.name, headers, rows })
  }
  const res = buildDataset(parsed, files.length === 1 ? files[0].name : `${files.length} files`, false)
  if (!res.found.length) throw new Error('None of these files look like a supported export. Check the column headers against the README.')
  return res
}

export async function loadSample(): Promise<Dataset> {
  const base = `${import.meta.env.BASE_URL}sample/`
  const res = await fetch(`${base}manifest.json`)
  if (!res.ok) throw new Error(`Sample manifest returned ${res.status}`)
  const names = (await res.json()) as string[]
  const parsed = await Promise.all(
    names.map(async (name) => {
      const r = await fetch(base + name)
      if (!r.ok) throw new Error(`${name} returned ${r.status}`)
      const { headers, rows } = parseCsv(await r.text())
      return { name, headers, rows }
    }),
  )
  return buildDataset(parsed, 'Synthetic sample (Contoso Health)', true).dataset
}
