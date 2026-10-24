// @ts-check
/**
 * The data sources Consumption Central reads, how each one arrives (an API, a CSV the admin exports, or
 * not at all), and how an uploaded CSV is recognised from its headers. The upload router notebook
 * gets the same signatures, so the installer and the scheduled pipeline always agree.
 */

import { COMMAND, UPLOAD_DIR, UPLOAD_LOG_TABLE } from './product.js';

/** The one drop folder. The installer, OneLake File Explorer and Fabric uploads all write here. */
export { UPLOAD_DIR, UPLOAD_LOG_TABLE };
/** Where an optional OneLake shortcut to a SharePoint "Consumption Central uploads" folder goes. Read-only: files there are never moved. */
export const SHAREPOINT_SUBDIR = `${UPLOAD_DIR}/sharepoint`;
export const STUDIO_DIR = 'Files/landing/studio';
export const VIVA_DIR = 'Files/landing/viva';
export const GITHUB_DIR = 'Files/landing/github';
export const ORG_DIR = 'Files/landing/org';
/**
 * The one Cowork task export Ingest_Viva_Consumption reads, as CoworkWeeklyMetrics.csv with its
 * PeopleMetaData.csv. A new pair overwrites the last: the notebook rereads every export it finds and
 * stops when two restate a week differently, and the weeks already loaded stay in the table.
 */
export const COWORK_TASKS_DIR = `${VIVA_DIR}/cowork_tasks`;
/** Folders uploads land in, made by the installer so a first run never trips over a missing one. */
export const UPLOAD_FOLDERS = [UPLOAD_DIR, STUDIO_DIR, VIVA_DIR, COWORK_TASKS_DIR, GITHUB_DIR, ORG_DIR];
/** Largest file the installer uploads. Bigger exports go through OneLake File Explorer or the Lakehouse. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** @typedef {'api' | 'csv' | 'skip'} SourceMode */
/** @typedef {'coworkCredits' | 'coworkTasks' | 'studioCredits' | 'github' | 'azureAi' | 'orgData' | 'commercialTerms'} DataSourceId */
/** @typedef {Record<DataSourceId, SourceMode>} DataSourceModes */

/**
 * @typedef {object} DataSourceInfo
 * @property {DataSourceId} id
 * @property {string} label
 * @property {string} description
 * @property {SourceMode[]} modes  In order of preference: the API first when there is one.
 * @property {SourceMode} defaultMode
 * @property {boolean} [locked]  The dashboard is built on it, so it can't be skipped.
 * @property {{ where: string, url: string, files: string }} [export]  Where the admin downloads the CSV.
 * @property {SourceMode[]} [exportModes]  The modes that still need the export. Default csv.
 * @property {SourceMode[]} [uploadModes]  The modes in which the router takes this source's CSVs. Default: every mode but skip.
 * @property {string} [page]  The dashboard pages that stay dormant when it is skipped.
 * @property {Partial<Record<SourceMode, string>>} [modeLabels]  Overrides MODE_LABELS, e.g. "Connected (Dataflow)".
 * @property {Partial<Record<SourceMode, string>>} [hints]  What the mode does, shown under the card.
 * @property {string} [group]  A heading the card sits under with the others that share it.
 */

/** The heading over the cards for the credits and costs the pages report. */
export const USAGE_GROUP = 'Usage and costs';
/** The heading over the cards that add context: who people are, and what a credit costs. */
export const CONTEXT_GROUP = 'People and prices';

const PAIR_DETAIL =
  'A Cowork task export is read with the PeopleMetaData.csv that came with it, so the two arrive together: ' +
  `run "${COMMAND} upload" with both files, or put both in ${COWORK_TASKS_DIR}/ as CoworkWeeklyMetrics.csv and PeopleMetaData.csv, replacing the ones there. ` +
  "A PeopleMetaData.csv on its own isn't needed: credits exports don't use it.";

