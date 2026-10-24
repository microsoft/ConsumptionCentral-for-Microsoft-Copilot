// @ts-check
/**
 * What goes into ConsumptionCentralInstaller.exe, kept apart from the build so it can be tested.
 * The payload unpacks to:
 *   node/node.exe              Node.js, which runs everything below
 *   f/installer/               the installer, with its production dependencies, helper notebooks and PAX scripts
 *   f/installer/managed-cli/   the Copilot managed apps CLI that deploys the app, with its dependencies
 *   f/app/dist/                the app, built
 *   f/<templates>              installer-assets.json and the notebooks and templates it lists
 * `f` stands in for the repo root, which keeps paths short when unpacked under the user's profile.
 */
import { posix } from 'node:path';
import { MANIFEST_FILE, resolveNotebooks } from '../src/catalog.js';
import { EXE_NAME, PRODUCT } from '../src/product.js';

export { EXE_NAME };
/** The source folder (the repo root) inside the payload. */
export const SOURCE_ROOT = 'f';
/**
 * Longest path allowed inside the payload. It unpacks to
 * `%LOCALAPPDATA%\ConsumptionCentral\<version>-<hash>\`, about 70 characters for a typical profile, so
 * the deepest dependencies end up past Windows' 260-character limit. The launcher and Node.js
 * both use extended-length paths, which don't have that limit; this catches a dependency tree
 * that suddenly nests much deeper.
 */
export const MAX_PAYLOAD_PATH = 200;
/**
 * Longest path allowed for a native binary. Windows loads DLLs and Node.js addons only from
 * paths under 260 characters, so these must fit even under a long user name.
 */
export const MAX_NATIVE_PATH = 120;
/** The folder under the installer that pins the managed apps CLI. The build installs its dependencies. */
export const MANAGED_CLI_DIR = 'managed-cli';
/**
 * The list of sample files the built app fetches when it opens (app/src/data/load.ts), relative to
 * the build. The app's public folder holds them, committed, and the build copies them.
 */
export const APP_SAMPLE_MANIFEST = 'sample/manifest.json';
export { MIRROR_REGISTRY, PUBLIC_REGISTRY, publicRegistry } from './registry.js';

/** @param {string} p */
const slash = (p) => p.replaceAll('\\', '/');

/**
 * The files under the source folder that `loadSources` reads, relative to it: the Fabric route's
 * notebooks and template, and the PAX route's template with the queries it swaps in, which it reads
 * from beside the template. The helper notebooks and PAX scripts ship under the installer folder
 * instead (`installerFile`), and the app's build is made by the exe build.
 * @param {any} manifest  installer-assets.json
 * @returns {string[]}
 */
export function sourceFiles(manifest) {
  const viva = manifest.templates.vivaDirect?.path;
  if (!viva) throw new Error(`${MANIFEST_FILE} has no templates.vivaDirect, the PAX route's template.`);
  return [
    MANIFEST_FILE,
    ...resolveNotebooks(manifest).filter((nb) => !nb.asset).map((nb) => posix.normalize(slash(nb.path))),
    manifest.templates.fabric.path,
    viva,
    ...paxQueryFiles().map((f) => posix.join(posix.dirname(slash(viva)), f)),
  ].map(slash);
}

/** The files of the queries the PAX route swaps into its template (`PRODUCT.pax.expressions`). */
export const paxQueryFiles = () => Object.values(PRODUCT.pax.expressions ?? {}).flatMap((v) => (typeof v === 'string' ? [] : [v.file]));

/**
 * The sample files the built app fetches when it opens: the list, then each file on it.
 * @param {string[]} names  The list's entries.
 */
export const appSampleFiles = (names) => [APP_SAMPLE_MANIFEST, ...names.map((n) => posix.join(posix.dirname(APP_SAMPLE_MANIFEST), n))];

/**
 * Whether a tracked installer file ships, given its path relative to the installer folder.
 * @param {string} rel
 */
export function installerFile(rel) {
  return /^(assets|bin|src)\//.test(rel)
    || ['package.json', 'package-lock.json', 'README.md'].includes(rel)
    || [`${MANAGED_CLI_DIR}/package.json`, `${MANAGED_CLI_DIR}/package-lock.json`].includes(rel);
}

/**
 * Names the payload by version and content, so a new download unpacks afresh.
 * @param {string} version
 * @param {string} sha256  Hex digest of the payload zip.
 */
export function payloadId(version, sha256) {
  return `${version}-${sha256.slice(0, 10)}`;
}

/**
 * The `x.y.z.0` form Windows file versions take.
 * @param {string} version
 */
export function fileVersion(version) {
  const parts = version.split(/[.+-]/).slice(0, 3).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (parts.length < 3 || parts.some((n) => !(n >= 0 && n <= 65534))) throw new Error(`Can't make a file version from "${version}".`);
  return `${parts.join('.')}.0`;
}

/** The folder under @azure/msal-node-runtime's dist/windows for each Node.js architecture. */
const MSAL_ARCH = /** @type {Record<string, string>} */ ({ x64: 'x64', arm64: 'arm64', ia32: 'x86' });
const MSAL_RUNTIME = /(?:^|\/)node_modules\/@azure\/msal-node-runtime\/dist\/(windows|macos|linux)\/(.+)$/i;

/**
 * The folder of the sign-in broker's Windows binaries that a Node.js architecture loads.
 * @param {string} [arch]
 */
export const msalRuntimeArch = (arch = process.arch) => MSAL_ARCH[arch] ?? arch;

/**
 * Whether an installed package's file can be left out of the payload: source maps, which nothing
 * reads when the installer runs, and the sign-in broker's binaries for other platforms. The managed
 * apps CLI's @azure/msal-node-runtime ships every platform's (about 36 MB), where npm installs the
 * other native packages for the building PC's platform only.
 * @param {string} rel  Relative to the payload root.
 * @param {string} [arch]  The Node.js architecture the payload runs on: the one that builds it.
 */
export function prunable(rel, arch = process.arch) {
  if (/(^|\/)node_modules\/.+\.map$/i.test(rel)) return true;
  const msal = MSAL_RUNTIME.exec(rel);
  if (!msal) return false;
  return msal[1].toLowerCase() !== 'windows' || !msal[2].startsWith(`${msalRuntimeArch(arch)}/`);
}

/**
 * The payload paths too long to unpack and run safely.
 * @param {string[]} files  Relative to the payload root.
 * @param {{ max?: number, native?: number }} [limits]
 */
export function tooLong(files, { max = MAX_PAYLOAD_PATH, native = MAX_NATIVE_PATH } = {}) {
  return files.filter((f) => f.length > (/\.(node|dll|exe)$/i.test(f) ? native : max));
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * GUIDs in a developer's local settings, such as their workspace and model IDs.
 * @param {string[]} texts
 * @param {Iterable<string>} [allowed]  IDs that are fine to ship, such as those the repo already holds.
 */
export function localIds(texts, allowed = []) {
  const skip = new Set([...allowed].map((a) => a.toLowerCase()));
  /** @type {Set<string>} */
  const ids = new Set();
  for (const t of texts) for (const m of t.matchAll(GUID)) if (!skip.has(m[0].toLowerCase())) ids.add(m[0].toLowerCase());
  return ids;
}

/**
 * The local IDs that turn up in a shipped file.
 * @param {string} text
 * @param {Set<string>} ids
 */
export function leakedIds(text, ids) {
  return [...new Set([...text.matchAll(GUID)].map((m) => m[0].toLowerCase()))].filter((id) => ids.has(id));
}
