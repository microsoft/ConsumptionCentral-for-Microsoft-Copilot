// @ts-check
/**
 * What's left once the installer finishes, as cards for the Done page and the terminal summary:
 * the steps the user does, then hand-offs, each with a message to copy and send to the admin who does it.
 * One list, in the order it should be done, so new steps only need adding here.
 */
import { commandLine } from '../launch.js';
import { ADMIN_STEPS, deployAgain, LINKS } from '../managed-app/errors.js';
import { PRODUCT, REPO_URL } from '../product.js';
import { appName, isPax } from '../target.js';
import { isVivaId } from '../transform/dataflow.js';
import { COWORK_DATAFLOW_ACTIVITY, GITHUB_ACTIVITY } from '../transform/pipeline.js';
import { myGroupsUrl, PRO_VIEWERS, shareReportPending, shareReportSteps, VIEWER_GROUP_NAME } from './access.js';
import { COWORK_DATAFLOW_NAME, coworkSignInSteps, DATAFLOW_GUIDE } from './consumption.js';
import { coworkDataflowOn } from './fabric.js';
import { connectionSteps, FLOW_NAMES, flowsWanted } from './flows.js';
import { GITHUB_TOKEN_SCOPES, NEW_TOKEN_URL, TOKEN_WARN_DAYS, TOKENS_URL } from './github.js';
import { modelSettingsUrl } from './model.js';
import { SEED_DAYS, userInfoMode } from './pax/local.js';
import { credentialSteps, desktopSteps } from './pax/publish.js';
import { pnpGrantCommand, SITE_ADMIN, siteGrantCommands, siteRemovalCommands } from './pax/site.js';
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
export const AUDIT_URL = 'https://learn.microsoft.com/purview/audit-log-enable-disable';
export const DESKTOP_URL = 'https://learn.microsoft.com/power-bi/fundamentals/desktop-get-the-desktop';

/**
 * A message to someone else: a greeting, the ask, the details, and a sign-off.
 * @param {string[]} body
 * @param {string | undefined} from
 */
const letter = (body, from) => ['Hi,', '', ...body, '', 'Thanks', ...(from ? [from] : [])].join('\n');

/** @param {string[]} steps */
const numbered = (steps) => steps.map((s, i) => `${i + 1}. ${s}`);

/**
 * The cards, in the order to do them, for the install's route. Fabric: share the report, replace an
 * expiring GitHub token, sign in to the flows and the Cowork Dataflow, then hand-offs to other
 * admins. PAX + SharePoint: the site, the first refresh, the report and its sign-ins, the app, the
 * Viva Insights query, then the scheduled task. Empty when nothing is left.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @param {{ now?: Date }} [opts]  now: for the token's expiry, so tests can fix the date.
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}, opts = {}) {
  const steps = isPax(config)
    ? [
        siteGrantStep(config, user),
        firstRefreshStep(config),
        desktopPublishStep(config),
        modelCredentialsStep(config),
        shareReportStep(config),
        appSettingsStep(config, user),
        appSkippedStep(config),
        vivaConnectorStep(config, user),
        taskLogonStep(config),
        retiredGrantsStep(config, user),
      ]
    : [
        shareReportStep(config),
        githubTokenStep(config, opts.now ?? new Date()),
        flowsStep(config, user),
        coworkStep(config),
        vivaQueryStep(config, user),
      ];
  return steps.filter(/** @returns {s is NextStep} */ (s) => !!s);
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

/** The step-by-step for building the Viva Insights query. */
export const VIVA_QUERY_GUIDE = `${REPO_URL}/blob/main/docs/VIVA-QUERY.md`;

/** The app registration's name, as the record has it. @param {import('../config.js').InstallConfig} config */
const appLabel = (config) => config.app?.displayName ?? appName(config);

/**
 * The PAX route: whether the record has the Viva Insights query the Viva Direct report reads Cowork
 * credits through.
 * @param {import('../config.js').InstallConfig} config
 */
const vivaOn = (config) => isVivaId(config.consumption?.vivaPartition) && isVivaId(config.consumption?.vivaQuery);

const VIVA_ANALYST = 'a Viva Insights analyst: someone who can open the query in Viva Insights';
const VIVA_SIGN_IN = `Sign Viva Insights in the same way, as ${VIVA_ANALYST}.`;