/** @type {DataSourceInfo[]} */
export const DATA_SOURCES = [
  {
    id: 'coworkCredits',
    label: 'Copilot Cowork and Work IQ credits',
    description: 'Credits by person, week, service and spending policy, from Viva Insights. Most pages are built on it.',
    modes: ['api', 'csv', 'skip'],
    defaultMode: 'csv',
    // The spending policies come only from their export, Dataflow or not.
    exportModes: ['api', 'csv'],
    page: '1–4. Cowork',
    group: USAGE_GROUP,
    modeLabels: { api: 'Connected (Dataflow)' },
    hints: {
      api: 'A Viva Insights analyst builds the custom query (docs/VIVA-QUERY.md) and gives you its partition and query IDs. The installer creates a Dataflow Gen2 that reads it on every run, and you sign in to the Dataflow once. Spending policies are still a CSV upload.',
      csv: 'Upload the export each month, with the spending policies file.',
    },
    export: {
      where: 'Viva Insights > Copilot Consumption Dashboard > Export. Upload PersonServiceCreditsMetrics.csv and SpendingPolicyMetadata.csv from the ZIP.',
      url: 'https://analysis.insights.cloud.microsoft',
      files: 'Credits add up and are de-duplicated. A new policy file replaces the last one.',
    },
  },
  {
    id: 'coworkTasks',
    label: 'Cowork task categories',
    description: "Cowork task counts by person, week, category and how the task started. They fill the Cowork: Tasks page; the other pages don't need them.",
    modes: ['csv', 'skip'],
    defaultMode: 'skip',
    page: '2.1. Cowork: Tasks',
    group: USAGE_GROUP,
    hints: {
      csv: 'Upload each CoworkWeeklyMetrics.csv with the PeopleMetaData.csv that came with it, and load it before the next.',
    },
    export: {
      where: 'Viva Insights: the Cowork weekly metrics export, CoworkWeeklyMetrics.csv with its PeopleMetaData.csv. See docs/COWORK-TASKS.md.',
      url: 'https://analysis.insights.cloud.microsoft',
      files: 'One pair at a time: a new pair replaces the last, and the weeks it held stay loaded.',
    },
  },
  {
    id: 'studioCredits',
    label: 'Copilot Studio credits',
    description: 'Copilot Studio credits by day, environment, agent and user.',
    modes: ['api', 'csv', 'skip'],
    defaultMode: 'csv',
    page: '5–8. Studio',
    group: USAGE_GROUP,
    modeLabels: { api: 'Connected (Power Automate flow)', csv: 'Upload CSV only' },
    hints: {
      api: 'A daily Power Automate flow reads the Power Platform licensing API. Whoever signs in to the flow needs Power Automate Premium, and signs in to its connections once. Exports are optional, and they win for the months they cover.',
      csv: 'Upload the exports each month. No flow.',
    },
    export: {
      where: 'Power Platform admin center > Licensing > Products > Copilot Studio. Download the Summary, Environments and Agents exports (EntitlementConsumption*_MCSMessages*.csv).',
      url: 'https://admin.powerplatform.microsoft.com/',
      files: 'Up to three CSVs a month. A new file replaces the last one of the same kind.',
    },
  },
  {
    id: 'github',
    label: 'GitHub Copilot',
    description: 'GitHub Copilot AI credits by day, user and model, and who holds which seat.',
    modes: ['api', 'csv', 'skip'],
    defaultMode: 'skip',
    // Ingest_GitHub_API replaces Ingest_GitHub, so with the API a usage CSV would land where nothing reads it.
    uploadModes: ['csv'],
    page: '11–14. GHCP',
    group: USAGE_GROUP,
    modeLabels: { api: 'Connected (GitHub API)' },
    hints: {
      api: "Reads your enterprise's billing usage each day with a GitHub token, kept in Azure Key Vault or, with no Key Vault, in the notebook. An enterprise owner or billing manager creates the token.",
      csv: 'Upload the AI usage report each month, and a seat map when seats change.',
    },
    export: {
      where: 'GitHub: your enterprise > Billing and licensing > Usage > AI usage > Get usage report. The seat map is a CSV of username, UPN, display name and plan.',
      url: 'https://docs.github.com/billing',
      files: 'Usage reports add up: each is merged by day, user, model and repository. A new seat map replaces the last one.',
    },
  },
  {
    id: 'azureAi',
    label: 'Azure AI Foundry and Azure OpenAI',
    description: "Azure AI spend by day, resource and model, from Azure Cost Management, for one subscription. Also Copilot pay-as-you-go billed to Azure, from each billing policy's subscription.",
    modes: ['api', 'skip'],
    defaultMode: 'skip',
    page: '9–10.1. Azure',
    group: USAGE_GROUP,
    hints: {
      api: "Read each day with the installer's app registration, which needs Reader, Cost Management Reader and Monitoring Reader on the subscription. The installer gives them when you can assign Azure roles. A Power Platform admin's sign-in also finds the subscriptions that billing policies charge pay-as-you-go to.",
    },
  },
  {
    id: 'orgData',
    label: 'Org data',
    description: 'Department, cost centre, business unit and manager for each person. Without it, departments come from Viva Insights.',
    modes: ['api', 'csv', 'skip'],
    defaultMode: 'skip',
    // Only Ingest_Org reads an org file.
    uploadModes: ['csv'],
    group: CONTEXT_GROUP,
    modeLabels: { api: 'Connected (Microsoft Entra ID)' },
    hints: {
      api: 'Read each day from Microsoft Graph. The app registration needs User.Read.All, which an admin consents to.',
      csv: 'Upload a user list when it changes. No admin consent.',
    },
    export: {
      where: 'Microsoft Entra admin center > Users > All users > Download users, or any CSV with a UPN or email column and your org columns.',
      url: 'https://entra.microsoft.com',
      files: 'One CSV. Each upload replaces the last file, and the org table keeps the people from earlier ones.',
    },
  },
  {
    id: 'commercialTerms',
    label: 'Credit rate from Azure Cost Management',
    description: "Works out your effective Copilot credit rate from last month's Azure charges, instead of the rate you type in.",
    modes: ['api', 'skip'],
    defaultMode: 'skip',
    group: CONTEXT_GROUP,
    hints: {
      api: 'The installer runs the notebook once, as you, so your account needs Cost Management Reader on the billing scope. Run Ingest_CommercialTerms again from the workspace when your price changes.',
    },
  },
];

