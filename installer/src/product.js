// @ts-check
/**
 * Names the installer writes to disk, a tenant or GitHub, and the titles it shows. Prose says
 * Consumption Central. The launcher (Launcher.cs, install.ps1, app.manifest) and the web app repeat
 * some of these, and test/product.test.js checks they match.
 *
 * Shared with the AI in One and ValueLens installers: `<Product>Installer.exe`, the npm package and
 * command `<product>-installer`, the record `<product>-setup.json` and release tags
 * `<product>-installer-v*`.
 */

/** The name people see. */
export const PRODUCT_NAME = 'Consumption Central';
/** kebab-case: the command, the record, release tags and file names. */
export const PRODUCT_ID = 'consumption-central';
/** PascalCase: the exe, the %LOCALAPPDATA% folder and Fabric item names. */
export const PRODUCT_TOKEN = 'ConsumptionCentral';
/** snake_case: OneLake folders, Lakehouse tables and Spark session tags. */
export const PRODUCT_SNAKE = 'consumption_central';
/** Starts the name of each environment variable the launcher and the installer read. */
export const ENV_PREFIX = 'CONSUMPTION_CENTRAL';

export const REPO = 'microsoft/ConsumptionCentral-for-Microsoft-Copilot';
export const REPO_URL = `https://github.com/${REPO}`;
/** The install guide. The launcher links to its sections, and test/launcher.test.js checks they exist. */
export const DOCS_URL = `${REPO_URL}/blob/main/docs/INSTALL.md`;

// The installer
export const INSTALLER_TITLE = `${PRODUCT_NAME} installer`;
/** The npm package and the command. */
export const COMMAND = `${PRODUCT_ID}-installer`;
export const BIN_SCRIPT = `bin/${COMMAND}.js`;
export const TAG_PREFIX = `${COMMAND}-v`;
export const EXE_NAME = `${PRODUCT_TOKEN}Installer.exe`;
export const ZIP_NAME = `${PRODUCT_TOKEN}Installer.zip`;
export const USER_AGENT = `${PRODUCT_TOKEN}Installer`;

// This computer
export const RECORD_FILE = `${PRODUCT_ID}-setup.json`;
/** Written next to the record when an admin's step is handed off: what to send them. */
export const ADMIN_PACK_FILE = `${PRODUCT_ID}-admin-pack.md`;
/** Documents\Consumption Central, where the exe and install.ps1 start the installer, so the record lands there. */
export const DOCUMENTS_FOLDER = PRODUCT_NAME;
/** %LOCALAPPDATA%\ConsumptionCentral: the unpacked installer and the command install.ps1 leaves behind. */
export const HOME_FOLDER = PRODUCT_TOKEN;
export const SHIM = `${PRODUCT_ID}.cmd`;
/** Azure Cloud Shell: the unpacked installer and its command in ~/.consumption-central, the record in ~/consumption-central. */
export const CLOUD_SHELL_HOME = `.${PRODUCT_ID}`;
export const CLOUD_SHELL_WORK = PRODUCT_ID;
export const ENV = Object.freeze({
  EXE: `${ENV_PREFIX}_EXE`,
  LAUNCHER: `${ENV_PREFIX}_LAUNCHER`,
  CLOUD_SHELL: `${ENV_PREFIX}_CLOUD_SHELL`,
  USE_INSTALLED_NODE: `${ENV_PREFIX}_USE_INSTALLED_NODE`,
  ZIP: `${ENV_PREFIX}_ZIP`,
  PROXY: `${ENV_PREFIX}_PROXY`,
  NO_UPDATE_CHECK: `${ENV_PREFIX}_NO_UPDATE_CHECK`,
  /** The GitHub token, used instead of asking for it (with --yes, the only way to give one). It goes where tokenWhere says: Key Vault, or Ingest_GitHub_API. Never written to the install record. */
  GITHUB_TOKEN: `${ENV_PREFIX}_GITHUB_TOKEN`,
});
/** The web app's light or dark choice, in the browser's local storage. */
export const THEME_KEY = `${PRODUCT_ID}-theme`;

// The tenant
/** On the Azure resources the installer creates. A label only: nothing reads it back. */
export const RESOURCE_TAG = Object.freeze({ app: PRODUCT_TOKEN });
export const RESOURCE_GROUP = `rg-${PRODUCT_ID}`;
/** Key Vault names are 3-24 characters and global; the installer adds four hex digits. */
export const KEY_VAULT_PREFIX = `${PRODUCT_ID}-`;
export const WORKSPACE_NAME = PRODUCT_NAME;
export const LAKEHOUSE_NAME = PRODUCT_TOKEN;
/** Starts the names of the Fabric items the installer adds besides the source notebooks. */
export const ITEM_PREFIX = `${PRODUCT_TOKEN}_`;
export const APP_REGISTRATION = `${PRODUCT_NAME} (Fabric)`;
export const VIEWER_GROUP = `${PRODUCT_NAME} Viewers`;
export const SECRET_NAME = `${PRODUCT_ID}-client-secret`;
/** The GitHub token's Key Vault secret, read by Ingest_GitHub_API at run time. */
export const GITHUB_PAT_SECRET = `${PRODUCT_ID}-github-pat`;
/** Lakehouse folders and the table the installer keeps its own state in. */
export const INSTALLER_DIR = `Files/${PRODUCT_SNAKE}_installer`;
export const UPLOAD_DIR = `Files/${PRODUCT_SNAKE}_uploads`;
export const FLOWS_DIR = `Files/${PRODUCT_SNAKE}_flows`;
export const UPLOAD_LOG_TABLE = `dbo.${PRODUCT_SNAKE}_upload_log`;
/** On every notebook the pipeline runs, so they share Spark sessions. */
export const SESSION_TAG = PRODUCT_SNAKE;
