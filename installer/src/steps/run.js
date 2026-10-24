// @ts-check
/**
 * Runs the pipeline and the data check, and reports on them. The data check isn't in the pipeline:
 * it asks the semantic model how many rows each source gave it, after the first load, after `run`,
 * and on `check`.
 */
import { isTransientNetworkError } from '../auth.js';
import { onceNotebooks } from '../catalog.js';
import { commandLine } from '../launch.js';
import { failedCards, fillRerun, loadCards, VIVA_ACTIVITY } from '../loads.js';
import { INSTALLER_DIR, PRODUCT_NAME } from '../product.js';
import { COWORK_DATAFLOW_ACTIVITY, COWORK_WRAPPER_ACTIVITY, REFRESH_ACTIVITY, SKIP_COWORK_PARAMETER, STATUS_ACTIVITY } from '../transform/pipeline.js';
import { formatDuration } from '../ui.js';
import { dataSource } from '../uploads.js';
import { coworkConnections, coworkNextStep, coworkSignInSteps, VIVA_LOAD_FILE } from './consumption.js';
import { coworkDataflowOn, deployedSources, modelDeployed } from './fabric.js';
import { tokenLine, TOKEN_WARN_DAYS } from './github.js';
import { countModelRows, modelRefreshes, verifyModel } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../loads.js').LoadCard} LoadCard */

/** Job states after which Fabric does no more work. */
export const TERMINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Deduped', 'Duplicate', 'NotFound', 'OwnerUserMissing', 'DeadLettered']);

export const POLL_MS = 30_000;

/** Polls in a row that may fail on a network blip before watching a job gives up: 20 minutes at POLL_MS. */
export const NETWORK_LOSSES = 40;

/** Fabric sends job times without a zone; they are UTC. @param {string | null | undefined} t */
export function utc(t) {
  if (!t) return undefined;
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
}

/** @param {string} url */
export const jobIdFrom = (url) => /** @type {string} */ (new URL(url, 'https://x').pathname.split('/').filter(Boolean).pop());

/**
 * Polls a job until it ends or `timeoutMs` passes. Returns the last job instance seen.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} label
 * @param {{ pollMs?: number, timeoutMs?: number }} [opts]
 */
export async function waitForJob(ctx, url, label, opts = {}) {
  const progress = ctx.ui.progress(label);
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3_600_000);
  /** @type {any} */
  let job;
  let lost = 0;
  try {
    for (;;) {
      try {
        job = await ctx.api.fabric.getJob(url);
        lost = 0;
      } catch (err) {
        // A network blip on this PC doesn't stop the job in Fabric, so keep watching.
        if (!isTransientNetworkError(err)) throw err;
        if (++lost > NETWORK_LOSSES) {
          throw new Error(`Lost the connection while watching the ${label.toLowerCase()}. It carries on in Fabric: check on it with "${commandLine('status')}". (${/** @type {Error} */ (err).message})`, { cause: err });
        }
        progress.update('Connection lost, trying again');
        await ctx.sleep(opts.pollMs ?? POLL_MS);
        continue;
      }
      progress.update(job?.status ?? 'Unknown');
      if (TERMINAL.has(job?.status)) break;
      if (Date.now() > deadline) break;
      await ctx.sleep(opts.pollMs ?? POLL_MS);
    }
  } finally {
    progress.done();
  }
  return job;
}

