// @ts-check
/**
 * Key Vault, the app registration and its secret, admin consent, and the GitHub token: whichever the
 * chosen sources need. Each step checks what is already there, so a re-run only does what is missing.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appNeeded, appWanted, GRAPH_APP_ID, secretWanted } from '../catalog.js';
import { allowsAction, isPrivateVault, networkBlocked, ROLES } from '../clients/azure.js';
import { adminConsentUrl, apiPermissionsUrl, declaredGraphRoles, resolveAppRoles } from '../clients/graph.js';
import { secretMode } from '../config.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { ADMIN_PACK_FILE, ENV, INSTALLER_TITLE, PRODUCT_NAME } from '../product.js';
import { appName, isPax, requiredPermissions, retiredPermissions } from '../target.js';
import { c, listJoin } from '../ui.js';
import { askGithubToken, githubContentType, githubSecretName, GITHUB_TOKEN_SCOPES, TOKENS_URL } from './github.js';
import { APP_NAME } from './plan.js';
import { pnpGrantCommand, siteGrantCommands, SITE_ADMIN } from './pax/site.js';
import { addTrackedSecret, adoptAttempts, promoteSecret, settleFailedSecret } from './secrets.js';

export { ADMIN_PACK_FILE };

/** @typedef {import('../install.js').Ctx} Ctx */

export const SECRET_LIFETIME_MONTHS = 12;

/** The Key Vault secret's name on the app, before the ref of the run that made it. */
const VAULT_SECRET_LABEL = INSTALLER_TITLE;

/** Without Key Vault the secret is readable in the workspace, so it lasts days, not months, and every run of the installer replaces it. */
export const NOTEBOOK_SECRET_DAYS = 90;
export const MAX_SECRET_DAYS = 730;

/**
 * How long a client secret kept in the notebooks lasts: --secret-days, or 90 days.
 * @param {import('../config.js').InstallConfig} config
 */
export const notebookSecretDays = (config) => config.app.secretDays ?? NOTEBOOK_SECRET_DAYS;

/**
 * Thrown when the user stops to wait for someone else, such as a vault admin. The install
 * record is saved, and running the installer again carries on from the same point.
 */
export class ResumeLater extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ResumeLater';
  }
}

/** @param {unknown} err */
export const isResumeLater = (err) => /** @type {Error | undefined} */ (err)?.name === 'ResumeLater';

/**
 * Permissions some tenants don't have yet, and what happens without them. None of Consumption
 * Central's: User.Read.All is in every tenant.
 * @type {Record<string, string>}
 */
export const OPTIONAL_PERMISSION_EFFECTS = {};

export const OPTIONAL_PERMISSIONS = Object.keys(OPTIONAL_PERMISSION_EFFECTS);

/** @param {unknown} err @param {number} status */
const isStatus = (err, status) => err instanceof HttpError && err.status === status;

/** @param {unknown} err */
const isNetworkBlock = (err) => err instanceof HttpError && err.status === 403 && networkBlocked(err.body ?? err.message);

/**
 * @param {Date} from
 * @param {number} months
 */
