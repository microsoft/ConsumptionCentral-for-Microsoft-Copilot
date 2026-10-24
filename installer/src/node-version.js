// @ts-check
/** Which Node.js versions the installer download can be built with. */

/** The oldest Node.js the installer download is built with. */
export const MIN_NODE = /** @type {const} */ ([22, 13]);

/** @param {string} [version] */
export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}