/** What Fabric says when a capacity is too busy to start another notebook. */
export const CAPACITY_BUSY = /TooManyRequestsForCapacity|(?:code|status)[\s:'"=-]{0,6}430\b/i;

/**
 * Whether an error is Fabric turning work away because the capacity is busy.
 * @param {{ errorCode?: unknown, message?: unknown } | null | undefined} e
 */
export const capacityBusy = (e) => !!e && (String(e.errorCode ?? '') === '430' || CAPACITY_BUSY.test(`${e.errorCode ?? ''} ${e.message ?? ''}`));

/** Times work turned away by a busy capacity is tried again, and how long to wait first. */
export const BUSY_RETRIES = 2;
export const BUSY_WAIT_MS = 5 * 60_000;

/**
 * @param {Ctx} ctx
 * @param {string} again  The command that starts the work again.
 */
function busyNote(ctx, again) {
  ctx.ui.note('Fabric\'s capacity was too busy to start a notebook. Nothing is lost.');
  ctx.ui.note(`Wait a few minutes, then run "${commandLine(again)}" again.`);
}

/**
 * @param {Ctx} ctx
 * @param {any} job
 * @param {string} what
 * @param {{ again?: string, warn?: boolean }} [o]  again: the command to suggest when a busy capacity turned the job away.
 *   warn: a failure only warns, because the install carries on and still counts as set up.
 */
function reportJob(ctx, job, what, o = {}) {
  const { ui } = ctx;
  const start = utc(job?.startTimeUtc);
  const end = utc(job?.endTimeUtc);
  const took = start && end ? ` in ${formatDuration(end.getTime() - start.getTime())}` : '';
  switch (job?.status) {
    case 'Completed':
      ui.ok(`${what} finished${took}`);
      return true;
    case 'Failed':
      if (o.warn) ui.warn(`${what} failed${took}`);
      else ui.fail(`${what} failed${took}`);
      if (o.again && capacityBusy(job.failureReason)) busyNote(ctx, o.again);
      else if (job.failureReason?.message) ui.info(String(job.failureReason.message).slice(0, 1200));
      return false;
    default:
      if (TERMINAL.has(job?.status)) ui.warn(`${what} ended with status ${job.status}`);
      else ui.warn(`${what} is still running (${job?.status ?? 'unknown'}). Check later with "${commandLine('status')}".`);
      return false;
  }
}

/**
 * @typedef {object} RunResult
 * @property {string} [jobId]
 * @property {boolean} [started]  This call started the run; false when one was already going.
 * @property {string} [status]  The job's status. NotStarted when it didn't wait.
 * @property {boolean} [ok]  The run completed and none of its loads failed.
 * @property {string[]} [failed]  The activities that failed.
 * @property {string[]} [counted]  Those that leave an install partly set up: see {@link countedFailures}.
 */

/** How long the first load is likely to take. Each load reads everything its source has, every run. */
export const FIRST_LOAD_ESTIMATE = 'The first load usually takes under an hour, longer on a trial or small capacity. ';

/** A run that started longer ago than this is stuck, not running. */
const STUCK_MS = 24 * 3_600_000;

/**
 * Starts the pipeline. It doesn't start a run while another is going: two at once overload a small capacity.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, first?: boolean, skipCowork?: boolean }} opts  first: record the run as the first load.
 *   skipCowork: leave the Cowork Dataflow out of this run only (SkipCowork), because its connections aren't signed in yet.
 * @returns {Promise<RunResult>}
 */
export async function runPipeline(ctx, opts) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) throw new Error('There is no pipeline yet. Run the installer first.');
  const running = (await api.fabric.listJobs(f.workspaceId, f.pipelineId).catch(() => [])).find((j) => {
    const started = utc(j.startTimeUtc);
    return (j.status === 'InProgress' || j.status === 'NotStarted') && !(started && ctx.now().getTime() - started.getTime() > STUCK_MS);
  });
  if (running) {
    ui.warn('The pipeline is already running, so this didn\'t start another.');
    ui.note(`Check on it with "${commandLine('status')}". Once it has finished, run "${commandLine('run')}" to start a new run.`);
    return { jobId: running.id, status: running.status, ok: false, started: false };
  }
  const parameters = opts.skipCowork ? { [SKIP_COWORK_PARAMETER]: true } : undefined;
  const startedAt = ctx.now().toISOString();
  const url = await api.fabric.runJob(f.workspaceId, f.pipelineId, 'Pipeline', parameters ? { parameters } : undefined);
  const jobId = jobIdFrom(url);
  if (opts.first) {
    config.firstRun = { jobId, status: 'NotStarted', startedAt, ...(opts.skipCowork ? { coworkSkipped: true } : {}) };
    ctx.save();
  }
  ui.ok(opts.first ? 'Started the first load' : 'Started the pipeline');
  if (!opts.wait) {
    ui.note(`It runs in Fabric. Check on it with "${commandLine('status')}".`);
    return { jobId, status: 'NotStarted', started: true };
  }
  ui.note(`${opts.first ? FIRST_LOAD_ESTIMATE : ''}${ui.web ? 'You can close this window' : 'You can press Ctrl+C'}; the run carries on in Fabric.`);
  const job = await waitForJob(ctx, url, 'Pipeline');
  const ok = reportJob(ctx, job, 'Pipeline');
  const runs = TERMINAL.has(job?.status) ? await activityRuns(ctx, jobId, { startTimeUtc: job.startTimeUtc ?? startedAt, endTimeUtc: job.endTimeUtc }) : null;
  const cards = runs ? await reportLoads(ctx, runs) : [];
  const failed = failedCards(cards);
  if (!failed.length && capacityBusy(job?.failureReason)) busyNote(ctx, 'run');
  else if (!failed.length && job?.status === 'Failed') {
    ui.note(`To see why, open ${f.pipelineName ?? 'the pipeline'} in Fabric and look at its latest run. Then run "${commandLine('run')}" again.`);
  }
  if (opts.first) {
    config.firstRun = { ...config.firstRun, status: firstRunStatus(config, job?.status, runs), finishedAt: TERMINAL.has(job?.status) ? ctx.now().toISOString() : undefined };
    ctx.save();
  }
  return {
    jobId,
    started: true,
    status: job?.status,
    ok: ok && !failed.length,
    failed: failed.map((r) => r.activity),
    counted: countedFailures(config, cards).map((r) => r.activity),
  };
}