/**
 * The PAX route: the app's write access to the folder's site, which only a SharePoint Administrator
 * or Global Administrator can give (Sites.Selected). Until then the refresh has nowhere to write.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function siteGrantStep(config, user) {
  const sp = config.sharePoint;
  const appId = config.app?.appId;
  if (!sp?.pendingAdminGrant || !appId) return null;
  const app = appLabel(config);
  const orgFile = userInfoMode();
  return {
    id: 'site-grant',
    title: 'Ask for the app\'s access to the SharePoint site',
    why: orgFile
      ? `The daily refresh signs in as "${app}", which can write only to sites an administrator gives it (Sites.Selected). Until it has ${sp.siteUrl}, the org file can't reach the folder, and the report has no department breakdowns. Once it's given, run ${commandLine('run')}.`
      : `The daily refresh signs in as "${app}", which can write only to sites an administrator gives it (Sites.Selected). Until it has ${sp.siteUrl}, no files reach the folder and the report has no data. Once it's given, run ${commandLine('run')}.`,
    who: SITE_ADMIN,
    steps: [
      'Open PowerShell 7 and run the commands in the message. They give the app write access to this one site, and no other.',
      'Or, with PnP PowerShell, run the command at the end of the message.',
    ],
    message: letter(
      [
        orgFile
          ? `Could you give our app "${app}" write access to one SharePoint site? Each day it writes the ${PRODUCT.name} report's org file, a list of our users and their departments, to a folder there. It has the Sites.Selected permission, so it can write only to the sites it's given.`
          : `Could you give our app "${app}" write access to one SharePoint site? It refreshes the ${PRODUCT.name} report's Copilot usage data into a folder there each day. It has the Sites.Selected permission, so it can write only to the sites it's given.`,
        '',
        `App: ${app}`,
        `Application (client) ID: ${appId}`,
        `Site: ${sp.siteUrl}`,
        '',
        'In PowerShell 7, as a SharePoint Administrator or Global Administrator:',
        ...siteGrantCommands(config),
        '',
        'Or, with PnP PowerShell:',
        pnpGrantCommand(config),
      ],
      user.upn,
    ),
  };
}

/**
 * The PAX route: the first refresh, while it runs, and how it ended when it didn't succeed. It's
 * cleared once a refresh succeeds. Consumption Central's refresh exports only the org file, so it
 * never finds "no Copilot activity": that's the audit log's.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function firstRefreshStep(config) {
  const first = config.pax?.firstRun;
  if (!first) return null;
  const orgFile = userInfoMode();
  const days = config.pax?.seedDays ?? SEED_DAYS;
  const run = commandLine('run');
  const status = commandLine('status');
  if (first.result === 'failed') {
    return {
      id: 'first-refresh',
      title: 'Fix the first refresh',
      why: orgFile
        ? `The first refresh failed${first.error ? `: ${first.error}` : '.'} Until one succeeds, the folder has no org file, and the report has no department breakdowns.`
        : `The first refresh failed${first.error ? `: ${first.error}` : '.'} Until one succeeds, the folder has no files and the report has no data.`,
      who: 'You',
      steps: [
        first.log ? `Read its log: ${first.log}` : `Read its log, in the logs folder under ${config.pax?.workRoot ?? 'the refresh\'s folder'}.`,
        'Fix what it says. If an administrator has to, send them the error.',
        `Run ${run} to start it again, then ${status} to see how it went.`,
      ],
    };
  }
  if (first.result === 'no-data' && !orgFile) {
    return {
      id: 'first-refresh',
      title: 'Check Copilot activity is audited',
      why: `The first refresh found no Copilot activity in the last ${days} days, so the report is empty. Either nobody used Copilot then, or auditing is off. Each daily refresh looks again.`,
      who: 'You, or a Microsoft Purview administrator',
      link: AUDIT_URL,
      linkText: 'Turn auditing on or off',
      steps: [
        'In the Microsoft Purview portal, open Audit. If it offers to start recording user and admin activity, auditing is off: turn it on. New activity is then audited from that point.',
        'Check that people have Microsoft 365 Copilot licences and have used Copilot.',
        `Run ${run} to look again now, or wait for the daily refresh.`,
      ],
      optional: true,
    };
  }
  const refreshAt = config.powerBi?.refreshAt;
  const signedIn = config.pax?.task?.logonType === 'Password';
  return {
    id: 'first-refresh',
    title: 'Wait for the first refresh to finish',
    why: orgFile
      ? 'It exports your directory\'s users, with their departments and licences, to the org file. On a large tenant that can take a while. The report\'s department breakdowns fill in once it finishes.'
      : `It reads the last ${days} days of Copilot activity from the audit log, which can take hours on a large tenant. The report has no data until it finishes.`,
    who: 'You',
    steps: [
      `Check on it with ${status}. Leave this PC on${signedIn ? '' : ', and stay signed in,'} until it finishes.`,
      refreshAt
        ? `Once it has finished, the report loads the data at its daily refresh at ${refreshAt}. To load it sooner, run ${commandLine('refresh')}.`
        : `Once it has finished, run ${commandLine('refresh')} to load the data into the report.`,
    ],
  };
}

/**
 * The PAX route: the filled-in template handed to Power BI Desktop, until the installer finds it published.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function desktopPublishStep(config) {
  const pbi = config.powerBi;
  if (!pbi?.desktopPending || !pbi.desktopFile) return null;
  const workspace = config.fabric?.workspaceName ?? config.fabric?.workspaceId ?? PRODUCT.pax.workspace;
  const steps = desktopSteps(pbi.desktopFile, workspace, pbi.desktopName, !!config.semanticModel?.id);
  if (vivaOn(config)) {
    const at = steps.findIndex((s) => s.includes('SharePoint'));
    steps.splice(at < 0 ? 0 : at + 1, 0, `When it asks how to connect to Viva Insights, sign in as ${VIVA_ANALYST}.`);
  }
  return {
    id: 'desktop-publish',
    title: 'Publish the report from Power BI Desktop',
    why: 'Power BI didn\'t take the report through its API, so publish it once from Desktop. The installer then finds it and finishes setting it up.',
    who: 'You',
    link: DESKTOP_URL,
    linkText: 'Get Power BI Desktop',
    steps: [...steps, 'Run the installer again. It finds the report you published and carries on.'],
  };
}

/**
 * The PAX route: signing the model in to SharePoint, and to Viva Insights when it reads a query,
 * which Power BI has no API for. Until then the report can't refresh. Not while the report waits to
 * be published from Desktop, which signs it in.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function modelCredentialsStep(config) {
  const sm = config.semanticModel;
  const ws = config.fabric?.workspaceId;
  if (!sm?.id || !ws || sm.bound || config.powerBi?.desktopPending) return null;
  const url = modelSettingsUrl(ws, sm.id);
  const viva = vivaOn(config);
  return {
    id: 'model-credentials',
    title: viva ? `Sign ${sm.name} in to SharePoint and Viva Insights` : `Sign ${sm.name} in to SharePoint`,
    why: viva
      ? 'The report reads the files in the SharePoint folder, and Cowork credits from Viva Insights, as whoever signs its model in to each. Power BI has no way for the installer to do it, and until it\'s done the report can\'t refresh.'
      : 'The report reads the files in the SharePoint folder as whoever signs its model in. Power BI has no way for the installer to do it, and until it\'s done the report can\'t refresh.',
    who: viva ? 'You, or a Viva Insights analyst' : 'You',
    link: url,
    linkText: 'Open the model\'s settings',
    steps: [...credentialSteps(url), ...(viva ? [VIVA_SIGN_IN] : []), `Then run ${commandLine('refresh')}. It asks whether the model is signed in, loads the data and schedules the daily refresh.`],
  };
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
  const join = `give people access by adding them to the group${a?.groupId ? ` (${myGroupsUrl(a.groupId)})` : ''}`;
  return {
    id: 'share-report',
    title: `Share the report with ${group}`,
    why: isPax(config)
      ? `Once only. Until it's shared, people in the group get "no access" when they open the report. After that, ${join}. They need no workspace role. ${PRO_VIEWERS}`
      : `Once only. Until it's shared, people in the group get "no access" when they open the report. After that, ${join}.`,
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

/** The steps that build the Viva Insights query and copy its IDs. */
const VIVA_QUERY_STEPS = Object.freeze([
  'In Viva Insights > Create analysis > Create custom query, choose Consumption query and keep the preselected credit metrics. Leave the GitHub Copilot credit metric out: it makes the query fail.',
  'Turn on Auto-refresh, and run it.',
  'In Analysis results, choose the link icon next to it and copy the partition ID and the query ID.',
]);