export const DATA_SOURCE_IDS = /** @type {DataSourceId[]} */ (DATA_SOURCES.map((s) => s.id));
export const MODE_LABELS = /** @type {Record<SourceMode, string>} */ ({ api: 'Connected (API)', csv: 'Upload CSV', skip: 'Skip' });

/** @param {DataSourceId} id */
export const dataSource = (id) => /** @type {DataSourceInfo} */ (DATA_SOURCES.find((s) => s.id === id));

/**
 * What a mode is called on this source's card.
 * @param {DataSourceInfo | DataSourceId} source
 * @param {SourceMode} mode
 */
export function modeLabel(source, mode) {
  const s = typeof source === 'string' ? dataSource(source) : source;
  return s?.modeLabels?.[mode] ?? MODE_LABELS[mode];
}

/**
 * How a recognised file is stored for its ingester.
 *  - append: kept alongside earlier uploads (the ingester unions and de-duplicates them)
 *  - replace: overwrites the one file the ingester reads
 *  - replaceKind: earlier files of the same kind are moved to `_loaded/` first
 *  - refuse: the router won't take it. The installer lands it itself, at `dir/name` (a Cowork task
 *    export and its PeopleMetaData.csv, which have to arrive together).
 * @typedef {'append' | 'replace' | 'replaceKind' | 'refuse'} UploadPolicy
 */