/**
 * The pipeline's activities as saved in Fabric, or undefined when Fabric can't say.
 * @param {Ctx} ctx
 * @returns {Promise<any[] | undefined>}
 */
export async function pipelineActivities(ctx) {
  const f = ctx.config.fabric;
  if (!f.workspaceId || !f.pipelineId) return undefined;
  const doc = await ctx.api.fabric.getPipelineDefinition(f.workspaceId, f.pipelineId).catch(() => null);
  return Array.isArray(doc?.properties?.activities) ? doc.properties.activities : undefined;
}

/**
 * Shows one card per source: whether it loaded and, if not, why and what to do.
 * @param {Ctx} ctx
 * @param {Map<string, any> | null} runs
 * @param {any[]} [activities]  The definition; fetched when not given.
 * @returns {Promise<LoadCard[]>}
 */
export async function reportLoads(ctx, runs, activities) {
  if (!runs) return [];
  const cards = loadCards(runs, activities ?? (await pipelineActivities(ctx)));
  await checkVivaRows(ctx, cards);
  const todo = coworkNextStep(ctx.config, cards);
  const rerun = `run "${commandLine('rerun-failed')}"`;
  for (const card of cards) {
    if (card.activity === COWORK_DATAFLOW_ACTIVITY && card.state === 'failed' && card.kind !== 'capacity') {
      card.fix = todo
        ? [`The Cowork credits Dataflow fails until its connections are signed in: see "${todo.title}".`]
        : ['The Cowork credits Dataflow usually fails until it has its sign-ins:', ...coworkSignInSteps(ctx.config).map((step, i) => `  ${i + 1}. ${step}`)];
    }
    card.fix = card.fix.map((t) => fillRerun(t, rerun));
  }
  // So the web page shows what the install counts as failed, rather than as waiting on a next step.
  for (const card of countedFailures(ctx.config, cards)) card.counted = true;
  if (cards.length) ctx.ui.loads(cards);
  if (todo) ctx.ui.todo(todo);
  return cards;
}

/**
 * The failed loads that leave an install partly set up: all of them except the Cowork credits Dataflow while signing it
 * in is still to do, which is a next step. Failing for another reason, such as a busy capacity, counts.
 * @param {import('../config.js').InstallConfig} config
 * @param {LoadCard[]} cards
 */
export function countedFailures(config, cards) {
  const signInToDo = !!coworkNextStep(config, cards);
  return failedCards(cards).filter((c) => !(signInToDo && c.activity === COWORK_DATAFLOW_ACTIVITY));
}

/**
 * The Viva load succeeds whether or not the Dataflow gave it any rows, so it reads back the counts
 * the notebook wrote and isn't green when none came. Without the file it leaves the card as it is.
 * @param {Ctx} ctx
 * @param {LoadCard[]} cards
 */
async function checkVivaRows(ctx, cards) {
  const viva = cards.find((c) => c.activity === VIVA_ACTIVITY);
  const f = ctx.config.fabric;
  if (viva?.state !== 'ok' || !coworkDataflowOn(ctx.config) || !ctx.api.oneLake || !f.workspaceId || !f.lakehouseId) return;
  /** @type {any} */
  const summary = await ctx.api.oneLake.readJson(f.workspaceId, f.lakehouseId, VIVA_LOAD_FILE).catch(() => null);
  if (summary && Number(summary.dataflowRows) === 0) {
    viva.state = 'todo';
    viva.reason = 'It ran, but no rows came from the Cowork Dataflow.';
    viva.fix = ['Check the Viva Insights query has Auto-refresh on and covers recent weeks, then choose Load Cowork now.'];
  }
}