/**
 * The PAX route: the Viva Insights query the report reads Cowork credits through, when the install
 * has none. Without it the report's Cowork pages are blank.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function vivaConnectorStep(config, user) {
  if (vivaOn(config)) return null;
  return {
    id: 'viva-query',
    title: 'Ask a Viva Insights analyst for the Cowork credits query',
    why: `The report reads Cowork and Work IQ credits from a Viva Insights query, through Power BI's Viva Insights connector. Until it has one, its Cowork pages are blank. Once you have the partition and query IDs, run the installer again with --viva-partition and --viva-query.`,
    who: 'A Viva Insights analyst',
    link: VIVA_QUERY_GUIDE,
    linkText: 'The guide',
    steps: [...VIVA_QUERY_STEPS],
    message: letter(
      [
        `Could you set up a Viva Insights query for ${PRODUCT.name}? Its report reads Copilot Cowork credits from it every day, through Power BI's Viva Insights connector.`,
        '',
        ...numbered([...VIVA_QUERY_STEPS]),
        '',
        'Then send me the partition ID and the query ID. They look like 00000000-0000-0000-0000-000000000000.',
        `Guide: ${VIVA_QUERY_GUIDE}`,
      ],
      user.upn,
    ),
  };
}

/**
 * Whether the record has the app on: the PAX route's app step, unless it was turned off.
 * @param {import('../config.js').InstallConfig} config
 */
