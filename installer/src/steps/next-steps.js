// @ts-check
/**
 * What's left once the installer finishes, as cards for the Done page and the terminal summary:
 * the steps the user does, then hand-offs, each with a message to copy and send to the admin who does it.
 * One list, in the order it should be done, so new steps only need adding here.
 */
import { commandLine } from '../launch.js';
import { isVivaId } from '../transform/dataflow.js';
import { COWORK_DATAFLOW_ACTIVITY, GITHUB_ACTIVITY } from '../transform/pipeline.js';
import { myGroupsUrl, shareReportPending, shareReportSteps, VIEWER_GROUP_NAME } from './access.js';
import { COWORK_DATAFLOW_NAME, coworkSignInSteps, DATAFLOW_GUIDE } from './consumption.js';
import { coworkDataflowOn } from './fabric.js';
import { connectionSteps, FLOW_NAMES, flowsWanted } from './flows.js';
import { GITHUB_TOKEN_SCOPES, NEW_TOKEN_URL, TOKEN_WARN_DAYS, TOKENS_URL } from './github.js';
import { reportUrl } from './report.js';

/**
 * @typedef {object} NextStep
 * @property {string} id  Stable, e.g. "flows".
 * @property {string} title
 * @property {string} why  Why it matters, in a sentence or two.
 * @property {string} who  Who does it, e.g. "You" or "A Microsoft 365 admin".
 * @property {string} [link]
 * @property {string} [linkText]
 * @property {string[]} [steps]  One whole step each, to show numbered.
 * @property {string} [message]  For a hand-off: a message to copy and send to whoever does it.
 * @property {string} [activity]  The pipeline activity that fails until it's done. That failure is expected.
 * @property {boolean} [optional]
 */

const MAKER = 'https://make.powerautomate.com/';
const DAY_MS = 86_400_000;

/**
 * A message to someone else: a greeting, the ask, the details, and a sign-off.
 * @param {string[]} body
 * @param {string | undefined} from
 */
const letter = (body, from) => ['Hi,', '', ...body, '', 'Thanks', ...(from ? [from] : [])].join('\n');

/** @param {string[]} steps */
const numbered = (steps) => steps.map((s, i) => `${i + 1}. ${s}`);

/**
 * The cards, in the order to do them: share the report, replace an expiring GitHub token, sign in to
 * the flows and the Cowork Dataflow, then hand-offs to other admins. Empty when nothing is left.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @param {{ now?: Date }} [opts]  now: for the token's expiry, so tests can fix the date.
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}, opts = {}) {
  return [
    shareReportStep(config),
    githubTokenStep(config, opts.now ?? new Date()),
    flowsStep(config, user),
    coworkStep(config),
    vivaQueryStep(config, user),
  ].filter(/** @returns {s is NextStep} */ (s) => !!s);
}

/**
 * "2 steps left", "1 step left, and 1 optional".
 * @param {NextStep[]} steps
 */
export function stepsLeftTitle(steps) {
  const needed = steps.filter((s) => !s.optional).length;
  const optional = steps.length - needed;
  if (!needed) return `${optional} optional ${optional === 1 ? 'step' : 'steps'}`;
  return `${needed} ${needed === 1 ? 'step' : 'steps'} left${optional ? `, and ${optional} optional` : ''}`;
}

/**
 * The report, shared with the viewer group once. The group's Build on the model comes from the API,
 * but Power BI has no API for sharing the report with it, so it's a few clicks.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function shareReportStep(config) {
  if (!shareReportPending(config)) return null;
  const a = config.access;
  const group = a?.groupName ?? VIEWER_GROUP_NAME;
  const ws = config.fabric.workspaceId;
  const id = config.semanticModel.report?.id;
  return {
    id: 'share-report',
    title: `Share the report with ${group}`,
    why: `Once only. Until it's shared, people in the group get "no access" when they open the report. After that, give people access by adding them to the group${a?.groupId ? ` (${myGroupsUrl(a.groupId)})` : ''}.`,
    who: 'You',
    ...(ws && id ? { link: reportUrl(ws, id), linkText: 'Open the report' } : {}),
    steps: shareReportSteps(config),
  };
}

/**
 * The GitHub token, when it has expired or expires within TOKEN_WARN_DAYS. GitHub doesn't renew a
 * token: someone makes a new one, and github-token puts it in place.
 * @param {import('../config.js').InstallConfig} config
 * @param {Date} now
 * @returns {NextStep | null}
 */
function githubTokenStep(config, now) {
  const gh = config.github;
  if (config.dataSources?.github !== 'api' || !gh?.tokenExpires) return null;
  const left = Date.parse(gh.tokenExpires) - now.getTime();
  if (!(left <= TOKEN_WARN_DAYS * DAY_MS)) return null;
  const expired = left <= 0;
  return {
    id: 'github-token',
    title: expired ? 'Replace the expired GitHub token' : 'Replace the GitHub token',
    why: expired
      ? "Ingest_GitHub_API reads Copilot billing with it, and GitHub data stops loading until it's replaced."
      : `It expires ${gh.tokenExpires.slice(0, 10)}, and Ingest_GitHub_API reads Copilot billing with it.`,
    who: 'You, with a token made by an owner or billing manager of the enterprise',
    link: NEW_TOKEN_URL,
    linkText: 'Create a classic token',
    steps: [
      `Create a classic token with scope ${GITHUB_TOKEN_SCOPES}.`,
      `Run "${commandLine('github-token')}" and paste it.`,
      `Revoke the old one at ${TOKENS_URL}.`,
    ],
    ...(expired ? { activity: GITHUB_ACTIVITY } : {}),
  };
}