/**
 * Whether the installer's first load should leave the Cowork Dataflow out: only when Fabric says its
 * connections aren't signed in and the pipeline has the SkipCowork switch. When unsure, it runs it.
 * @param {Ctx} ctx
 */
export async function coworkSkipForFirstLoad(ctx) {
  if (!coworkDataflowOn(ctx.config)) return false;
  const activities = await pipelineActivities(ctx);
  if (!activities?.some((a) => a.name === COWORK_WRAPPER_ACTIVITY)) return false;
  if ((await coworkConnections(ctx)) !== 'unbound') return false;
  ctx.ui.warn('Cowork credits are left out of this first load: the Cowork Dataflow isn\'t signed in yet.');
  ctx.ui.note('Everything else loads now. The steps to sign in and load Cowork follow once the load has finished.');
  return true;
}

/**
 * The last attempt of each activity in one pipeline run, with how many attempts it took, or null
 * when Fabric can't say.
 * @param {Ctx} ctx
 * @param {string} jobId
 * @param {{ startTimeUtc?: string | null, endTimeUtc?: string | null }} job
 * @returns {Promise<Map<string, any> | null>}
 */
export async function activityRuns(ctx, jobId, job) {
  const start = utc(job.startTimeUtc) ?? ctx.now();
  const end = utc(job.endTimeUtc) ?? ctx.now();
  const at = (/** @type {any} */ r) => utc(r.activityRunStart)?.getTime() || 0;
  try {
    const runs = await ctx.api.fabric.queryActivityRuns(
      /** @type {string} */ (ctx.config.fabric.workspaceId),
      jobId,
      new Date(start.getTime() - 3_600_000),
      new Date(end.getTime() + 3_600_000),
    );
    /** @type {Map<string, any>} */
    const last = new Map();
    for (const r of [...runs].sort((a, b) => at(a) - at(b))) {
      last.set(r.activityName, { ...r, attempts: (last.get(r.activityName)?.attempts ?? 0) + 1 });
    }
    return last;
  } catch {
    return null;
  }
}

/**
 * Whether a run loaded the data. With the model deployed, its refresh succeeded: that waits for every
 * usage load to succeed. Without it, every step but the status record succeeded.
 * @param {import('../config.js').InstallConfig} config
 * @param {Map<string, any>} runs
 */
export function loadedBy(config, runs) {
  if (modelDeployed(config)) return runs.get(REFRESH_ACTIVITY)?.status === 'Succeeded';
  const steps = [...runs.values()].filter((r) => r.activityName !== STATUS_ACTIVITY);
  return steps.length > 0 && steps.every((r) => r.status === 'Succeeded');
}

/**
 * The first load's status to record. A pipeline job can complete with failed loads, so 'Completed'
 * is kept only when its activity runs prove the data loaded; otherwise it is 'Incomplete' and the
 * next run counts as the first load again.
 * @param {import('../config.js').InstallConfig} config
 * @param {string | undefined} status
 * @param {Map<string, any> | null} runs
 */
export function firstRunStatus(config, status, runs) {
  return status === 'Completed' && !(runs && loadedBy(config, runs)) ? 'Incomplete' : status;
}

/**
 * Whether a run has loaded the data. A first load whose activity runs show it loaded is marked
 * completed. Without a first load on record, any completed run counts.
 * @param {Ctx} ctx
 */
export async function historyLoaded(ctx) {
  const { config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) return false;
  const first = config.firstRun;
  if (first?.status === 'Completed') return true;
  if (first?.jobId) {
    const runs = await activityRuns(ctx, first.jobId, { startTimeUtc: first.startedAt, endTimeUtc: first.finishedAt });
    if (!runs || !loadedBy(config, runs)) return false;
    config.firstRun = { ...first, status: 'Completed' };
    ctx.save();
    return true;
  }
  return (await api.fabric.listJobs(f.workspaceId, f.pipelineId).catch(() => [])).some((j) => j.status === 'Completed');
}

