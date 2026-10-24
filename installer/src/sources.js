// @ts-check
/**
 * Loads what the installer deploys from a Consumption Central checkout: installer-assets.json, the
 * notebooks it lists, and the Fabric template; for the PAX route, the Viva Direct template, the
 * PAX scripts and the app's build. The helper notebooks and the PAX scripts ship with the installer itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILE, resolveNotebooks } from './catalog.js';
import { RUNNER_DIR } from './steps/pax/local.js';

/** The installer folder, which holds the helper notebooks (`assets/notebooks`). */
export const INSTALLER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The source folder: the repo root when the installer runs from a checkout, `f` in the exe. */
export const DEFAULT_SOURCE_DIR = resolve(INSTALLER_ROOT, '..');

/** The PAX scripts the scheduled refresh runs, beside its own in the runner folder. */
export const PAX_SCRIPTS = Object.freeze(['Run-PAX-AIBV.ps1', 'Upload-Rollups-SharePoint.ps1']);

/**
 * The app's build, which the PAX route deploys as a Copilot managed app: this folder in the app
 * folder installer-assets.json lists. The exe ships it; in a checkout, `npm ci` then `npm run build`
 * in the app folder makes it.
 */
export const APP_BUILD = 'dist';

/**
 * The app's build relative to the source folder, with forward slashes.
 * @param {any} manifest  installer-assets.json.
 * @returns {string | undefined}
 */
export const appDistOf = (manifest) => (manifest?.app?.path ? posix.join(String(manifest.app.path).replaceAll('\\', '/'), APP_BUILD) : undefined);

/**
 * @typedef {object} Sources
 * @property {string} dir
 * @property {any} manifest  installer-assets.json.
 * @property {import('./catalog.js').NotebookInfo[]} catalog  Every notebook the installer can deploy, in pipeline order.
 * @property {Record<import('./catalog.js').NotebookKey, import('./transform/notebook.js').Notebook>} notebooks
 * @property {string} modelFile  `Consumption Central - Fabric.pbit`.
 * @property {string} [paxModelFile]  `Consumption Central - Viva Direct.pbit`, the PAX route's report.
 * @property {string[]} [paxScripts]  The PAX scripts' paths, when the installer has all of them.
 * @property {string} [appDist]  The app's build, when there is one.
 */

/**
 * @param {string} [dir]  The root of a Consumption Central checkout.
 * @returns {Sources}
 */
export function loadSources(dir = DEFAULT_SOURCE_DIR) {
  const root = resolve(dir);
  const manifestFile = join(root, MANIFEST_FILE);
  if (!existsSync(manifestFile)) throw new Error(`No ${MANIFEST_FILE} at ${root}. Point --source at the root of the repo.`);
  const manifest = readJson(manifestFile);
  const catalog = resolveNotebooks(manifest);
  /** @type {any} */
  const notebooks = {};
  for (const nb of catalog) {
    const file = join(nb.asset ? INSTALLER_ROOT : root, nb.path);
    if (!existsSync(file)) throw new Error(`Missing notebook ${file}.`);
    notebooks[nb.key] = readJson(file);
  }
  const template = manifest.templates?.fabric?.path;
  if (!template) throw new Error(`${manifestFile} has no templates.fabric.`);
  const modelFile = join(root, template);
  if (!existsSync(modelFile)) throw new Error(`Missing template ${modelFile}.`);
  const viva = manifest.templates?.vivaDirect?.path;
  const paxModelFile = viva ? join(root, viva) : undefined;
  const paxScripts = PAX_SCRIPTS.map((s) => join(RUNNER_DIR, s));
  const app = appDistOf(manifest);
  const appDist = app ? join(root, app) : undefined;
  return {
    dir: root,
    manifest,
    catalog,
    notebooks,
    modelFile,
    ...(paxModelFile && existsSync(paxModelFile) ? { paxModelFile } : {}),
    ...(paxScripts.every((s) => existsSync(s)) ? { paxScripts } : {}),
    ...(appDist && existsSync(join(appDist, 'index.html')) ? { appDist } : {}),
  };
}

/** @param {string} file */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}