/**
 * @typedef {object} UploadKind
 * @property {string} kind
 * @property {DataSourceId} source
 * @property {string[][]} groups  Each group is a set of normalised header names; one from every group must be present.
 * @property {string} dir  Where the router puts it.
 * @property {string} name  File name. `{stamp}` becomes the upload time.
 * @property {UploadPolicy} policy
 * @property {string} [detail]  Why the router refuses it, and what to do instead.
 */

/** @type {UploadKind[]} */
export const UPLOAD_KINDS = [
  {
    kind: 'studioTenant',
    source: 'studioCredits',
    groups: [['billingplanid'], ['environmentid'], ['capacitytype'], ['prepaidconsumedquantity'], ['usagedate']],
    dir: STUDIO_DIR,
    name: 'EntitlementConsumptionTenantDetailsReport_MCSMessages_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioAgent',
    source: 'studioCredits',
    groups: [['agentid'], ['agentname'], ['billedcredit'], ['nonbilledcredit'], ['channel']],
    dir: STUDIO_DIR,
    name: 'EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioUser',
    source: 'studioCredits',
    groups: [['userid'], ['useremail'], ['creditsused'], ['billablecreditused']],
    dir: STUDIO_DIR,
    name: 'EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_{stamp}.csv',
    policy: 'replaceKind',
  },
  // Written each day by the Copilot Studio credits flow from the licensing API. Each file restates
  // the last ten days, so only the newest is kept; the notebook merges by day.
  {
    kind: 'studioAgentDaily',
    source: 'studioCredits',
    groups: [['usagedate'], ['agentid'], ['agentname'], ['billedcredit'], ['nonbilledcredit'], ['channel']],
    dir: STUDIO_DIR,
    name: 'StudioApiAgentDaily_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioUserDaily',
    source: 'studioCredits',
    groups: [['usagedate'], ['userid'], ['billedcredit'], ['nonbilledcredit'], ['unit']],
    dir: STUDIO_DIR,
    name: 'StudioApiUserDaily_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioEntitlement',
    source: 'studioCredits',
    groups: [['snapshotdate'], ['environmentid'], ['environmentallocated'], ['tenantprepaidconsumed'], ['tenantpaygconsumed']],
    dir: STUDIO_DIR,
    name: 'StudioApiEntitlement_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'vivaCredits',
    source: 'coworkCredits',
    groups: [['serviceid'], ['servicename'], ['spendingpolicyid'], ['metricdate'], ['totalcopilotcreditsused']],
    dir: VIVA_DIR,
    name: 'PersonServiceCreditsMetrics_{stamp}.csv',
    policy: 'append',
  },
  {
    kind: 'vivaPolicy',
    source: 'coworkCredits',
    groups: [['spendingpolicyid'], ['name'], ['planlimit'], ['userlimit'], ['includedservices']],
    dir: VIVA_DIR,
    name: 'SpendingPolicyMetadata_{stamp}.csv',
    policy: 'replaceKind',
  },
  // Ingest_Viva_Consumption reads a task export with the PeopleMetaData.csv in its own folder, and
  // fails when two landed exports restate a week differently. So one pair at a time, at fixed names.
  {
    kind: 'coworkTasks',
    source: 'coworkTasks',
    groups: [['personid', 'userprincipalname', 'upn'], ['metricdate'], ['totalcoworktasks', 'taskcount']],
    dir: COWORK_TASKS_DIR,
    name: 'CoworkWeeklyMetrics.csv',
    policy: 'refuse',
    detail: PAIR_DETAIL,
  },
  {
    kind: 'coworkPeople',
    source: 'coworkTasks',
    groups: [['peoplehistoricalid'], ['organization', 'organisation'], ['iscopilotlicensed', 'functiontype']],
    dir: COWORK_TASKS_DIR,
    name: 'PeopleMetaData.csv',
    policy: 'refuse',
    detail: PAIR_DETAIL,
  },
  // Ingest_GitHub reads every *usage*.csv and *map*.csv in its folder, and needs all of these columns.
  {
    kind: 'githubUsage',
    source: 'github',
    groups: [
      ['date', 'usagedate'], ['username'], ['product'], ['sku'], ['model'], ['quantity'], ['unittype'],
      ['appliedcostperquantity'], ['grossamount'], ['discountamount'], ['netamount'], ['organization'],
      ['repository'], ['costcentername'],
    ],
    dir: GITHUB_DIR,
    name: 'GitHubUsage_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'githubMap',
    source: 'github',
    groups: [['username'], ['userprincipalname', 'upn', 'email'], ['displayname', 'name'], ['plan']],
    dir: GITHUB_DIR,
    name: 'GitHubUserMap_{stamp}.csv',
    policy: 'replaceKind',
  },
  // A person key and at least one of the org columns Ingest_Org reads. A display name alone doesn't
  // count: a replaced org file is gone from the folder, and a list of names shouldn't replace it.
  {
    kind: 'orgFile',
    source: 'orgData',
    groups: [
      ['userprincipalname', 'upn', 'userprincipal', 'email', 'mail', 'emailaddress', 'personid'],
      ['department', 'dept', 'organisation', 'organization', 'jobtitle', 'title', 'role', 'jobfamily', 'function',
        'functiontype', 'jobfunction', 'city', 'officelocation', 'location', 'country', 'countryorregion', 'region',
        'costcenter', 'costcentre', 'manager', 'managername', 'supervisor', 'managerid', 'managerupn',
        'businessunit', 'division', 'segment'],
    ],
    dir: ORG_DIR,
    name: 'OrgData_{stamp}.csv',
    policy: 'replaceKind',
  },
];