export function addMonths(from, months) {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * @param {Date} from
 * @param {number} days
 */
export function addDays(from, days) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Graph's service principal and the app roles the route and the chosen sources need, looked up once per run.
 * @param {Ctx} ctx
 */
export async function graphRoles(ctx) {
  if (!ctx.graphRoles) {
    const sp = await ctx.api.graph.graphServicePrincipal();
    const { roles, missing } = resolveAppRoles(sp, requiredPermissions(ctx.config), OPTIONAL_PERMISSIONS);
    for (const m of missing) {
      ctx.ui.warn(`Microsoft Graph in this tenant has no ${m} permission yet. ${OPTIONAL_PERMISSION_EFFECTS[m] ?? ''}`.trim());
    }
    ctx.graphRoles = { sp, roles };
  }
  return ctx.graphRoles;
}

/**
 * Graph app roles that an app the installer made may have for a choice since switched off, such as
 * the PAX route's Agent 365 file. None for an app the user brought, which keeps what it has.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ appRoles: { id: string, value: string }[] }} graphSp
 */
function retiredRoles(config, graphSp) {
  if (config.app.existing) return [];
  const retired = retiredPermissions(config);
  return resolveAppRoles(graphSp, retired, retired).roles;
}

/** @param {{ value: string }[]} roles */
const roleNames = (roles) => roles.map((r) => r.value).join(', ');

/**
 * The secrets this install keeps, for messages: the app's client secret, the GitHub token, or both.
 * @param {import('../config.js').InstallConfig} config
 * @returns {string[]}
 */
export function keptSecrets(config) {
  const kept = [];
  if (appWanted(config.dataSources)) kept.push('the client secret');
  if (config.dataSources.github === 'api') kept.push('the GitHub token');
  return kept;
}

/**
 * Creates or adopts the vault and makes sure the signed-in user can write secrets to it.
 * @param {Ctx} ctx
 */
export async function ensureKeyVault(ctx) {
  const { ui, config, api, user } = ctx;
  const kv = config.keyVault;
  if (secretMode(config) === 'notebook') {
    const kept = keptSecrets(config);
    const many = kept.length > 1;
    ui.info(`No Key Vault: ${listJoin(kept)} ${many ? 'are' : 'is'} written into the notebooks, where anyone with a role in the workspace can read ${many ? 'them' : 'it'}.`);
    return;
  }
  if (kv.uri && kv.id) {
    const vault = await api.arm.getVault(kv.id).catch(() => null);
    if (vault) setPrivate(ctx, isPrivateVault(vault));
    ctx.save();
    ui.ok(`Key Vault ${kv.name} is ready`);
    return;
  }

  if (kv.existing) {
    if (!kv.id) throw new Error('The install record names an existing Key Vault but not its resource ID.');
    const vault = await api.arm.getVault(kv.id);
    kv.uri = vault.properties.vaultUri;
    kv.rbac = vault.properties.enableRbacAuthorization === true;
    kv.location = vault.location;
    setPrivate(ctx, isPrivateVault(vault));
    if (secretMode(config) === 'keyvault-admin') await grantReadAccess(ctx, vault);
    else await grantSecretAccess(ctx, vault);
    ctx.save();
    ui.ok(`Using Key Vault ${kv.name}`);
    return;
  }

  const { subscriptionId, resourceGroup, name, location } = kv;
  if (!subscriptionId || !resourceGroup || !name || !location) {
    throw new Error('Key Vault settings are incomplete. Run the installer without --yes to choose them.');
  }
  // Contributor on a resource group can create a vault but can't register providers or create groups.
  try {
    if (await api.arm.ensureProvider(subscriptionId, 'Microsoft.KeyVault')) ui.ok('Registered the Microsoft.KeyVault resource provider');
  } catch (err) {
    if (!isStatus(err, 403)) throw err;
    ui.note('You can\'t check resource providers in this subscription. Carrying on: Microsoft.KeyVault is usually registered already.');
  }
  if (!(await api.arm.getResourceGroup(subscriptionId, resourceGroup))) {
    try {
      await api.arm.ensureResourceGroup(subscriptionId, resourceGroup, location);
      ui.ok(`Created resource group ${resourceGroup}`);
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
      throw new Error(`You can't create resource groups in this subscription. Run the installer again and give the name of an existing resource group you can write to (Contributor on it is enough).`);
    }
  }
  let vault;
  try {
    vault = await api.arm.createVault({
      subscriptionId,
      resourceGroup,
      name,
      location,
      tenantId: user.tenantId,
      rbac: !!kv.rbac,
      accessPolicyObjectId: user.id,
    });
  } catch (err) {
    if (err instanceof HttpError && /MissingSubscriptionRegistration|not registered to use namespace/i.test(JSON.stringify(err.body ?? err.message))) {
      throw new Error(`The subscription isn't registered for Microsoft.KeyVault. Ask a subscription Owner or Contributor to register the Microsoft.KeyVault resource provider, then run the installer again.`);
    }
    throw err;
  }
  kv.id = vault.id;
  kv.uri = vault.properties.vaultUri;
  kv.rbac = vault.properties.enableRbacAuthorization === true;
  ctx.save();
  ui.ok(`Created Key Vault ${name} in ${resourceGroup}`);
  setPrivate(ctx, isPrivateVault(vault));
  if (kv.rbac) {
    await api.arm.assignRole(/** @type {string} */ (kv.id), ROLES.keyVaultSecretsOfficer, user.id, 'User');
    ui.ok('Gave you Key Vault Secrets Officer on it');
  }
}

/**
 * Records whether the vault blocks public network access. A private vault gets its secret
 * through Resource Manager, and the workspace reaches it through a managed private endpoint.
 * @param {Ctx} ctx
 * @param {boolean} isPrivate
 */
function setPrivate(ctx, isPrivate) {
  const kv = ctx.config.keyVault;
  if (isPrivate && !kv.private) {
    ctx.ui.info(
      `${kv.name} blocks public network access (often set by Azure Policy). The installer saves the secret ` +
        'through Azure Resource Manager and connects the workspace to the vault with a managed private endpoint.',
    );
  }
  kv.private = isPrivate;
  ctx.save();
}

/**
 * @param {Ctx} ctx
 * @param {any} vault
 */
async function grantSecretAccess(ctx, vault) {
  const { ui, api, user } = ctx;
  if (vault.properties.enableRbacAuthorization) {
    try {
      const added = await api.arm.assignRole(vault.id, ROLES.keyVaultSecretsOfficer, user.id, 'User');
      if (added) ui.ok('Gave you Key Vault Secrets Officer on it');
      return;
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
    }
    const perms = await api.arm.permissions(vault.id).catch(() => []);
    if (allowsAction(perms, 'Microsoft.KeyVault/vaults/secrets/setSecret/action', 'dataActions')) return;
    throw new Error(`You can't write secrets to ${vault.name}. Ask its owner for the Key Vault Secrets Officer role, or let the installer create a new vault.`);
  }

  const policies = /** @type {any[]} */ (vault.properties.accessPolicies ?? []);
  const mine = policies.find((p) => p.objectId === user.id);
  const secrets = new Set((mine?.permissions?.secrets ?? []).map((/** @type {string} */ s) => s.toLowerCase()));
  if (['get', 'set'].every((s) => secrets.has(s) || secrets.has('all'))) return;
  try {
    await api.arm.addAccessPolicy(vault.id, user.tenantId, user.id);
    ui.ok('Added an access policy for you (secret get, list, set)');
  } catch (err) {
    if (!isStatus(err, 403)) throw err;
    throw new Error(`You can't change access policies on ${vault.name}. Ask its owner to give you secret get and set, or let the installer create a new vault.`);
  }
}

/**
 * Whether the signed-in user can write secrets to the vault now, or can give themselves the
 * right to. Asked before anything is created, so a user without it can choose another way.
 * @param {Ctx} ctx
 * @param {any} vault  ARM vault resource.
 * @returns {Promise<boolean>}
 */
export async function canWriteSecrets(ctx, vault) {
  const { api, user } = ctx;
  const perms = await api.arm.permissions(vault.id).catch(() => null);
  if (!perms) return true;
  if (vault.properties?.enableRbacAuthorization) {
    return (
      allowsAction(perms, 'Microsoft.KeyVault/vaults/secrets/setSecret/action', 'dataActions') ||
      allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write')
    );
  }
  const mine = /** @type {any[]} */ (vault.properties?.accessPolicies ?? []).find((p) => p.objectId === user.id);
  const secrets = new Set((mine?.permissions?.secrets ?? []).map((/** @type {string} */ s) => s.toLowerCase()));
  if (secrets.has('set') || secrets.has('all')) return true;
  return allowsAction(perms, 'Microsoft.KeyVault/vaults/accessPolicies/write') || allowsAction(perms, 'Microsoft.KeyVault/vaults/write');
}

/**
 * With a vault admin adding the secret, the user only needs to read it: scheduled runs call
 * getSecret as the schedule's owner. Gives them that when they can; otherwise the admin is asked to.
 * @param {Ctx} ctx
 * @param {any} vault
 */
async function grantReadAccess(ctx, vault) {
  const { ui, api, user, config } = ctx;
  const kv = config.keyVault;
  kv.handoff ??= {};
  if (vault.properties.enableRbacAuthorization) {
    const perms = await api.arm.permissions(vault.id).catch(() => []);
    if (allowsAction(perms, 'Microsoft.KeyVault/vaults/secrets/getSecret/action', 'dataActions')) {
      delete kv.handoff.grantRead;
      return;
    }
    try {
      if (await api.arm.assignRole(vault.id, ROLES.keyVaultSecretsUser, user.id, 'User')) ui.ok('Gave you Key Vault Secrets User on it, so scheduled runs can read the secret');
      delete kv.handoff.grantRead;
      return;
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
    }
  } else {
    const mine = /** @type {any[]} */ (vault.properties.accessPolicies ?? []).find((p) => p.objectId === user.id);
    const secrets = new Set((mine?.permissions?.secrets ?? []).map((/** @type {string} */ s) => s.toLowerCase()));
    if (secrets.has('get') || secrets.has('all')) {
      delete kv.handoff.grantRead;
      return;
    }
    try {
      await api.arm.addAccessPolicy(vault.id, user.tenantId, user.id, ['get', 'list']);
      ui.ok('Added an access policy for you (secret get, list), so scheduled runs can read the secret');
      delete kv.handoff.grantRead;
      return;
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
    }
  }
  kv.handoff.grantRead = true;
  ui.warn(`You can't give yourself read access to ${vault.name}. The vault admin's steps include it.`);
}

/**
 * The Cloud Shell (bash) command a vault admin runs to store the GitHub token. It reads the token
 * without echoing it, so it isn't on screen or in the shell's history.
 * @param {import('../config.js').InstallConfig} config
 */
export function githubHandoffCommand(config) {
  const kv = config.keyVault;
  return (
    `read -rs -p "GitHub token: " T && echo && az keyvault secret set --vault-name ${kv.name} --name ${githubSecretName(config)} ` +
    `--content-type "${githubContentType(config)}" --value "$T" --query id -o tsv; unset T`
  );
}

/**
 * The Cloud Shell (bash) commands a vault admin runs. The client secret is created on the app and
 * stored in the vault in one go, so its value is never shown to anyone; the GitHub token is pasted
 * straight into the command that stores it.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ userId?: string, secret?: boolean, githubToken?: boolean }} [o]
 *   userId: also gives this user read access, when the handoff needs it. secret: the client secret
 *   (the default). githubToken: the GitHub token.
 * @returns {string[]}
 */
export function handoffCommands(config, o = {}) {
  const kv = config.keyVault;
  const appId = config.app.appId ?? '<application (client) ID>';
  const lines = [];
  if (o.userId && kv.handoff?.grantRead) {
    lines.push(
      kv.rbac
        ? `az role assignment create --role "Key Vault Secrets User" --assignee-object-id ${o.userId} --assignee-principal-type User --scope ${kv.id}`
        : `az keyvault set-policy --name ${kv.name} --object-id ${o.userId} --secret-permissions get list`,
    );
  }
  if (o.secret ?? true) {
    lines.push(
      `az keyvault secret set --vault-name ${kv.name} --name ${kv.secretName} --content-type "Client secret for ${appId}" ` +
        `--value "$(az ad app credential reset --id ${appId} --append --display-name "${PRODUCT_NAME}" --years 1 --query password -o tsv)" --query id -o tsv`,
    );
  }
  if (o.githubToken) lines.push(githubHandoffCommand(config));
  return lines;
}

/**
 * Hands secrets over to a vault admin: the app's client secret, the GitHub token, or both at once.
 * Shows what to run, optionally makes the admin an owner of the app so they can create its secret,
 * then waits for the user to say it's done. The values never reach the installer. Returns false
 * when the run carries on without them (--yes).
 * @param {Ctx} ctx
 * @param {{ rotate?: boolean, secret?: boolean, githubToken?: boolean }} [o]
 *   secret: the client secret (the default). githubToken: the GitHub token, as well or instead.
 */
export async function secretHandoff(ctx, o = {}) {
  const { ui, config, user } = ctx;
  const { app, keyVault: kv } = config;
  const secret = o.secret ?? true;
  const token = !!o.githubToken;
  kv.handoff ??= {};
  const h = kv.handoff;
  // As when the installer writes it: a shared vault may already hold another install's secret under this name.
  if (!o.rotate && secret && claimsName(ctx)) {
    try {
      await claimSecretName(ctx);
    } catch (err) {
      if (/no free secret name/.test(/** @type {Error} */ (err).message)) throw err;
      ui.note(
        `Couldn't check whether ${kv.name} already has a secret called ${kv.secretName}. If it holds another app's secret, ` +
          'the admin shouldn\'t replace it: run the installer again and choose another secret name.',
      );
    }
  }
  if (token) {
    try {
      await claimGithubSecretName(ctx);
    } catch (err) {
      if (/no free secret name/.test(/** @type {Error} */ (err).message)) throw err;
      ui.note(
        `Couldn't check whether ${kv.name} already has a secret called ${githubSecretName(config)}. If it holds another install's token, ` +
          'the admin shouldn\'t replace it: ask them to give you read access first, then run the installer again, and it picks a free name.',
      );
    }
  }
  const ghName = githubSecretName(config);
  const both = secret && token;
  const verb = o.rotate ? 'replaced' : 'added';
  /** @param {string} a @param {string} b */
  const which = (a, b) => listJoin([secret ? a : '', token ? b : ''].filter(Boolean));

  ui.warn(`A vault admin needs to ${o.rotate ? 'replace' : 'add'} ${which('the client secret', 'the GitHub token')} in ${kv.name}. The installer never sees ${both ? 'their values' : 'its value'}.`);
  ui.info(`Vault:   ${kv.name}${kv.id ? c.dim(`  https://portal.azure.com/#@${user.tenantId}/resource${kv.id}/secrets`) : ''}`);
  if (secret) {
    ui.info(`Secret:  ${kv.secretName}`);
    ui.info(`App:     ${app.displayName ?? APP_NAME} (${app.appId})`);
  }
  if (token) ui.info(`Token:   ${ghName}, a classic GitHub token with scope ${GITHUB_TOKEN_SCOPES}, made by an owner or billing manager of ${config.github?.enterprise}`);
  if (h.grantRead) ui.info(`Reader:  ${user.upn}, who needs ${kv.rbac ? 'Key Vault Secrets User' : 'an access policy with secret get and list'} so scheduled runs can read ${both ? 'them' : 'it'}`);
  ui.info(`They can run this in Azure Cloud Shell (Bash)${token ? ', and paste the token when asked' : ''}:`);
  for (const line of handoffCommands(config, { userId: user.id, secret, githubToken: token })) ui.info(`  ${line}`);
  if (kv.private) ui.note(`${kv.name} blocks public network access, so run it from a network that can reach the vault, or use the portal steps below.`);
  if (secret) {
    ui.note(
      `Or in the Azure portal: App registrations > ${app.displayName ?? app.appId} > Certificates & secrets > New client secret, then copy its Value into ` +
        `${kv.name} > Secrets > Generate/Import with the name ${kv.secretName}.`,
    );
  }
  if (token) {
    ui.note(`${secret ? 'For the token' : 'Or in the Azure portal'}: ${kv.name} > Secrets > Generate/Import with the name ${ghName}, and the token as its value.`);
    ui.note('The installer never sees the token, so it can\'t check it or tell you before it expires.');
  }
  if (o.rotate && secret) ui.note('Once a run has succeeded with the new secret, delete the old one from the app\'s Certificates & secrets page.');
  if (o.rotate && token) ui.note(`Once GitHub data has loaded with the new token, revoke the old one at ${TOKENS_URL}.`);

  if (secret && !ui.yes && !app.existing && app.objectId) {
    const email = (await ui.input('Vault admin\'s email, to make them an owner of the app so they can create its secret (leave blank to skip)', { default: h.adminEmail ?? '' })).trim();
    if (email) await addAdminOwner(ctx, email);
  }
  if (secret && !h.adminEmail) ui.note('Creating the secret needs an owner of the app, or an Application Administrator or Cloud Application Administrator.');
  h.shownAt = ctx.now().toISOString();
  ctx.handoffShown ??= new Set();
  if (secret) ctx.handoffShown.add('secret');
  if (token) ctx.handoffShown.add('githubToken');
  ctx.save();

  if (ui.yes) {
    const until = [
      secret ? `Data loads fail until the secret is in ${kv.name}.` : '',
      token ? `GitHub data doesn't load until the token is in ${kv.name}.` : '',
    ].filter(Boolean);
    ui.warn(`Carrying on. ${until.join(' ')} Run ${which(`"${commandLine('rotate-secret')}"`, `"${commandLine('github-token')}"`)} to see these steps again.`);
    return false;
  }
  const next = await ui.select(
    `Has the admin ${verb} ${which('the secret', 'the GitHub token')}?`,
    [
      { name: 'Yes, carry on', value: 'go' },
      { name: 'Stop and resume later', value: 'stop', description: `Your answers are saved. Run the installer again once ${both ? 'they\'re' : 'it\'s'} there.` },
    ],
    'go',
  );
  if (next === 'stop') throw new ResumeLater(`Stopped until the vault admin has ${verb} ${which('the secret', 'the GitHub token')}. Run the installer again to carry on from here.`);
  h.confirmedAt = ctx.now().toISOString();
  if (secret) {
    kv.secretSetAt = h.confirmedAt;
    if (o.rotate) delete app.secretExpires;
  }
  const gh = config.github;
  if (token && gh) {
    gh.secretName ??= ghName;
    gh.tokenSetAt = h.confirmedAt;
    delete gh.tokenExpires;
  }
  ctx.save();
  ui.ok(`The vault admin has ${verb} ${which(`the secret ${kv.secretName}`, `the GitHub token ${ghName}`)}`);
  return true;
}

/**
 * Makes the vault admin an owner of the app, so they can create its client secret.
 * @param {Ctx} ctx
 * @param {string} email
 */
async function addAdminOwner(ctx, email) {
  const { ui, config, api } = ctx;
  const app = config.app;
  try {
    const admin = await api.graph.getUser(email);
    if (!admin) {
      ui.warn(`No user ${email} in this tenant. Send the steps above to the admin instead.`);
      return;
    }
    try {
      await api.graph.addOwner(/** @type {string} */ (app.objectId), admin.id);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 400 && /already exist/i.test(JSON.stringify(err.body ?? err.message)))) throw err;
    }
    config.keyVault.handoff ??= {};
    config.keyVault.handoff.adminEmail = admin.userPrincipalName ?? email;
    ui.ok(`Made ${admin.displayName ?? email} an owner of ${app.displayName ?? 'the app'}, so they can create its secret`);
  } catch (err) {
    ui.warn(`Couldn't make ${email} an owner of the app (${/** @type {Error} */ (err).message}).`);
  }
}