/**
 * What `run` starts: the first load until a run has loaded the data, then the usual run. The two
 * run the same pipeline; the first is recorded, so the install knows when the data has loaded.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<{ wait: boolean, first?: boolean }>}
 */
export async function chooseLoad(ctx, opts) {
  return (await historyLoaded(ctx)) ? opts : { ...opts, first: true };
}

/** Where the data check leaves its result, so `status` shows it on any PC. */
export const DATA_CHECK_FILE = `${INSTALLER_DIR}/data_check.json`;

/**
 * Asks the semantic model how many rows each chosen source gave it, prints that, and saves it in the
 * Lakehouse for `status`.
 * @param {Ctx} ctx
 * @returns {Promise<any>} The summary; false when the query failed, saying how to run it again; null when
 *   there is no model to ask or it can't be queried, which only warns.
 */
export async function runDataCheck(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const counted = await countModelRows(ctx);
  if (counted.skipped) return null;
  if (!counted.tables) {
    ui.fail(`Data check: the query on ${config.semanticModel.name} failed`);
    if (counted.error) ui.info(counted.error);
    ui.info(`Run "${commandLine('check')}" to try it again.`);
    return false;
  }
  const summary = { checkedAt: ctx.now().toISOString(), tables: counted.tables };
  if (api.oneLake && f.workspaceId && f.lakehouseId) {
    const data = new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`);
    await api.oneLake.writeFile(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE, data).catch(() => {});
  }
  printDataCheck(ctx, summary);
  return summary;
}

/**
 * The `check` command: checks the model answers queries, then asks it what each source gave it,
 * without running the pipeline.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>} false when a check failed.
 */
export async function checkData(ctx) {
  if (!modelDeployed(ctx.config)) throw new Error('There is no semantic model yet. Run the installer first.');
  if (!(await verifyModel(ctx)).ok) return false;
  return (await runDataCheck(ctx)) !== false;
}

/** How long a notebook that runs once is waited for. It makes one Cost Management query. */
export const ONCE_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs the notebooks that run once at setup rather than in the pipeline. Ingest_CommercialTerms is
 * the only one: it reads the credit rate from Cost Management, as the signed-in user, into
 * commercial_terms, which the model reads instead of its price parameters. It needs no app secret.
 * It runs until a run completes, again when its scope changes (the plan clears its status), and on
 * every `update`.
 * @param {Ctx} ctx
 * @param {{ force?: boolean, timeoutMs?: number, again?: string }} [opts]  force: run it even when it has completed before.
 *   again: the command to suggest when a busy capacity turned it away (default install).
 * @returns {Promise<boolean>}  false when one didn't complete.
 */
export async function runOnceNotebooks(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  let ok = true;
  for (const nb of onceNotebooks(ctx.sources.catalog, deployedSources(config))) {
    const id = f.notebooks[nb.key];
    if (!f.workspaceId || !id) continue;
    const name = f.notebookNames?.[nb.key] ?? nb.displayName;
    // Ingest_CommercialTerms is the only notebook that runs once, so its state is config.commercialTerms.
    const terms = (config.commercialTerms ??= {});
    const where = terms.scopeName ?? terms.scope ?? 'the billing scope';
    if (terms.status === 'Completed' && !opts.force) {
      ui.ok(`${name} read the credit rate from ${where}${terms.ranAt ? ` on ${terms.ranAt.slice(0, 10)}` : ''}`);
      continue;
    }
    ui.info(`${name} reads the credit rate you pay from Cost Management for ${where}.`);
    /** @type {any} */
    let job;
    for (let attempt = 0; ; attempt++) {
      const url = await api.fabric.runJob(f.workspaceId, id, 'RunNotebook');
      job = await waitForJob(ctx, url, name, { timeoutMs: opts.timeoutMs ?? ONCE_TIMEOUT_MS });
      if (job?.status !== 'Failed' || !capacityBusy(job.failureReason) || attempt >= BUSY_RETRIES) break;
      ui.warn(`Fabric's capacity is too busy to start ${name}. Trying again in ${BUSY_WAIT_MS / 60_000} minutes.`);
      await ctx.sleep(BUSY_WAIT_MS);
    }
    const status = String(job?.status ?? 'Unknown');
    terms.status = status;
    if (TERMINAL.has(status)) terms.ranAt = ctx.now().toISOString();
    ctx.save();
    if (reportJob(ctx, job, name, { again: opts.again ?? 'install', warn: true })) continue;
    ok = false;
    const prices = 'Until it completes, the model prices credits at the rates set in the installer, or the template\'s.';
    // A busy capacity's note already says to run it again; the role isn't what stopped it.
    if (job?.status === 'Failed' && capacityBusy(job.failureReason)) ui.note(prices);
    else ui.note(`${prices} It runs as you, so you need Cost Management Reader on ${where}. Run the installer again to retry.`);
  }
  return ok;
}