/** Sources a CSV can be uploaded for. */
export const UPLOADABLE_SOURCES = /** @type {DataSourceId[]} */ ([...new Set(UPLOAD_KINDS.map((k) => k.source))]);

/** @param {string} kind */
export const uploadKind = (kind) => UPLOAD_KINDS.find((k) => k.kind === kind);

/** The installer, not the router, lands this kind. @param {UploadKind | undefined} kind */
export const landsDirect = (kind) => kind?.policy === 'refuse';

/**
 * Header name as the router compares it: lower case, letters and digits only.
 * @param {string} name
 */
export const normHeader = (name) => String(name).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The first record of a CSV: quoted fields, embedded commas and quotes, a BOM and CRLF all handled.
 * @param {string} text
 * @returns {string[]}
 */
export function parseCsvHeader(text) {
  const s = text.replace(/^\uFEFF/, '');
  const end = s.search(/[\r\n]/);
  const line1 = end === -1 ? s : s.slice(0, end);
  const delimiter = [',', ';', '\t'].map((d) => [d, line1.split(d).length]).sort((a, b) => Number(b[1]) - Number(a[1]))[0][0];
  /** @type {string[]} */
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      fields.push(field.trim());
      field = '';
    } else if (ch === '\r' || ch === '\n') break;
    else field += ch;
  }
  fields.push(field.trim());
  return fields.length === 1 && fields[0] === '' ? [] : fields;
}

/**
 * Text of the start of a file, decoded from UTF-8 or, for some Excel saves, UTF-16.
 * @param {Uint8Array} bytes
 */
export function decodeStart(bytes) {
  const head = bytes.subarray(0, 64 * 1024);
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(head.subarray(2));
  return new TextDecoder('utf-8').decode(head);
}

/**
 * @typedef {{ ok: true, kind: UploadKind, source: DataSourceId, headers: string[] }
 *   | { ok: false, reason: string, headers: string[] }} Detection
 */

/**
 * Which source a CSV is from, by its headers. The kind matching the most groups wins; a tie is ambiguous.
 * A kind the router refuses is still recognised here: the installer lands those itself.
 * @param {string[]} headers
 * @param {Iterable<DataSourceId>} [enabled]  Sources that take uploads as they're set. Others are recognised but refused.
 * @returns {Detection}
 */