/**
 * Creates or adopts the app registration and its service principal. On the Fabric route it also puts a
 * client secret in Key Vault when the sources need one; the PAX route keeps its secret in Credential
 * Manager on the PC instead. An app the installer made loses the API permissions it no longer uses.
 * @param {Ctx} ctx
 * @param {{ secret?: boolean }} [o]  secret: false when only the semantic model's connection signs in as
 *   the app. That connection gets its own secret (ensureModelConnection), so none is kept here.
 */
export async function ensureApp(ctx, o = {}) {
  const { ui, config, api } = ctx;
  const app = config.app;
  const name = appName(config);
  const { sp: graphSp, roles } = await graphRoles(ctx);

  if (app.appId) {
    const application = await api.graph.findApplication(app.appId);
    if (!application) {
      throw new Error(
        app.existing
          ? `No app registration with ID ${app.appId} in this tenant.`
          : `The app registration ${app.appId} in the install record no longer exists. Delete the "app" section of the install record to create a new one.`,
      );
    }
    app.objectId = application.id;
    app.displayName = application.displayName;
    // Before the additions, which then see what's left.
    const declared = declaredGraphRoles(application);
    const unused = retiredRoles(config, graphSp).filter((r) => declared.has(r.id));
    if (unused.length) {
      try {
        await api.graph.removeRequiredAccess(application, unused);
        ui.ok(`Took ${roleNames(unused)} off its API permissions, as ${PRODUCT_NAME} no longer uses ${unused.length > 1 ? 'them' : 'it'}`);
      } catch (err) {
        if (!isStatus(err, 403)) throw err;
        ui.warn(`You can't edit ${application.displayName}'s API permissions, so it still lists ${roleNames(unused)}, which ${PRODUCT_NAME} no longer uses. An admin can remove ${unused.length > 1 ? 'them' : 'it'}.`);
      }
    }
    try {
      if (await api.graph.ensureRequiredAccess(application, roles)) ui.ok(`Added the ${PRODUCT_NAME} permissions to its API permissions`);
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
      ui.warn(`You can't edit ${application.displayName}'s API permissions. An admin must add these Graph application permissions: ${roles.map((r) => r.value).join(', ')}.`);
    }
    ui.ok(`Using app registration "${application.displayName}" (${app.appId})`);
  } else {
    /** @type {any} */
    let application;
    try {
      application = await api.graph.createApplication(name, roles);
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
      const perms = roles.map((r) => r.value);
      throw new Error(
        `You can't create app registrations in this tenant. Ask an admin to create one${perms.length ? ` with admin consent for these Microsoft Graph application permissions: ${perms.join(', ')}` : ''}, ` +
          'then run the installer again and choose "Use an app registration I already have".',
      );
    }
    app.appId = application.appId;
    app.objectId = application.id;
    app.displayName = application.displayName;
    app.existing = false;
    ctx.save();
    ui.ok(`Created app registration "${name}" (${app.appId})`);
  }

  if (!app.servicePrincipalId) {
    const appId = /** @type {string} */ (app.appId);
    let sp = await api.graph.findServicePrincipal(appId);
    if (!sp) {
      sp = await api.graph.createServicePrincipal(appId);
      ui.ok('Created its service principal');
    }
    app.servicePrincipalId = sp.id;
  }
  ctx.save();

  if (o.secret !== false && !isPax(config)) await ensureSecret(ctx);
}