/**
 * Whether a pipeline run ended after the data check, so the tables may have changed since.
 * @param {any[]} jobs
 * @param {string | undefined} checkedAt
 */
export function ranSince(jobs, checkedAt) {
  const at = Date.parse(checkedAt ?? '');
  if (Number.isNaN(at)) return false;
  return jobs.some((j) => (j.status === 'Completed' || j.status === 'Failed') && (utc(j.endTimeUtc)?.getTime() ?? 0) > at);
}

/**
 * @param {Ctx} ctx
 * @param {any} summary
 */
export function printDataCheck(ctx, summary) {
  const { ui, config } = ctx;
  const n = (/** @type {number} */ v) => v.toLocaleString('en-GB');
  for (const [source, t] of Object.entries(summary?.tables ?? {})) {
    const id = /** @type {import('../uploads.js').DataSourceId} */ (source);
    const label = dataSource(id)?.label ?? source;
    const rows = Number(t?.rows ?? 0);
    if (rows) {
      const range = t.from && t.to ? `, ${String(t.from).slice(0, 10)} to ${String(t.to).slice(0, 10)}` : '';
      ui.ok(`${label}: ${n(rows)} rows in the model${range}`);
      if (t.filled !== undefined && t.filled !== null) printDepartmentCoverage(ctx, rows, Number(t.filled));
      continue;
    }
    ui.warn(`${label}: no rows in the model yet`);
    const mode = config.dataSources?.[id];
    if (id === 'coworkCredits' && mode === 'api' && config.firstRun?.coworkSkipped) {
      ui.note('They load once the Cowork Dataflow is signed in: see the next step.');
    } else if (mode === 'csv') {
      ui.note(`Upload its export with "${commandLine('upload <file> --run')}".`);
    }
  }
}

/** Below this share of people with a department, by-department views leave most people out. */
export const LOW_DEPARTMENT_COVERAGE = 0.8;

/**
 * Says how many people in the org data have a department, and how to fill the gaps when few do.
 * @param {Ctx} ctx
 * @param {number} people
 * @param {number} withDepartment
 */
function printDepartmentCoverage(ctx, people, withDepartment) {
  const { ui, config } = ctx;
  const n = (/** @type {number} */ v) => v.toLocaleString('en-GB');
  const line = `Org data: ${n(withDepartment)} of ${n(people)} people have a department`;
  if (withDepartment / people >= LOW_DEPARTMENT_COVERAGE) {
    ui.ok(line);
    return;
  }
  ui.warn(line);
  ui.note('Views by department leave out everyone without one.');
  if (config.dataSources?.orgData === 'csv') ui.note('Fill in the Department column in the org data file, then upload it again.');
  else ui.note('Fill in Department on users in Microsoft Entra ID (or the HR system that feeds it). The next pipeline run picks it up.');
}

/**
 * @param {Ctx} ctx
 */