export function detectSource(headers, enabled) {
  const have = new Set(headers.map(normHeader));
  if (!have.size) return { ok: false, reason: 'The file has no header row.', headers };
  const scored = UPLOAD_KINDS
    .filter((k) => k.groups.every((g) => g.some((h) => have.has(h))))
    .map((k) => ({ k, score: k.groups.length }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { ok: false, reason: `It doesn't look like any export Consumption Central reads. ${expectedHint()}`, headers };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { ok: false, reason: `It matches more than one export (${scored.filter((s) => s.score === scored[0].score).map((s) => s.k.kind).join(', ')}).`, headers };
  }
  const kind = scored[0].k;
  const on = enabled ? new Set(enabled) : undefined;
  if (on && !on.has(kind.source)) {
    const label = dataSource(kind.source).label;
    return { ok: false, reason: `It's ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} export, but that source isn't set to Upload CSV.`, headers };
  }
  return { ok: true, kind, source: kind.source, headers };
}

function expectedHint() {
  return "Expected one of: Viva credits or spending policies, a Cowork task export with its PeopleMetaData.csv, Copilot Studio credits (PPAC exports or the Studio flow's files), a GitHub usage report or seat map, or an org file.";
}

/**
 * Reads a CSV's header and recognises it.
 * @param {Uint8Array} bytes
 * @param {Iterable<DataSourceId>} [enabled]
 */
export function detectFile(bytes, enabled) {
  return detectSource(parseCsvHeader(decodeStart(bytes)), enabled);
}

/** Why a PeopleMetaData.csv can't go on its own. */
export const PEOPLE_ALONE =
  "It's a PeopleMetaData.csv, which is only read with the Cowork task export it came with (CoworkWeeklyMetrics.csv). Upload the two together. Credits exports don't use it.";

/**
 * Checks the Cowork task files among the uploads: one export at a time, each with at most one
 * PeopleMetaData.csv, and no PeopleMetaData.csv on its own. The PeopleMetaData.csv goes first, so a
 * run that starts between the two never reads the new export with the last one's people.
 * @template {{ name: string, kind: string }} F
 * @param {F[]} files
 * @param {{ partial?: boolean }} [o]  Files are still being added: a PeopleMetaData.csv may come before its export.
 * @returns {{ ok: true, files: F[] } | { ok: false, error: string }}
 */
export function pairTaskExports(files, o = {}) {
  const tasks = files.filter((f) => f.kind === 'coworkTasks');
  const people = files.filter((f) => f.kind === 'coworkPeople');
  if (tasks.length > 1) {
    return { ok: false, error: `${tasks.map((f) => f.name).join(', ')}: upload one Cowork task export at a time. Each replaces the last, so load one before adding the next.` };
  }
  if (people.length > 1) return { ok: false, error: `${people.map((f) => f.name).join(', ')}: a Cowork task export has one PeopleMetaData.csv.` };
  if (people.length && !tasks.length && !o.partial) return { ok: false, error: `${people[0].name}: ${PEOPLE_ALONE}` };
  return { ok: true, files: [...files.filter((f) => !tasks.includes(f) && !people.includes(f)), ...people, ...tasks] };
}

/**
 * Checks a set of uploads before any goes. Two files of one kind that replaces the last would load
 * only one, because the router retires the older before the run reads it. Cowork task exports go a
 * pair at a time (pairTaskExports).
 * @template {{ name: string, kind: string }} F
 * @param {F[]} files
 * @param {{ partial?: boolean }} [o]
 * @returns {{ ok: true, files: F[] } | { ok: false, error: string }}
 */
export function checkUploadSet(files, o = {}) {
  for (const k of UPLOAD_KINDS.filter((x) => x.policy === 'replaceKind')) {
    const same = files.filter((f) => f.kind === k.kind);
    if (same.length > 1) {
      return {
        ok: false,
        error: `${same.map((f) => f.name).join(', ')}: these are the same ${dataSource(k.source).label} export, and each replaces the last before the run reads it. Upload the newest, or load one before adding the next.`,
      };
    }
  }
  return pairTaskExports(files, o);
}

/** @returns {DataSourceModes} */
export function defaultDataSources() {
  return /** @type {DataSourceModes} */ (Object.fromEntries(DATA_SOURCES.map((s) => [s.id, s.defaultMode])));
}

/**
 * Fills the gaps in a saved choice, and reads a saved CSV choice with its flow as the api mode.
 * @param {Partial<Record<string, string>> | undefined} saved
 * @param {{ studioFlow?: boolean }} [uploads]
 * @returns {DataSourceModes}
 */
export function normaliseDataSources(saved, uploads = {}) {
  const out = defaultDataSources();
  for (const s of DATA_SOURCES) {
    const v = /** @type {SourceMode | undefined} */ (saved?.[s.id]);
    if (v && s.modes.includes(v)) out[s.id] = v;
    if (s.locked) out[s.id] = s.modes[0];
  }
  if (saved && out.studioCredits === 'csv' && uploads.studioFlow) out.studioCredits = 'api';
  return out;
}

/**
 * The modes in which a source's CSVs are taken.
 * @param {DataSourceInfo} s
 */
export const uploadModesOf = (s) => s.uploadModes ?? s.modes.filter((m) => m !== 'skip');

/**
 * Sources that take an uploaded CSV as they're set. The Studio flow and the Viva Dataflow still take
 * exports, which win for the periods they cover; GitHub and org data on their APIs don't, because
 * the notebook that reads the CSV isn't deployed then.
 * @param {DataSourceModes} ds
 * @returns {DataSourceId[]}
 */
export const routedSources = (ds) => UPLOADABLE_SOURCES.filter((id) => uploadModesOf(dataSource(id)).includes(ds[id]));

/**
 * Routed sources with a kind the router takes. Cowork task exports alone don't need the router.
 * @param {DataSourceModes} ds
 */
export const routerSources = (ds) => routedSources(ds).filter((id) => UPLOAD_KINDS.some((k) => k.source === id && !landsDirect(k)));

/** The router is deployed when a source it takes arrives as a CSV. */
export const routerWanted = (/** @type {DataSourceModes} */ ds) => routerSources(ds).length > 0;

/**
 * The signatures the router notebook reads, as one line of JSON. Kinds it refuses are in it too,
 * so a dropped Cowork task export is refused with the reason rather than as an unknown file.
 * @param {DataSourceModes} [ds]  When given, only the kinds of routed sources.
 */
export function routerSignaturesJson(ds) {
  const on = ds ? new Set(routedSources(ds)) : undefined;
  return JSON.stringify(
    UPLOAD_KINDS.filter((k) => !on || on.has(k.source)).map((k) => ({
      kind: k.kind,
      source: k.source,
      groups: k.groups,
      dir: k.dir,
      name: k.name,
      policy: k.policy,
      ...(k.detail ? { detail: k.detail } : {}),
    })),
  );
}

/**
 * @typedef {object} SourceCard  One card on the Data sources screen.
 * @property {DataSourceId} id
 * @property {string} label
 * @property {string} description
 * @property {{ value: SourceMode, label: string, hint?: string }[]} modes
 * @property {SourceMode} mode
 * @property {boolean} locked
 * @property {boolean} uploadable  A CSV can be uploaded for it.
 * @property {SourceMode[]} uploadModes  The modes in which it takes one.
 * @property {string} [page]
 * @property {{ where: string, url: string, files: string }} [export]
 * @property {SourceMode[]} [exportModes]  The modes that still need the export.
 * @property {string} [group]
 */

/**
 * The Data sources screen's cards, each set to its current mode.
 * @param {DataSourceModes} ds
 * @returns {SourceCard[]}
 */
export function sourceCards(ds) {
  return DATA_SOURCES.map((s) => {
    const uploadable = UPLOADABLE_SOURCES.includes(s.id);
    return {
      id: s.id,
      label: s.label,
      description: s.description,
      modes: s.modes.map((m) => ({ value: m, label: modeLabel(s, m), ...(s.hints?.[m] ? { hint: s.hints[m] } : {}) })),
      mode: s.modes.includes(ds[s.id]) ? ds[s.id] : s.defaultMode,
      locked: !!s.locked,
      uploadable,
      uploadModes: uploadable ? uploadModesOf(s) : [],
      ...(s.page ? { page: s.page } : {}),
      ...(s.group ? { group: s.group } : {}),
      ...(s.export ? { export: s.export, exportModes: exportModesOf(s) } : {}),
    };
  });
}

/**
 * The modes of a source that still need its export: csv, and for Cowork credits the Dataflow too,
 * because spending policies only come from the export.
 * @param {DataSourceInfo} s
 */
export const exportModesOf = (s) => (s.export ? s.exportModes ?? ['csv'] : []);

/**
 * Checks the modes a Data sources answer gives: every source has one of its own, locked ones unchanged.
 * @param {unknown} raw
 * @param {DataSourceModes} current
 * @returns {{ modes: DataSourceModes } | { error: string }}
 */
export function parseModes(raw, current) {
  if (!raw || typeof raw !== 'object') return { error: 'Choose how each source arrives.' };
  const given = /** @type {Record<string, unknown>} */ (raw);
  const modes = /** @type {DataSourceModes} */ ({ ...current });
  for (const s of DATA_SOURCES) {
    const v = given[s.id];
    if (v === undefined) continue;
    if (s.locked && v !== current[s.id]) return { error: `${s.label} can't be changed.` };
    if (!s.modes.includes(/** @type {SourceMode} */ (v))) return { error: `${s.label} can be ${s.modes.map((m) => modeLabel(s, m)).join(' or ')}.` };
    modes[s.id] = /** @type {SourceMode} */ (v);
  }
  return { modes };
}

/**
 * One line per source for a summary: "GitHub Copilot: Upload CSV".
 * @param {DataSourceModes} ds
 */
export const describeSources = (ds) => DATA_SOURCES.filter((s) => !s.locked).map((s) => `${s.label}: ${modeLabel(s, ds[s.id])}`);

/**
 * A name for an upload that won't collide with an earlier one: a UTC stamp, then the original
 * name with anything OneLake or Spark dislikes replaced.
 * @param {string} original
 * @param {Date} [now]
 */
export function uploadName(original, now = new Date()) {
  const base = original.split(/[\\/]/).pop() ?? 'upload.csv';
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'upload.csv';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}_${/\.csv$/i.test(clean) ? clean : `${clean}.csv`}`;
}

/** Other names `--data` accepts for a mode, e.g. studioCredits=flow for its Power Automate flow. */
export const MODE_ALIASES = /** @type {Partial<Record<DataSourceId, Record<string, SourceMode>>>} */ ({
  studioCredits: { flow: 'api' },
  coworkCredits: { dataflow: 'api' },
  github: { token: 'api' },
});

/**
 * Parses `--data` flags: `source=mode`, comma-separated or repeated.
 * @param {string[]} values
 * @returns {Partial<DataSourceModes>}
 */
export function parseDataFlags(values) {
  /** @type {Partial<DataSourceModes>} */
  const out = {};
  for (const part of values.flatMap((v) => v.split(','))) {
    const [rawId, rawMode] = part.split('=').map((x) => x?.trim());
    const s = DATA_SOURCES.find((d) => d.id.toLowerCase() === (rawId ?? '').toLowerCase());
    if (!s) throw new Error(`--data: unknown source "${rawId}". Use one of ${DATA_SOURCE_IDS.join(', ')}.`);
    const given = (rawMode ?? '').toLowerCase();
    const mode = /** @type {SourceMode} */ (MODE_ALIASES[s.id]?.[given] ?? given);
    if (!s.modes.includes(mode)) {
      const aliases = Object.keys(MODE_ALIASES[s.id] ?? {});
      throw new Error(`--data: ${s.id} can be ${[...s.modes, ...aliases].join(' or ')}, not "${rawMode ?? ''}".`);
    }
    out[s.id] = mode;
  }
  return out;
}