/** @param {Ctx} ctx */
export async function ensureSecret(ctx) {
  const { ui, config } = ctx;
  const { app, keyVault: kv } = config;
  const mode = secretMode(config);

  if (mode === 'notebook') {
    ui.ok('The client secret goes into the notebooks when they are written');
    return;
  }
  if (mode === 'keyvault-admin') {
    delete ctx.pendingSecret;
    if (kv.secretSetAt) {
      ui.ok(`The vault admin added the client secret to ${kv.name} as ${kv.secretName}`);
      if (kv.handoff?.grantRead) {
        ui.warn(`You still need read access to ${kv.name} so scheduled runs can read it. Ask the vault admin to run:`);
        ui.info(`  ${handoffCommands(config, { userId: ctx.user.id })[0]}`);
      }
      return;
    }
    // One handoff for both, when the GitHub token is wanted too.
    await secretHandoff(ctx, { githubToken: config.dataSources?.github === 'api' && !!config.github?.enterprise && !config.github.tokenSetAt });
    return;
  }

  if (!app.existing) {
    await adoptAttempts(ctx, kv, app.objectId, VAULT_SECRET_LABEL);
    // A stopped run may have put its secret in the vault after the one recorded there. A new one
    // makes it certain which the vault has; the uncertain one is kept until then.
    if (!ctx.pendingSecret && kv.secretSetAt && kv.pendingSecretKeyIds?.length) {
      ui.warn(`A run that stopped part-way added a client secret (key ${kv.pendingSecretKeyIds.join(', ')}) and may have saved it to Key Vault. Making a new one, so it's certain which the vault has.`);
      await newSecret(ctx);
      return;
    }
  }

  if (!ctx.pendingSecret && kv.secretSetAt) {
    if (await secretExists(ctx)) {
      ui.ok(`Client secret is in Key Vault as ${kv.secretName}`);
      return;
    }
    ui.warn(`Key Vault has no secret called ${kv.secretName} any more.`);
  }

  if (app.existing && !ctx.pendingSecret) {
    ctx.pendingSecret = await ui.secret(`Client secret value for ${app.displayName ?? app.appId}. It goes straight to Key Vault.`);
  }
  if (ctx.pendingSecret) {
    if (claimsName(ctx)) {
      await checkSecretAccess(ctx);
      await claimSecretName(ctx);
    }
    await writeSecret(ctx, ctx.pendingSecret, { contentType: `Client secret for ${app.appId}` });
    delete ctx.pendingSecret;
    kv.secretSetAt = ctx.now().toISOString();
    ctx.save();
    ui.ok(`Saved the client secret to Key Vault as ${kv.secretName}`);
    return;
  }
  await newSecret(ctx);
}

