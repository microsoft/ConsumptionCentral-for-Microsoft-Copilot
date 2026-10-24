// @ts-check
/**
 * The Data sources screen, the drop folder every CSV export goes to, and the `upload` command.
 * Each source arrives through its API, as an uploaded export, or not at all. Uploaded exports
 * go to one Lakehouse folder; the pipeline's first step recognises each by its headers and moves
 * it to the folder its load reads. A skipped source leaves its table empty and its page dormant.
 */
import { readFileSync } from 'node:fs';
import { commandLine } from '../launch.js';
import { inspectFile, releaseStaged } from '../staging.js';
import { c } from '../ui.js';
import {
  checkUploadSet,
  COWORK_TASKS_DIR,
  dataSource,
  DATA_SOURCES,
  exportModesOf,
  landsDirect,
  modeLabel,
  routedSources,
  routerWanted,
  SHAREPOINT_SUBDIR,
  sourceCards,
  UPLOAD_DIR,
  UPLOAD_FOLDERS,
  uploadKind,
  uploadName,
} from '../uploads.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../staging.js').PendingUpload} PendingUpload */

const FILE_EXPLORER = 'https://learn.microsoft.com/fabric/onelake/onelake-file-explorer';
const SHORTCUTS = 'https://learn.microsoft.com/fabric/onelake/create-onedrive-sharepoint-shortcut';

/**
 * Exports named on the command line, checked against the chosen sources and as a set, the way the
 * pickers check them. A PeopleMetaData.csv comes back before its Cowork task export.
 * @param {string[]} paths
 * @param {import('../uploads.js').DataSourceModes} modes
 * @param {string} [flag] How the files were named, for the error.
 * @returns {PendingUpload[]}
 */
export function checkCsvFiles(paths, modes, flag = '--csv') {
  const files = paths.map((p) => {
    const r = inspectFile(p, modes);
    if (!r.ok) throw new Error(`${flag}: ${r.error}`);
    return r.file;
  });
  const set = checkUploadSet(files);
  if (!set.ok) throw new Error(`${flag}: ${set.error}`);
  return set.files;
}

/**
 * The Data sources screen. Sets the sources, and keeps any exports picked to upload.
 * @param {Ctx} ctx
 */
export async function planDataSources(ctx) {
  const { ui, config } = ctx;
  ui.heading('Data sources');
  const picked = await ui.sources(
    'Choose how each source arrives. The API is read on every run; for an export, the card says where to download it. Skipped sources leave their page empty until you turn them on.',
    sourceCards(config.dataSources),
  );
  config.dataSources = picked.modes;
  const fromCli = checkCsvFiles(ctx.csvFiles ?? [], picked.modes);
  const set = checkUploadSet([...fromCli, ...picked.files]);
  if (!set.ok) throw new Error(set.error);
  ctx.pendingUploads = set.files;
}

/**
 * Makes the drop folder and the folders the loads read, then uploads the exports picked.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>} false when an export couldn't be uploaded. The rest still go, and the install carries on.
 */
export async function ensureUploads(ctx) {
  const pending = ctx.pendingUploads ?? [];
  if (routerWanted(ctx.config.dataSources) || pending.some((p) => !landsDirect(uploadKind(p.kind)))) await ensureDropFolders(ctx);
  const done = await uploadFiles(ctx, pending);
  ctx.pendingUploads = [];
  if (ctx.config.setup?.uploads?.length) {
    delete ctx.config.setup.uploads;
    ctx.save();
  }
  return done === pending.length;
}

/**
 * The drop folder, and the folders the loads read. The pipeline makes any that are missing too.
 * @param {Ctx} ctx
 */
async function ensureDropFolders(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  try {
    for (const path of UPLOAD_FOLDERS) await api.oneLake.createDirectory(/** @type {string} */ (f.workspaceId), /** @type {string} */ (f.lakehouseId), path);
    if (!config.uploads.folders) {
      config.uploads.folders = true;
      ctx.save();
    }
    ui.ok(`Drop folder: ${f.lakehouseName} > ${UPLOAD_DIR}`);
  } catch (err) {
    ui.warn(`Couldn't make ${UPLOAD_DIR} in ${f.lakehouseName} (${/** @type {Error} */ (err).message}).`);
    ui.info('The pipeline makes it on its first run, or make it yourself: in the Lakehouse, choose the ... next to Files, then New subfolder.');
  }
}

/**
 * Uploads exports to the drop folder. A file that fails is reported, and the rest still go. A Cowork
 * task export and its PeopleMetaData.csv, which the router refuses, go straight to where the Viva
 * load reads them, at fixed names; the export is held back when its PeopleMetaData.csv fails, so a run
 * never reads it with the last one's people.
 * @param {Ctx} ctx
 * @param {PendingUpload[]} files
 * @returns {Promise<number>} How many were uploaded.
 */
export async function uploadFiles(ctx, files) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  let done = 0;
  let peopleFailed = false;
  let pairHinted = false;
  for (const file of files) {
    const kind = uploadKind(file.kind);
    const direct = landsDirect(kind);
    const target = direct && kind ? `${kind.dir}/${kind.name}` : `${UPLOAD_DIR}/${uploadName(file.name, ctx.now())}`;
    try {
      if (file.kind === 'coworkTasks' && peopleFailed) throw new Error("its PeopleMetaData.csv didn't upload, and the export is read with it");
      const bytes = new Uint8Array(readFileSync(file.path));
      await api.oneLake.writeFile(/** @type {string} */ (f.workspaceId), /** @type {string} */ (f.lakehouseId), target, bytes);
      ui.ok(`Uploaded ${file.name} (${dataSource(file.source).label})`);
      done += 1;
    } catch (err) {
      if (file.kind === 'coworkPeople') peopleFailed = true;
      ui.fail(`Couldn't upload ${file.name}: ${/** @type {Error} */ (err).message}`);
      if (!direct) ui.info(`Put it in ${f.lakehouseName} > ${UPLOAD_DIR} yourself, or run "${commandLine('upload <file>')}" again.`);
      else if (!pairHinted) {
        pairHinted = true;
        ui.info(`Run "${commandLine('upload <CoworkWeeklyMetrics.csv> <PeopleMetaData.csv>')}" with both files again, or put both in ${f.lakehouseName} > ${COWORK_TASKS_DIR}, replacing the ones there.`);
      }
    } finally {
      releaseStaged(file.token);
    }
  }
  return done;
}