const appWanted = (config) => isPax(config) && config.pax?.deployApp !== false;

/**
 * The tenant settings for managed apps that the app step found turned off. The report works without
 * them; the app waits for a Power Platform admin.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function appSettingsStep(config, user) {
  const missing = appWanted(config) ? (config.managedApp?.missing ?? []) : [];
  if (!missing.length) return null;
  const steps = missing.map((key) => ADMIN_STEPS[key].what);
  const name = PRODUCT.managedApp.name;
  return {
    id: 'app-settings',
    title: 'Ask for managed apps to be turned on',
    why: `The ${name} app can't be deployed until these settings are on. The report works without it. Once they're on, run ${deployAgain()}.`,
    who: 'A Power Platform admin',
    link: LINKS.cliSetting,
    linkText: 'Managed apps settings',
    steps,
    message: letter(
      [
        `Could you turn on managed apps for me in the Power Platform admin center? I'm deploying the ${name} app, a Copilot managed app that shows our Copilot consumption, and the environment doesn't allow it yet.`,
        '',
        ...numbered(steps),
        '',
        `How: ${LINKS.cliSetting}`,
      ],
      user.upn,
    ),
  };
}

/**
 * The app step, when it was skipped or failed: why, and what to do.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function appSkippedStep(config) {
  const skipped = appWanted(config) ? config.managedApp?.skipped : undefined;
  if (!skipped) return null;
  return {
    id: 'app-skipped',
    title: `Finish the ${PRODUCT.managedApp.name} app`,
    why: skipped.why,
    who: 'You',
    steps: skipped.steps,
  };
}

/** Opening the scheduled task's properties in Task Scheduler. @param {string} name */
const openTask = (name) => ['Open Task Scheduler and select Task Scheduler Library.', `Right-click "${name}" and choose Properties.`];

/**
 * The PAX route: how the scheduled task signs in. Registered, it runs only while the user is signed
 * in; Task Scheduler can run it signed out with the password stored. Without a stored password (S4U)
 * it can't read the client secret from Credential Manager, so every refresh fails.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function taskLogonStep(config) {
  const task = config.pax?.task;
  if (!task) return null;
  const who = 'You, or an administrator of this PC';
  if (task.logonType === 'Interactive') {
    return {
      id: 'task-logon',
      title: 'Keep the refresh running while you\'re signed out',
      why: `"${task.name}" runs only while you're signed in to this PC. If you aren't at ${task.at}, it runs once you next sign in. To have it run while nobody is signed in, change one setting. It still reads the client secret from your Credential Manager.`,
      who,
      steps: [
        ...openTask(task.name),
        'On the General tab, choose "Run whether user is logged on or not". Leave "Do not store password" unticked: the task needs your password to read the client secret.',
        'Select OK, and enter your Windows password when it asks. If Windows says the account needs the "Log on as a batch job" right, an administrator of this PC can give it.',
      ],
      optional: true,
    };
  }
  if (task.logonType === 'S4U') {
    return {
      id: 'task-logon',
      title: 'Store the password for the scheduled task',
      why: `"${task.name}" is set to run without a stored password, so it can't read the client secret from Credential Manager, and each refresh fails.`,
      who,
      steps: [...openTask(task.name), 'On the General tab, untick "Do not store password". Select OK, and enter your Windows password when it asks.'],
    };
  }
  return null;
}

/**
 * The PAX route: sites the folder moved away from, where the app can still write, until a
 * SharePoint Administrator or Global Administrator takes it back.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function retiredGrantsStep(config, user) {
  const grants = config.sharePoint?.retiredGrants ?? [];
  const appId = config.app?.appId;
  if (!grants.length || !appId) return null;
  const app = appLabel(config);
  const one = grants.length === 1;
  const sites = grants.map((g) => g.siteUrl).join(', ').replace(/, ([^,]*)$/, ' and $1');
  return {
    id: 'retired-grants',
    title: `Ask for the app's access to the old ${one ? 'site' : 'sites'} to be taken back`,
    why: `The folder moved, but "${app}" can still write to ${sites}, where it was before. Your account couldn't take that back.`,
    who: SITE_ADMIN,
    steps: [`Run the commands in the message in PowerShell 7, signed in as ${SITE_ADMIN.replace(/^A /, 'a ')}.`],
    message: letter(
      [
        `Could you take back our app "${app}"'s write access to ${one ? 'a SharePoint site' : 'some SharePoint sites'} it no longer uses? The ${PRODUCT.name} folder it writes to has moved to another site.`,
        '',
        `App: ${app}`,
        `Application (client) ID: ${appId}`,
        ...grants.flatMap((g) => ['', `Site: ${g.siteUrl}`, 'In PowerShell 7:', ...siteRemovalCommands(config, g)]),
      ],
      user.upn,
    ),
    optional: true,
  };
}