/**
 * Tries the vault's own endpoint first. If the vault turns out to block public access,
 * remembers that and goes through Resource Manager instead.
 * @template T
 * @param {Ctx} ctx
 * @param {(uri: string) => Promise<T>} direct
 * @param {(vaultId: string) => Promise<T>} viaArm
 * @returns {Promise<T>}
 */
async function onVault(ctx, direct, viaArm) {
  const kv = ctx.config.keyVault;
  if (!kv.private) {
    try {
      return await direct(/** @type {string} */ (kv.uri));
    } catch (err) {
      if (!isNetworkBlock(err)) throw err;
      setPrivate(ctx, true);
    }
  }
  if (!kv.id) throw new Error(`${kv.name} blocks public network access and the install record has no resource ID for it.`);
  return viaArm(kv.id);
}

/** @param {Ctx} ctx @param {string} [name] */
const secretExists = (ctx, name = ctx.config.keyVault.secretName) =>
  onVault(
    ctx,
    (uri) => ctx.api.keyVault.secretExists(uri, name),
    (id) => ctx.api.arm.secretExists(id, name),
  );

/** @param {Ctx} ctx @param {string} name */
const secretInfo = (ctx, name) =>
  onVault(
    ctx,
    (uri) => ctx.api.keyVault.secretInfo(uri, name),
    (id) => ctx.api.arm.secretInfo(id, name),
  );

/**
 * True when the secret name still needs checking: a vault this install didn't make,
 * and no secret written to it yet.
 * @param {Ctx} ctx
 */
const claimsName = (ctx) => Boolean(ctx.config.keyVault.existing && !ctx.config.keyVault.secretSetAt);

/**
 * In a vault shared with another install, the default name may already hold that install's
 * secret. Anything not labelled as this app's secret is left alone and a free name is used.
 * @param {Ctx} ctx
 */
async function claimSecretName(ctx) {
  const { ui, config } = ctx;
  const kv = config.keyVault;
  const ours = `Client secret for ${config.app.appId}`;
  const base = kv.secretName;
  for (let i = 1; i <= 50; i++) {
    const name = i === 1 ? base : `${base.slice(0, 120)}-${i}`;
    const info = await secretInfo(ctx, name);
    if (info && info.contentType !== ours) continue;
    if (name !== base) {
      kv.secretName = name;
      ctx.save();
      ui.warn(`${kv.name} already has a secret called ${base} that isn't this app's, so it stays as it is. This install uses ${name}.`);
    }
    return;
  }
  throw new Error(`${kv.name} has no free secret name starting ${base}. Choose another secret name and run the installer again.`);
}

/**
 * Picks the GitHub token's secret name in a vault this install didn't make. Another install's token
 * looks just like this one's, so a secret already there is never taken over: the next free name is used.
 * @param {Ctx} ctx
 */
async function claimGithubSecretName(ctx) {
  const { ui, config } = ctx;
  const kv = config.keyVault;
  const gh = config.github;
  if (!gh || gh.secretName || !kv.existing) return;
  const base = githubSecretName(config);
  for (let i = 1; i <= 50; i++) {
    const name = i === 1 ? base : `${base.slice(0, 120)}-${i}`;
    if (await secretInfo(ctx, name)) continue;
    gh.secretName = name;
    ctx.save();
    if (name !== base) ui.warn(`${kv.name} already has a secret called ${base}, so it stays as it is. This install keeps the GitHub token as ${name}.`);
    return;
  }
  throw new Error(`${kv.name} has no free secret name starting ${base}. Delete the ones no install uses, then run the installer again.`);
}

/**
 * @param {Ctx} ctx
 * @param {string} value
 * @param {{ name?: string, expires?: Date, contentType?: string }} o  name: the client secret's, unless given.
 */
const writeSecret = (ctx, value, { name = ctx.config.keyVault.secretName, ...o }) =>
  onVault(
    ctx,
    (uri) => ctx.api.keyVault.setSecret(uri, name, value, o),
    (id) => ctx.api.arm.setSecret(id, name, value, o),
  );

/**
 * Makes sure a new secret will have somewhere to go before it is created. Waits out a
 * new role assignment; a private vault needs write access through Resource Manager.
 * @param {Ctx} ctx
 * @param {string} [name]  The secret about to be written: the client secret's, unless given.
 */
async function checkSecretAccess(ctx, name = ctx.config.keyVault.secretName) {
  const { api, config } = ctx;
  const kv = config.keyVault;
  await onVault(
    ctx,
    (uri) => api.keyVault.waitForAccess(uri, name),
    async (id) => {
      const perms = await api.arm.permissions(id).catch(() => null);
      if (perms && !allowsAction(perms, 'Microsoft.KeyVault/vaults/secrets/write')) {
        throw new Error(
          `${kv.name} blocks public network access, so the installer saves secrets through Azure Resource Manager. ` +
            'That needs Contributor or Key Vault Contributor on the vault. Ask its owner, then run the installer again.',
        );
      }
    },
  );
}

/**
 * Adds a client secret to the app and writes it straight to Key Vault. It is never printed or saved elsewhere.
 * @param {Ctx} ctx
 */