/**
 * How each source arrives, where the exports go, and how to keep them up to date.
 * @param {Ctx} ctx
 */
export function dataSourcesSummary(ctx) {
  const { ui, config } = ctx;
  const ds = config.dataSources;
  const lakehouse = config.fabric.lakehouseName;
  ui.heading('Data sources');
  for (const s of DATA_SOURCES) {
    const mode = ds[s.id];
    const dormant = mode === 'skip' && s.page ? c.dim(`  ${s.page} page stays empty`) : '';
    ui.info(`${s.label}: ${modeLabel(s.id, mode)}${dormant}`);
    if (s.export && exportModesOf(s).includes(mode)) ui.note(`  ${s.export.where} ${s.export.url}`);
  }
  if (routerWanted(ds)) {
    ui.info(c.bold('Adding exports'));
    ui.info(`Drop each export in ${lakehouse} > ${UPLOAD_DIR}, as downloaded: no renaming, no subfolders.`);
    ui.info('The next run recognises it by its columns, loads it, and moves it to _processed.');
    ui.info('Ways to add one:');
    ui.info(`  - OneLake File Explorer, which shows the folder in Windows Explorer  ${c.dim(FILE_EXPLORER)}`);
    ui.info('  - In Fabric: open the Lakehouse, choose the ... next to the folder, then Upload > Upload files');
    ui.info(`  - "${commandLine('upload <file.csv> --run')}" uploads and loads it now`);
    ui.note(`  A file the run doesn't recognise goes to ${UPLOAD_DIR}/_unrecognised.`);
    ui.info(c.bold('A SharePoint or OneDrive folder instead') + c.dim('  (optional)'));
    ui.info(`  In the Lakehouse, open ${UPLOAD_DIR}, choose New shortcut > OneDrive (SharePoint), pick your folder,`);
    ui.info(`  and name the shortcut "${SHAREPOINT_SUBDIR.split('/').pop()}". Exports dropped there are loaded once each and left in place.`);
    ui.note(`  Shortcuts need the tenant setting for OneDrive and SharePoint shortcuts; without it, use ${UPLOAD_DIR}.  ${SHORTCUTS}`);
  }
  if (routedSources(ds).includes('coworkTasks')) {
    ui.info(c.bold('Adding a Cowork task export'));
    ui.info(`It goes with the PeopleMetaData.csv that came with it: "${commandLine('upload <CoworkWeeklyMetrics.csv> <PeopleMetaData.csv>')}" lands both,`);
    ui.info(`or put both in ${lakehouse} > ${COWORK_TASKS_DIR} as CoworkWeeklyMetrics.csv and PeopleMetaData.csv, replacing the ones there.`);
  }
}

/**
 * Uploads exports to an existing install, then runs the pipeline if asked.
 * @param {Ctx} ctx
 * @param {{ files: string[], run?: boolean, wait?: boolean }} opts
 * @param {(ctx: Ctx, o: { wait: boolean }) => Promise<{ ok?: boolean }>} runNow
 * @returns {Promise<boolean>}
 */
export async function uploadCommand(ctx, opts, runNow) {
  const { ui, config } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.lakehouseId) throw new Error('Nothing is installed yet. Run the installer first.');
  const modes = config.dataSources;
  // A Cowork task export lands without the router, so an install whose only export it is takes uploads too.
  if (!routedSources(modes).length || (routerWanted(modes) && !f.notebooks.uploadRouter)) {
    throw new Error(`This install doesn't load exports. Run the installer again ("${commandLine('install')}") and set a source to Upload CSV on the Data sources screen.`);
  }
  ui.heading('Upload exports');
  const tasks = routedSources(modes).includes('coworkTasks');
  const to = routerWanted(modes)
    ? `${UPLOAD_DIR}${tasks ? `, and a Cowork task export with its PeopleMetaData.csv to ${COWORK_TASKS_DIR}` : ''}`
    : COWORK_TASKS_DIR;
  ui.note(`To ${f.lakehouseName} > ${to}. Sources that take an export: ${routedSources(modes).map((id) => dataSource(id).label).join(', ')}.`);
  /** @type {PendingUpload[]} */
  let files;
  if (opts.files.length) files = checkCsvFiles(opts.files, modes, 'upload');
  else {
    const picked = await ui.sources('Choose the exports to upload.', sourceCards(modes).filter((card) => routedSources(modes).includes(card.id)), { lockModes: true });
    files = picked.files;
  }
  if (!files.length) {
    ui.warn('No exports to upload.');
    return true;
  }
  if (routerWanted(modes)) await ensureDropFolders(ctx);
  const sent = await uploadFiles(ctx, files);
  if (!sent) return false;
  const go = opts.run ?? (await ui.confirm('Run the pipeline now to load them? Otherwise the next scheduled run does.', false));
  if (!go) {
    ui.ok('They load on the next scheduled run.');
    return true;
  }
  const result = await runNow(ctx, { wait: opts.wait ?? true });
  return !(opts.wait ?? true) || !!result.ok;
}