/**
 * The flows the installer made or wrote out, which someone signs in to and turns on.
 * Doubles as the hand-off to a Power Platform admin.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function flowsStep(config, user) {
  const up = config.uploads;
  const kinds = flowsWanted(config).filter((k) => up?.flowIds?.[k] || up?.flowFiles?.[k]);
  if (!kinds.length) return null;
  const env = up.flowEnvironment;
  const link = env?.id ? `${MAKER}environments/${env.id}/flows` : MAKER;
  const where = env?.name ?? env?.url ?? 'the Power Automate environment';
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  const details = [];
  for (const kind of kinds) {
    const name = FLOW_NAMES[kind];
    const file = up.flowFiles?.[kind];
    const open = file ? `Import ${name} from ${file} into ${where}` : `Open ${name} in ${where}`;
    const signIns = connectionSteps(config, kind);
    steps.push(`${open}, sign in to its connections, save it and turn it on.`);
    details.push(`${name}${file ? ` (to import: ${file})` : ''}:`, ...numbered([open + '.', ...signIns, 'Save, then turn it on.']).map((s) => `  ${s}`), '');
  }
  const one = kinds.length === 1;
  return {
    id: 'flows',
    title: `Sign in to the Power Automate ${one ? 'flow' : 'flows'}`,
    why: `${one ? 'It stays' : 'They stay'} off until ${one ? 'its' : 'their'} connections are signed in, so ${one ? 'its data doesn\'t' : 'their data doesn\'t'} load.`,
    who: 'You, or a Power Platform administrator',
    link,
    linkText: 'Open Power Automate',
    steps,
    message: letter(
      [
        `Could you sign in to the connections of the Consumption Central ${one ? 'flow' : 'flows'} in Power Automate and turn ${one ? 'it' : 'them'} on? ${one ? 'It is' : 'They are'} in ${where}: ${link}`,
        '',
        ...details,
        'Signing in with a dedicated admin account and adding a co-owner keeps the flows running if people move on.',
      ],
      user.upn,
    ),
  };
}

/**
 * The Cowork credits Dataflow, which refreshes only once it has its sign-ins. Until then the
 * pipeline's Dataflow refresh fails, which is expected.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function coworkStep(config) {
  if (!coworkDataflowOn(config)) return null;
  const name = config.consumption.dataflowName ?? COWORK_DATAFLOW_NAME;
  const ws = config.fabric.workspaceId;
  return {
    id: 'cowork-dataflow',
    title: `Sign in to the Dataflow ${name}`,
    why: 'Cowork credits load once the Dataflow has its sign-ins. Until then the first load skips it and scheduled runs fail at that step, which is expected: everything else loads.',
    who: 'You',
    ...(ws ? { link: `https://app.fabric.microsoft.com/groups/${ws}`, linkText: 'Open the workspace' } : {}),
    steps: coworkSignInSteps(config),
    activity: COWORK_DATAFLOW_ACTIVITY,
  };
}

/**
 * A Viva Insights query for Cowork credits, so a Dataflow reads them on every run rather than
 * someone uploading the export. Optional: the CSV export works too.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function vivaQueryStep(config, user) {
  const cc = config.consumption;
  if (config.dataSources?.coworkCredits !== 'csv') return null;
  if (isVivaId(cc?.vivaPartition) && isVivaId(cc?.vivaQuery)) return null;
  const steps = [
    'In Viva Insights > Create analysis > Create custom query, choose Consumption query and keep the preselected credit metrics.',
    'Turn on Auto-refresh, and run it.',
    'In Analysis results, choose the link icon next to it and copy the partition ID and the query ID.',
  ];
  return {
    id: 'viva-query',
    title: 'Ask a Viva Insights analyst for the Cowork credits query',
    why: 'Optional. With it, a Dataflow reads Cowork credits on every run, rather than someone uploading the Consumption Dashboard export. Then run the installer again and choose Connected (Dataflow) for Cowork credits.',
    who: 'A Viva Insights analyst',
    link: DATAFLOW_GUIDE,
    linkText: 'The guide',
    steps,
    optional: true,
    message: letter(
      [
        'Could you set up a Viva Insights query for Consumption Central? It reads Copilot Cowork credits from it every day.',
        '',
        ...numbered(steps),
        '',
        'Then send me the partition ID and the query ID. They look like 00000000-0000-0000-0000-000000000000.',
        `Guide: ${DATAFLOW_GUIDE}`,
      ],
      user.upn,
    ),
  };
}