export async function newSecret(ctx) {
  const { ui, config, api } = ctx;
  const { app, keyVault: kv } = config;
  if (secretMode(config) === 'keyvault-admin') {
    await secretHandoff(ctx, { rotate: true });
    return;
  }
  if (!app.objectId) {
    const application = app.appId ? await api.graph.findApplication(app.appId) : null;
    if (!application) throw new Error('No app registration to add a secret to.');
    app.objectId = application.id;
  }
  const objectId = /** @type {string} */ (app.objectId);
  await checkSecretAccess(ctx);
  if (claimsName(ctx)) await claimSecretName(ctx);
  // Tracked from before Entra is asked, so a run that stops before the vault has it still knows
  // about it. Not removed unless the vault turned it down: it may be stored there already.
  const credential = await addTrackedSecret(ctx, kv, objectId, VAULT_SECRET_LABEL, addMonths(ctx.now(), SECRET_LIFETIME_MONTHS));
  try {
    await writeSecret(ctx, credential.secretText, {
      expires: new Date(credential.endDateTime),
      contentType: `Client secret for ${app.appId}`,
    });
  } catch (err) {
    const outcome = await settleFailedSecret(ctx, kv, objectId, credential.keyId, err);
    throw new Error(
      `The app's new client secret couldn't be saved to Key Vault (${/** @type {Error} */ (err).message}). ` +
        (outcome === 'removed'
          ? 'It has been removed from the app again, and was never shown or stored anywhere else.'
          : outcome === 'retired'
            ? `It was not shown or stored anywhere else. It stays in the install record and the next run removes it, or delete it (key ${credential.keyId}) from the app's Certificates & secrets page.`
            : 'Run the installer again: it makes a new one, and keeps track of this one.'),
    );
  }
  app.secretExpires = credential.endDateTime;
  kv.secretSetAt = ctx.now().toISOString();
  const unsure = (kv.pendingSecretKeyIds ?? []).filter((k) => k !== credential.keyId);
  // Earlier secrets stay on the app until they expire, as a run already going may still use one.
  await promoteSecret(ctx, kv, objectId, credential.keyId, { keepPrevious: true });
  ui.ok(`Created a client secret and saved it to Key Vault as ${kv.secretName} (expires ${credential.endDateTime.slice(0, 10)})`);
  if (unsure.length) {
    ui.warn(
      `An earlier run added a client secret it couldn't confirm was saved to Key Vault (key ${unsure.join(', ')}). The vault now has the new one, so once this run has finished ` +
        "and the pipeline has run, delete that key from the app's Certificates & secrets page. The install record lists it as replaced.",
    );
  }
}

/**
 * Takes back admin consent for the Graph permissions in `retired` that the app still has. Without
 * the rights to, or when Graph refuses, it says which remain and where an admin removes them.
 * @param {Ctx} ctx
 * @param {{ canConsent: boolean }} who
 * @param {string} graphSpId
 * @param {{ id: string, value: string }[]} retired
 * @param {{ id: string, appRoleId: string }[]} assigned  The app's Graph app role assignments.
 */
async function revokeRetiredRoles(ctx, who, graphSpId, retired, assigned) {
  const { ui, config, api } = ctx;
  const byId = new Map(retired.map((r) => [r.id, r]));
  const stale = assigned.filter((a) => byId.has(a.appRoleId));
  /** @type {{ id: string, value: string }[]} */
  const done = [];
  /** @type {{ id: string, value: string }[]} */
  const left = [];
  for (const a of stale) {
    const role = /** @type {{ id: string, value: string }} */ (byId.get(a.appRoleId));
    if (!who.canConsent) {
      left.push(role);
      continue;
    }
    try {
      await api.graph.revokeAppRole(graphSpId, a.id);
      done.push(role);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.status === 404) done.push(role);
      else left.push(role);
    }
  }
  if (done.length) ui.ok(`Took back admin consent for ${roleNames(done)}, as ${PRODUCT_NAME} no longer uses ${done.length > 1 ? 'them' : 'it'}`);
  if (left.length) {
    ui.warn(
      `${config.app.displayName ?? 'The app'} still has admin consent for ${roleNames(left)}, which ${PRODUCT_NAME} no longer uses. ` +
        `A Global Administrator or Privileged Role Administrator can revoke ${left.length > 1 ? 'them' : 'it'} on its API permissions page:`,
    );
    ui.info(apiPermissionsUrl(/** @type {string} */ (config.app.appId)));
  }
}

/**
 * Grants the Graph application permissions, or hands the user a link for an admin.
 * For an app the installer made, it also takes back the consent for permissions it no longer uses.
 * Returns true when every permission is consented.
 * @param {Ctx} ctx
 * @param {{ canConsent: boolean }} who
 */
export async function ensureConsent(ctx, who) {
  const { ui, config, api } = ctx;
  const app = config.app;
  const spId = /** @type {string} */ (app.servicePrincipalId);
  const appId = /** @type {string} */ (app.appId);
  const { sp: graphSp, roles } = await graphRoles(ctx);
  const retired = retiredRoles(config, graphSp);

  /** @type {{ id: string, appRoleId: string }[]} */
  let assigned = [];
  const missing = async () => {
    assigned = (await api.graph.appRoleAssignments(spId)).filter((a) => a.resourceId === graphSp.id);
    const have = new Set(assigned.map((a) => a.appRoleId));
    return roles.filter((r) => !have.has(r.id));
  };

  let todo = await missing();
  await revokeRetiredRoles(ctx, who, graphSp.id, retired, assigned);
  if (!todo.length) {
    ui.ok(`Admin consent is in place (${roles.map((r) => r.value).join(', ')})`);
    return true;
  }

  if (who.canConsent) {
    for (const role of todo) await api.graph.grantAppRole(graphSp.id, spId, role.id);
    ui.ok(`Granted admin consent: ${todo.map((r) => r.value).join(', ')}`);
    return true;
  }

  ui.warn(`A Global Administrator or Privileged Role Administrator needs to approve: ${todo.map((r) => r.value).join(', ')}`);
  ui.info(`Send them this page and ask them to select "Grant admin consent":`);
  ui.info(apiPermissionsUrl(appId));
  ui.note(`Or the direct consent link: ${adminConsentUrl(ctx.user.tenantId, appId)}`);
  if (ui.yes) {
    ui.warn('Carrying on without consent. Data loads will fail until it is granted.');
    return false;
  }
  for (;;) {
    const next = await ui.select(
      'Once they have approved it:',
      [
        { name: 'Check again', value: 'check' },
        { name: 'Carry on without it (skip the first load for now)', value: 'skip' },
      ],
      'check',
    );
    if (next === 'skip') return false;
    todo = await missing();
    if (!todo.length) {
      ui.ok('Admin consent is in place');
      return true;
    }
    ui.warn(`Still waiting for: ${todo.map((r) => r.value).join(', ')}`);
  }
}

/**
 * What an app registration the user brought still needs before the install can use it.
 * @typedef {object} AppCheck
 * @property {boolean} found  The app registration exists in this tenant.
 * @property {string} [displayName]
 * @property {boolean} servicePrincipal  It has a service principal (enterprise application).
 * @property {string[]} undeclared  Graph application permissions missing from its API permissions.
 * @property {string[]} unconsented  Graph application permissions without admin consent.
 */

/**
 * Puts the GitHub token where Ingest_GitHub_API reads it, when GitHub is read from the API and the
 * install keeps its secrets in Key Vault. With no Key Vault, ensureNotebooks writes it into the
 * notebook instead. Returns false while it isn't in place.
 * @param {Ctx} ctx
 * @param {{ replace?: boolean }} [o]  replace: put a new token in place ("github-token").
 */
