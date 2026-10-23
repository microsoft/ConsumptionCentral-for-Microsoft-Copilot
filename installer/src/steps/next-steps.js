// @ts-check
/**
 * What's left once the installer finishes, as cards for the Done page and the terminal summary:
 * the steps the user does, then hand-offs, each with a message to copy and send to the admin who does it.
 * One list, in the order it should be done, so new steps only need adding here.
 */
import { FEEDBACK_SUBJECT } from '../transform/flows.js';
import { isVivaId } from '../transform/dataflow.js';
import { COWORK_DATAFLOW_ACTIVITY } from '../transform/pipeline.js';
import { COWORK_DATAFLOW_NAME, coworkSignInSteps, DATAFLOW_GUIDE } from './consumption.js';
import { coworkDataflowOn } from './fabric.js';
import { connectionSteps, FLOW_NAMES, flowsWanted } from './flows.js';

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

export const M365_ADMIN_URL = 'https://admin.microsoft.com/';
const MAKER = 'https://make.powerautomate.com/';

/**
 * A message to someone else: a greeting, the ask, the details, and a sign-off.
 * @param {string[]} body
 * @param {string | undefined} from
 */
const letter = (body, from) => ['Hi,', '', ...body, '', 'Thanks', ...(from ? [from] : [])].join('\n');

/** @param {string[]} steps */
const numbered = (steps) => steps.map((s, i) => `${i + 1}. ${s}`);

/**
 * The cards, in the order to do them: sign in to the flows and the Cowork Dataflow, then hand-offs to
 * other admins. Empty when nothing is left.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}) {
  return [
    flowsStep(config, user),
    coworkStep(config),
    vivaQueryStep(config, user),
    m365ExportStep(config, user),
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
        `Could you sign in to the connections of the Analytics Hub ${one ? 'flow' : 'flows'} in Power Automate and turn ${one ? 'it' : 'them'} on? ${one ? 'It is' : 'They are'} in ${where}: ${link}`,
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
  if (!config.modules.consumption || config.dataSources?.coworkCredits !== 'csv') return null;
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
        'Could you set up a Viva Insights query for Analytics Hub? It reads Copilot Cowork credits from it every day.',
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

/**
 * The emailed product feedback export the feedback flow saves. Only a Microsoft 365 admin can schedule it.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function m365ExportStep(config, user) {
  if (!flowsWanted(config).includes('feedback')) return null;
  const mailbox = user.upn ?? 'the mailbox the flow reads';
  const steps = [
    'In the Microsoft 365 admin center, open Health > Product feedback.',
    `Choose Export and schedule it to be emailed to ${mailbox}, with the subject "${FEEDBACK_SUBJECT}".`,
  ];
  return {
    id: 'm365-export',
    title: 'Ask for the product feedback export',
    why: `The ${FLOW_NAMES.feedback} flow saves the export when it arrives by email. Without it, product feedback has no data. If the flow's Outlook connection signs in as another mailbox, use that one.`,
    who: 'A Microsoft 365 admin',
    link: M365_ADMIN_URL,
    linkText: 'Microsoft 365 admin center',
    steps,
    message: letter(
      [
        'Could you schedule the Microsoft 365 product feedback export for Analytics Hub? A flow saves it when it arrives by email.',
        '',
        ...numbered(steps),
        `The subject must be exactly "${FEEDBACK_SUBJECT}", so the flow picks it up.`,
      ],
      user.upn,
    ),
  };
}