export async function status(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) {
    ui.warn('Nothing is installed yet.');
    return;
  }
  ui.heading(PRODUCT_NAME);
  ui.info(`Workspace: ${f.workspaceName ?? f.workspaceId}`);
  ui.info(`Lakehouse: ${f.lakehouseName ?? f.lakehouseId}`);
  ui.info(`Pipeline:  ${f.pipelineName ?? f.pipelineId}`);
  const sm = config.semanticModel;
  if (sm?.id) ui.info(`Model:     ${sm.name}${sm.bound ? '' : ' (not connected to the Lakehouse yet)'}`);
  expiry(ctx, 'Client secret', config.app.secretExpires);
  if (sm?.connectionId) expiry(ctx, 'Model connection secret', sm.secretExpires);
  const token = tokenLine(config);
  if (token) {
    const expires = config.github?.tokenExpires;
    const days = expires ? Math.floor((Date.parse(expires) - ctx.now().getTime()) / 86_400_000) : Infinity;
    if (!config.github?.tokenSetAt) ui.warn(token);
    else if (days < TOKEN_WARN_DAYS) ui.warn(`${token} (${days} days). Run "${commandLine('github-token')}".`);
    else ui.info(token);
  }

  ui.heading('Recent runs');
  const jobs = (await api.fabric.listJobs(f.workspaceId, f.pipelineId))
    .sort((a, b) => String(b.startTimeUtc ?? '').localeCompare(String(a.startTimeUtc ?? '')))
    .slice(0, 5);
  if (!jobs.length) ui.note('No runs yet.');
  for (const job of jobs) {
    const start = utc(job.startTimeUtc);
    const end = utc(job.endTimeUtc);
    const when = start ? start.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not started';
    const took = start && end ? `, ${formatDuration(end.getTime() - start.getTime())}` : '';
    const line = `${when}  ${job.status}${took}  ${job.invokeType ?? ''}`.trimEnd();
    if (job.status === 'Completed') ui.ok(line);
    else if (job.status === 'Failed') {
      ui.fail(line);
      if (job.failureReason?.message) ui.note(String(job.failureReason.message).slice(0, 400));
    } else ui.info(line);
  }
  const latest = jobs[0];
  if (latest && TERMINAL.has(latest.status)) {
    const runs = await activityRuns(ctx, latest.id, latest);
    if (runs?.size) {
      ui.heading('Latest run, by source');
      const failed = failedCards(await reportLoads(ctx, runs));
      if (!failed.length && capacityBusy(latest.failureReason)) busyNote(ctx, 'run');
    } else if (capacityBusy(latest.failureReason)) busyNote(ctx, 'run');
  }

  if (config.firstRun?.jobId && !TERMINAL.has(config.firstRun.status ?? '') && config.firstRun.status !== 'Incomplete') {
    const job = jobs.find((j) => j.id === config.firstRun?.jobId);
    if (job && TERMINAL.has(job.status)) {
      const runs = job.status === 'Completed' ? await activityRuns(ctx, job.id, job) : null;
      config.firstRun = { ...config.firstRun, status: firstRunStatus(config, job.status, runs), finishedAt: utc(job.endTimeUtc)?.toISOString() };
      ctx.save();
    }
  }

  if (sm?.id) {
    const refreshes = await modelRefreshes(ctx, sm).catch(() => null);
    if (refreshes) {
      ui.heading('Model refreshes');
      if (!refreshes.length) ui.note('No refreshes yet.');
      for (const r of refreshes) {
        const start = utc(r.startTime);
        const end = utc(r.endTime);
        const when = start ? start.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not started';
        const took = start && end ? `, ${formatDuration(end.getTime() - start.getTime())}` : '';
        const state = r.extendedStatus ?? r.status ?? 'Unknown';
        const line = `${when}  ${state}${took}  ${r.refreshType ?? ''}`.trimEnd();
        if (state === 'Completed') ui.ok(line);
        else if (state === 'Failed') {
          ui.fail(line);
          if (r.serviceExceptionJson) ui.note(String(r.serviceExceptionJson).slice(0, 400));
        } else ui.info(line);
      }
    }
  }

  if (f.lakehouseId) {
    const summary = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE).catch(() => null);
    if (summary) {
      ui.heading(`Last data check${summary.checkedAt ? ` (${String(summary.checkedAt).slice(0, 16).replace('T', ' ')} UTC)` : ''}`);
      if (ranSince(jobs, summary.checkedAt)) {
        ui.warn('The pipeline has run since this check, so these results may be out of date.');
        ui.note(`Run "${commandLine('check')}" to check the data again.`);
      }
      printDataCheck(ctx, summary);
    } else if (modelDeployed(config) && jobs.some((j) => j.status === 'Completed')) {
      ui.heading('Data check');
      ui.note(`It hasn't run yet. Run "${commandLine('check')}" to see what the pipeline loaded.`);
    }
  }
}

/**
 * @param {Ctx} ctx
 * @param {string} label
 * @param {string | undefined} expires
 */
function expiry(ctx, label, expires) {
  if (!expires) return;
  const days = Math.floor((Date.parse(expires) - ctx.now().getTime()) / 86_400_000);
  const msg = `${label} expires ${expires.slice(0, 10)} (${days} days)`;
  if (days < 30) ctx.ui.warn(`${msg}. Run "${commandLine('rotate-secret')}".`);
  else ctx.ui.info(msg);
}