export async function ensureGithubToken(ctx, o = {}) {
  const { ui, config } = ctx;
  const gh = config.github;
  if (config.dataSources.github !== 'api' || !gh?.enterprise) return true;
  const mode = secretMode(config);
  if (mode === 'notebook') return true;
  const kv = config.keyVault;

  if (mode === 'keyvault-admin') {
    delete ctx.pendingGithubToken;
    // ensureSecret's handoff may have covered it already this run.
    const shown = !!ctx.handoffShown?.has('githubToken');
    if (gh.tokenSetAt && !o.replace) {
      if (!shown) {
        ui.ok(`The vault admin added the GitHub token to ${kv.name} as ${githubSecretName(config)}`);
        if (kv.handoff?.grantRead && !appWanted(config.dataSources)) {
          ui.warn(`You still need read access to ${kv.name} so scheduled runs can read it. Ask the vault admin to run:`);
          ui.info(`  ${handoffCommands(config, { userId: ctx.user.id, secret: false })[0]}`);
        }
      }
      return true;
    }
    if (shown) return false;
    return secretHandoff(ctx, { secret: false, githubToken: true, rotate: !!o.replace && !!gh.tokenSetAt });
  }

  if (!o.replace && !ctx.pendingGithubToken && gh.tokenSetAt) {
    const name = githubSecretName(config);
    if (await secretExists(ctx, name)) {
      ui.ok(`The GitHub token is in Key Vault as ${name}${gh.tokenExpires ? ` (expires ${gh.tokenExpires.slice(0, 10)})` : ''}`);
      return true;
    }
    ui.warn(`Key Vault has no secret called ${name} any more.`);
    delete gh.tokenSetAt;
    delete gh.tokenExpires;
    ctx.save();
  }

  /** @type {import('./github.js').PendingToken | undefined} */
  let token;
  try {
    token = await askGithubToken(ctx);
  } catch (err) {
    ui.fail(/** @type {Error} */ (err).message);
  }
  if (!token) {
    ui.warn(`No GitHub token yet, so GitHub data won't load. Run "${commandLine('github-token')}" to add one${ui.yes ? `, or set ${ENV.GITHUB_TOKEN} and run the installer again` : ''}.`);
    return false;
  }
  await checkSecretAccess(ctx, githubSecretName(config));
  await claimGithubSecretName(ctx);
  const name = githubSecretName(config);
  gh.secretName ??= name;
  ctx.save();
  // No expiry on the secret: GitHub ends the token itself, and the Done page warns before it does.
  await writeSecret(ctx, token.value, { name, contentType: githubContentType(config) });
  delete ctx.pendingGithubToken;
  gh.tokenSetAt = ctx.now().toISOString();
  if (token.expires) gh.tokenExpires = token.expires;
  else delete gh.tokenExpires;
  ctx.save();
  ui.ok(`Saved the GitHub token to Key Vault as ${name}${token.expires ? ` (expires ${token.expires.slice(0, 10)})` : ''}`);
  return true;
}

/**
 * Checks an app registration the user brought, before anything is created: that it and its
 * service principal exist, and that every Graph application permission the chosen modules
 * need is on it with admin consent.
 * @param {Ctx} ctx
 * @param {import('../install.js').Apis} [api]  Uncached clients, so "Check again" sees changes.
 * @returns {Promise<AppCheck>}
 */
export async function checkExistingApp(ctx, api = ctx.api) {
  const appId = /** @type {string} */ (ctx.config.app.appId);
  const { sp: graphSp, roles } = await graphRoles(ctx);
  const application = await api.graph.findApplication(appId);
  const sp = await api.graph.findServicePrincipal(appId);
  if (!application && !sp) return { found: false, servicePrincipal: false, undeclared: [], unconsented: roles.map((r) => r.value) };
  const declared = new Set(
    /** @type {any[]} */ (application?.requiredResourceAccess ?? [])
      .filter((r) => r.resourceAppId === GRAPH_APP_ID)
      .flatMap((r) => r.resourceAccess ?? [])
      .filter((a) => a.type === 'Role')
      .map((a) => a.id),
  );
  const assigned = sp ? await api.graph.appRoleAssignments(sp.id) : [];
  const have = new Set(assigned.filter((a) => a.resourceId === graphSp.id).map((a) => a.appRoleId));
  return {
    found: true,
    displayName: application?.displayName ?? sp?.displayName,
    servicePrincipal: !!sp,
    // Only the app's owners can read its registration; without it, skip that check.
    undeclared: application ? roles.filter((r) => !declared.has(r.id)).map((r) => r.value) : [],
    unconsented: roles.filter((r) => !have.has(r.id)).map((r) => r.value),
  };
}

/**
 * Prints what an app check found. Returns true when nothing is missing.
 * @param {Ctx} ctx
 * @param {AppCheck} check
 * @param {{ canConsent?: boolean }} [who]
 */
export function reportAppCheck(ctx, check, who = {}) {
  const { ui, config, user } = ctx;
  const appId = /** @type {string} */ (config.app.appId);
  if (!check.found) {
    ui.fail(`No app registration or enterprise application with ID ${appId} in this tenant.`);
    return false;
  }
  const missing = [];
  if (!check.servicePrincipal) missing.push('Its service principal (enterprise application). If you own the app, choose "Carry on anyway" and the installer creates it.');
  if (check.undeclared.length) missing.push(`These Graph application permissions on its API permissions page: ${check.undeclared.join(', ')}`);
  // Someone who can grant consent gets it granted during the install.
  const unconsented = check.unconsented.length && !who.canConsent;
  if (unconsented) missing.push(`Admin consent for: ${check.unconsented.join(', ')}`);
  if (!missing.length) {
    ui.ok(`${check.displayName ?? appId} has everything ${PRODUCT_NAME} needs`);
    return true;
  }
  ui.warn(`${check.displayName ?? appId} isn't ready yet. It still needs:`);
  for (const m of missing) ui.info(`  - ${m}`);
  if (check.undeclared.length || unconsented) {
    ui.info('An admin can add the permissions and grant consent on its API permissions page:');
    ui.info(apiPermissionsUrl(appId));
    if (!check.undeclared.length) ui.note(`Or the direct consent link: ${adminConsentUrl(user.tenantId, appId)}`);
  }
  return false;
}

/**
 * The steps an admin runs to register the app for someone who can't: an Azure Cloud Shell
 * script and the same steps in the portal. The client secret goes where the install keeps it,
 * so in the vault admin mode it never leaves Azure. The GitHub token isn't in it: its secret
 * name is settled at install time, when the installer hands it over (secretHandoff). On the PAX
 * route, `site` is the PowerShell that gives the app the SharePoint folder's site, which needs a
 * SharePoint or Global Administrator.
 * @param {Ctx} ctx
 * @returns {{ script: string[], checklist: string[], site?: string[] }}
 */
export function adminPack(ctx) {
  const { config } = ctx;
  const kv = config.keyVault;
  const perms = requiredPermissions(config);
  const name = appName(config);
  const mode = secretMode(config);
  const script = perms.length
    ? [
        '# Run in Azure Cloud Shell (Bash) as someone who can register apps and grant admin consent,',
        '# such as a Privileged Role Administrator or Global Administrator.',
      ]
    : [
        '# Run in Azure Cloud Shell (Bash) as someone who can register apps, such as an',
        '# Application Administrator or Cloud Application Administrator.',
      ];
  script.push(
    `APP_ID=$(az ad app create --display-name "${name}" --sign-in-audience AzureADMyOrg --query appId -o tsv)`,
    'az ad sp create --id "$APP_ID" -o none',
  );
  if (perms.length) {
    script.push(
      `GRAPH=${GRAPH_APP_ID}`,
      `for P in ${perms.join(' ')}; do`,
      '  ROLE=$(az ad sp show --id $GRAPH --query "appRoles[?value==\'$P\'].id | [0]" -o tsv)',
      '  if [ -n "$ROLE" ]; then az ad app permission add --id "$APP_ID" --api $GRAPH --api-permissions "$ROLE=Role" -o none; else echo "Skipped $P: not in this tenant yet"; fi',
      'done',
      'sleep 30  # let Entra catch up before granting consent',
      'az ad app permission admin-consent --id "$APP_ID"',
    );
  }
  script.push('echo "Client ID: $APP_ID"');
  if (mode === 'keyvault-admin' && kv.name) {
    const ours = 'Client secret for $APP_ID';
    script.push(
      '# The client secret goes straight into the vault, so nobody sees it. A secret with this name',
      '# that belongs to another app is left alone.',
      `CT=$(az keyvault secret show --vault-name ${kv.name} --name ${kv.secretName} --query contentType -o tsv 2>/dev/null)`,
      `if [ -n "$CT" ] && [ "$CT" != "${ours}" ]; then`,
      `  echo "${kv.name} already has a secret called ${kv.secretName} for another app. Ask the installer user to choose another secret name."`,
      'else',
      `  az keyvault secret set --vault-name ${kv.name} --name ${kv.secretName} --content-type "${ours}" ` +
        `--value "$(az ad app credential reset --id "$APP_ID" --append --display-name "${PRODUCT_NAME}" --years 1 --query password -o tsv)" --query id -o tsv`,
      'fi',
    );
  } else {
    script.push(
      '# The client secret. Send it with the client ID through a secure channel, never by plain email or chat:',
      `az ad app credential reset --id "$APP_ID" --append --display-name "${PRODUCT_NAME}" --years 1 --query password -o tsv`,
    );
  }
  const checklist = [
    `Entra admin center > App registrations > New registration. Name it "${name}", single tenant, no redirect URI.`,
    'Copy the Application (client) ID from its Overview page.',
    ...(perms.length
      ? [
          `API permissions > Add a permission > Microsoft Graph > Application permissions. Add: ${perms.join(', ')}.`,
          'Select "Grant admin consent" and confirm every permission shows "Granted".',
        ]
      : []),
    mode === 'keyvault-admin' && kv.name
      ? `Certificates & secrets > New client secret (12 months). Copy its Value into Key Vault ${kv.name} > Secrets > Generate/Import, named ${kv.secretName}.`
      : 'Certificates & secrets > New client secret (12 months). Copy its Value.',
    mode === 'keyvault-admin' && kv.name
      ? 'Send the installer user the client ID. They don\'t need the secret.'
      : 'Send the installer user the client ID and the secret value through a secure channel.',
  ];
  if (!isPax(config) || !config.sharePoint) return { script, checklist };
  const site = [
    `# Run in PowerShell 7 as ${SITE_ADMIN.replace(/^A /, 'a ')}. It gives the app write access to`,
    `# ${config.sharePoint.siteUrl} and to no other site (Sites.Selected).`,
    "$appId = '<the client ID from above>'",
    ...siteGrantCommands(config, '$appId'),
  ];
  checklist.splice(
    checklist.length - 1,
    0,
    `Give the app write access to ${config.sharePoint.siteUrl}: run the PowerShell below as ${SITE_ADMIN.replace(/^A /, 'a ')}, or with PnP PowerShell: ${pnpGrantCommand(config, '$appId')}`,
  );
  return { script, checklist, site };
}

/**
 * Writes the admin pack next to the install record and returns its path.
 * @param {Ctx} ctx
 */
export function writeAdminPack(ctx) {
  const { script, checklist, site } = adminPack(ctx);
  const file = join(ctx.configFile ? dirname(ctx.configFile) : process.cwd(), ADMIN_PACK_FILE);
  const consent = requiredPermissions(ctx.config).length > 0;
  const body = [
    `# ${PRODUCT_NAME}: register the app`,
    '',
    `The person setting up ${PRODUCT_NAME} can't register apps${consent ? ' or grant admin consent' : ''} in this tenant.`,
    'Run the script, or follow the portal steps, then send them the client ID.',
    '',
    '## Azure Cloud Shell (Bash)',
    '',
    '```bash',
    ...script,
    '```',
    '',
    ...(site ? ['## Then the SharePoint site (PowerShell 7)', '', '```powershell', ...site, '```', ''] : []),
    '## Or in the portal',
    '',
    ...checklist.map((s, i) => `${i + 1}. ${s}`),
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Everything secret the install needs: Key Vault, the app registration with its secret and admin
 * consent, and the GitHub token. With the defaults (CSV exports) that is only the app registration,
 * for the semantic model's connection: no Key Vault, no Graph permissions and no admin consent.
 * Returns what the first load has to wait for, or undefined when nothing is missing.
 * @param {Ctx} ctx
 * @param {{ canConsent: boolean }} who
 * @returns {Promise<string | undefined>}
 */
export async function ensureIdentity(ctx, who) {
  const { ui, config } = ctx;
  const ds = config.dataSources;
  if (!secretWanted(ds) && !appNeeded(config)) {
    ui.ok('These choices need no app registration or secret');
    return undefined;
  }
  if (secretWanted(ds)) await ensureKeyVault(ctx);
  const byAdmin = secretMode(config) === 'keyvault-admin';
  /** @type {string[]} */
  const adminAdds = [];
  /** @type {string[]} */
  const waits = [];
  if (appNeeded(config)) {
    await ensureApp(ctx, { secret: appWanted(ds) });
    if (appWanted(ds) && byAdmin && !config.keyVault.secretSetAt) adminAdds.push('the client secret');
    if (requiredPermissions(config).length && !(await ensureConsent(ctx, who))) waits.push('admin consent is granted');
  }
  if (!(await ensureGithubToken(ctx))) {
    if (byAdmin) adminAdds.push('the GitHub token');
    else waits.push('the GitHub token is in place');
  }
  if (adminAdds.length) waits.unshift(`the vault admin has added ${listJoin(adminAdds)}`);
  // At most two, and the first may have its own "and".
  return waits.length ? waits.join(', and ') : undefined;
}
