// @ts-check
/**
 * Who can view Consumption Central: one Entra security group. Its members get Build on the semantic
 * model, and the report is shared with the group once, by hand. Sharing is then adding people to
 * the group, from the installer or My Groups.
 *
 * The group gets no workspace role: on the Fabric route, workspace viewers can read notebook code,
 * and the notebooks can hold a client secret or a GitHub token. On the PAX route it needs none.
 */
import { HttpError } from '../http.js';
import { VIEWER_GROUP } from '../product.js';
import { isPax } from '../target.js';
import { asksAdvanced } from './advanced.js';
import { reportsOn, reportUrl } from './report.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ workspaceId: string, datasetId: string, name: string }} ModelRef */

export const VIEWER_GROUP_NAME = VIEWER_GROUP;
/** On the PAX route the report is in a workspace with no capacity, where Power BI asks each viewer for a licence. */
export const PRO_VIEWERS = 'Unless the workspace is on a paid F64 or larger Fabric capacity, or a Power BI Premium capacity, each of them needs Power BI Pro or Premium Per User.';
const GROUP_DESCRIPTION = 'People who can view Consumption Central. Add members to share it.';

/** Where a group's owners add and remove members themselves. @param {string} groupId */
export const myGroupsUrl = (groupId) => `https://myaccount.microsoft.com/groups/${groupId}`;

const isEmail = (/** @type {string} */ v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? true : 'Enter an email address');
const isLinkOrEmpty = (/** @type {string} */ v) => (!v.trim() || /^https:\/\/\S+$/i.test(v.trim()) ? true : 'Enter an https:// link, or leave it empty');
const lower = (/** @type {unknown} */ s) => String(s ?? '').toLowerCase();

/**
 * When the viewer group changes, the old group keeps the Build the installer gave it until the
 * next grant takes it away. Its ID moves to retiredGroups, with the models it has Build on.
 * @param {import('../config.js').AccessConfig} access  planAccess's copy of the record's access.
 */
function retireGroup(access) {
  const id = access.groupId;
  if (!id) return;
  const prior = access.retiredGroups?.find((g) => lower(g.groupId) === lower(id));
  const datasets = [...new Set([...(prior?.datasets ?? []), ...(access.grantedModels ?? [])])];
  const others = (access.retiredGroups ?? []).filter((g) => g !== prior);
  const retired = datasets.length ? [...others, { groupId: id, ...(access.groupName ? { groupName: access.groupName } : {}), datasets }] : others;
  if (retired.length) access.retiredGroups = retired;
  else delete access.retiredGroups;
  access.grantedModels = [];
}

/**
 * A group chosen as the viewer group again keeps its Build.
 * @param {import('../config.js').AccessConfig} access
 * @param {string} id
 */
function unretireGroup(access, id) {
  if (!access.retiredGroups) return;
  access.retiredGroups = access.retiredGroups.filter((g) => lower(g.groupId) !== lower(id));
  if (!access.retiredGroups.length) delete access.retiredGroups;
}

/**
 * The saved access contact, or undefined when its domain isn't one of the tenant's verified domains,
 * e.g. a record carried over from another tenant. Kept when the domains can't be read.
 * @param {Ctx} ctx
 * @param {string | undefined} contact
 */
export async function contactInTenant(ctx, contact) {
  if (!contact || contact.toLowerCase() === ctx.user.upn.toLowerCase()) return contact;
  const domain = contact.split('@').pop()?.trim().toLowerCase() ?? '';
  const domains = await Promise.resolve()
    .then(() => ctx.api.graph.verifiedDomains())
    .catch(() => /** @type {string[]} */ ([]));
  if (!domains.length || domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return contact;
  ctx.ui.note(`The saved access contact, ${contact}, isn't on one of this tenant's domains, so it's now ${ctx.user.upn}.`);
  return undefined;
}

/**
 * The plan's questions: which group, who to ask for access, and an optional request link.
 * @param {Ctx} ctx
 */
export async function planAccess(ctx) {
  const { ui, config, user, api } = ctx;
  const access = { ...(config.access ?? {}) };
  access.contact = await contactInTenant(ctx, access.contact);
  if (!asksAdvanced(ctx)) {
    // The saved group, or a new "Consumption Central Viewers"; Manage access changes it later.
    if (!access.groupId) access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
    access.contact ??= user.upn;
    config.access = access;
    return;
  }
  ui.heading('Who can view');
  const mode = await ui.select(
    'Who can view Consumption Central?',
    [
      { name: `A new group, "${VIEWER_GROUP_NAME}" (recommended)`, value: 'new', description: 'Created with you as owner. Share by adding people to it.' },
      { name: 'A group I already have', value: 'existing', description: 'A security group, by name or object ID. Its members can view.' },
    ],
    access.groupId && !access.createdGroup ? 'existing' : 'new',
  );
  if (mode === 'new') {
    if (!access.createdGroup) {
      // A group already called that is the one the next step finds, so it stays the viewer group.
      if (lower(access.groupName) !== lower(VIEWER_GROUP_NAME)) retireGroup(access);
      delete access.groupId;
      delete access.reportShared;
    }
    access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
  } else {
    for (;;) {
      const name = (await ui.input('Group name or object ID', { default: access.createdGroup ? undefined : access.groupName ?? access.groupId })).trim();
      const found = await api.graph.resolvePrincipal(name).catch(() => null);
      if (found?.kind === 'group') {
        if (found.id !== access.groupId) {
          delete access.reportShared;
          retireGroup(access);
          unretireGroup(access, found.id);
        }
        Object.assign(access, { groupId: found.id, groupName: found.displayName, createdGroup: false });
        ui.ok(`Viewers: ${found.displayName}`);
        break;
      }
      ui.warn(`No group called "${name}". Check the name, or paste its object ID from Entra.`);
    }
  }
  access.contact = (await ui.input('Who should people ask for access? (email)', { default: access.contact ?? user.upn, validate: isEmail })).trim();
  ui.note(`People without access are asked to email ${access.contact}. Add a link, e.g. a request form, to offer that too.`);
  access.requestUrl = (await ui.input('Link where people can request access (optional)', { default: access.requestUrl ?? '', validate: isLinkOrEmpty })).trim() || undefined;
  config.access = access;
}

/**
 * Plan review rows: the group the access step creates and the Build grant it gives, and the Build
 * it takes away from a group that was the viewer group.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} where  The models, e.g. "Semantic models in workspace X".
 */
export function accessReview(config, where) {
  const a = config.access;
  if (!a) return { creates: [], grants: [] };
  const name = a.groupName ?? VIEWER_GROUP_NAME;
  // You may not own a group you picked. You own one the installer creates.
  const owners = a.groupId && !a.createdGroup ? 'Its owners share it by adding people to it.' : 'You are its owner; share by adding people to it.';
  const retired = (a.retiredGroups ?? []).filter((g) => g.datasets.length && lower(g.groupId) !== lower(a.groupId));
  return {
    creates: [{ kind: 'Entra group', name, isNew: !a.groupId, detail: `Who can view Consumption Central. ${owners}` }],
    grants: [
      { who: `${name} (group)`, what: 'Build (ReadExplore)', where, detail: 'So its members can view the report, once you share it with the group. Power BI has no API for that, so the installer shows you the clicks.' },
      ...retired.map((g) => ({
        who: `${g.groupName ?? g.groupId} (group)`,
        what: 'Build removed',
        where,
        detail: "It isn't the viewer group any more, so the installer takes away the Build it gave it.",
      })),
    ],
  };
}

/**
 * Finds the viewer group, or creates it with the installer as owner. Null when it can't be created.
 * @param {Ctx} ctx
 * @returns {Promise<{ id: string, displayName: string } | null>}
 */
export async function ensureViewerGroup(ctx) {
  const { ui, config, api, user } = ctx;
  const a = config.access;
  if (!a) return null;
  if (a.groupId) {
    const group = await api.graph.getGroup(a.groupId);
    if (group) {
      a.groupName = group.displayName;
      ui.ok(`Viewer group: ${group.displayName}`);
      return group;
    }
    ui.warn(`The viewer group ${a.groupName ?? a.groupId} is gone.${a.createdGroup ? ' Creating it again.' : ''}`);
    delete a.groupId;
    delete a.reportShared;
    a.grantedModels = [];
    if (!a.createdGroup) {
      ctx.save();
      ui.info(`Run "access" to choose another group.`);
      return null;
    }
  }
  const name = a.groupName ?? VIEWER_GROUP_NAME;
  const found = await api.graph.findGroupByName(name);
  if (found) {
    Object.assign(a, { groupId: found.id, groupName: found.displayName });
    ctx.save();
    ui.ok(`Viewer group: ${found.displayName}`);
    return found;
  }
  try {
    const group = await api.graph.createSecurityGroup({ displayName: name, description: GROUP_DESCRIPTION, ownerId: user.id });
    Object.assign(a, { groupId: group.id, groupName: group.displayName, createdGroup: true });
    ctx.save();
    ui.ok(`Created the group "${group.displayName}", with you as owner`);
    return group;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 403 || err.status === 401) {
      ui.warn(`You can't create groups in this tenant, so there's no viewer group yet.`);
      ui.info('Ask an Entra admin for a security group, then run "access" to use it.');
    } else {
      ui.warn(`Couldn't create the group "${name}", so there's no viewer group yet: ${err.message}`);
      ui.info('Run "access" and choose "A group I already have" to use a security group you own, or ask an Entra admin for one.');
    }
    return null;
  }
}

/** A new group takes a minute or two to reach Power BI, which until then rejects it as an invalid identifier. */
export const NEW_GROUP_ATTEMPTS = 8;
export const NEW_GROUP_RETRY_MS = 15_000;

/**
 * Adds the group to a model, waiting while Power BI doesn't know the group yet.
 * @param {Ctx} ctx
 * @param {ModelRef} m
 * @param {string} groupId
 */
async function addGroupToModel(ctx, m, groupId) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.api.powerBi.addDatasetUser(m.workspaceId, m.datasetId, { identifier: groupId, principalType: 'Group', datasetUserAccessRight: 'ReadExplore' });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400 || attempt === NEW_GROUP_ATTEMPTS) throw err;
      if (attempt === 1) ctx.ui.info('Waiting for Power BI to see the group. A new group takes a minute or two.');
      await ctx.sleep(NEW_GROUP_RETRY_MS);
    }
  }
}

/**
 * Gives the viewer group Build (ReadExplore) on each model, so its members can query them, then
 * takes away the Build the installer gave a group that was the viewer group before. A grant or a
 * removal that fails is reported and doesn't stop the install.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models  All of the install's models.
 */
export async function grantModelAccess(ctx, models) {
  const { ui, config, api } = ctx;
  const a = config.access;
  if (!a?.groupId) return;
  const granted = new Set(a.grantedModels ?? []);
  for (const m of models) {
    try {
      const users = await api.powerBi.datasetUsers(m.workspaceId, m.datasetId).catch(() => []);
      const has = users.some((u) => String(u.identifier).toLowerCase() === a.groupId?.toLowerCase() && /Explore/i.test(u.datasetUserAccessRight ?? ''));
      if (!has) await addGroupToModel(ctx, m, a.groupId);
      granted.add(m.datasetId);
      ui.ok(`${a.groupName} can build on ${m.name}`);
    } catch (err) {
      ui.warn(`Couldn't give ${a.groupName} Build on ${m.name}: ${/** @type {Error} */ (err).message}`);
      ui.info('Share the model with the group from its Manage permissions page, with "Allow recipients to build content" ticked.');
    }
  }
  a.grantedModels = [...granted];
  ctx.save();
  await removeRetiredAccess(ctx, models);
}

/**
 * Takes away the Build the installer gave groups that were the viewer group. It takes away all of
 * the group's direct access to the model, but not what a workspace role gives. A model that isn't
 * the install's any more was deleted, and its access with it.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models  All of the install's models.
 */
async function removeRetiredAccess(ctx, models) {
  const { ui, config, api } = ctx;
  const a = /** @type {import('../config.js').AccessConfig} */ (config.access);
  if (!a.retiredGroups?.length) return;
  /** @type {import('../config.js').RetiredGroup[]} */
  const left = [];
  for (const g of a.retiredGroups) {
    // The viewer group again, such as the one the new group step found by name.
    if (lower(g.groupId) === lower(a.groupId)) continue;
    const name = g.groupName ?? g.groupId;
    /** @type {string[]} */
    const keep = [];
    for (const id of g.datasets) {
      const m = models.find((x) => x.datasetId === id);
      if (!m) {
        if (!models.length) keep.push(id);
        continue;
      }
      const users = await api.powerBi.datasetUsers(m.workspaceId, m.datasetId).catch(() => undefined);
      if (users && !users.some((u) => lower(u.identifier) === lower(g.groupId))) continue;
      try {
        await api.powerBi.updateDatasetUser(m.workspaceId, m.datasetId, { identifier: g.groupId, principalType: 'Group', datasetUserAccessRight: 'None' });
        ui.ok(`${name} no longer has Build on ${m.name}`);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) continue;
        // A deleted group has no members left to use it.
        if ((await api.graph.getGroup(g.groupId).catch(() => undefined)) === null) continue;
        ui.warn(`Couldn't take away ${name}'s Build on ${m.name}: ${/** @type {Error} */ (err).message}`);
        ui.info(`Remove ${name} from the model's Manage permissions page, or the installer tries again next time.`);
        keep.push(id);
      }
    }
    if (keep.length) left.push({ ...g, datasets: keep });
  }
  if (left.length) a.retiredGroups = left;
  else delete a.retiredGroups;
  ctx.save();
}

/**
 * The workspace in the Fabric portal, where the report's … (More options) menu is.
 * @param {string} workspaceId
 * @param {string} [tenantId]
 */
export const workspaceUrl = (workspaceId, tenantId) => `https://app.fabric.microsoft.com/groups/${workspaceId}${tenantId ? `?ctid=${tenantId}` : ''}`;

/**
 * The clicks that share the report with the viewer group, one whole step each.
 * @param {import('../config.js').InstallConfig} config
 */
export function shareReportSteps(config) {
  const group = config.access?.groupName ?? VIEWER_GROUP_NAME;
  const ws = config.fabric.workspaceId;
  const r = config.semanticModel.report;
  const url = ws && r?.id ? reportUrl(ws, r.id, config.tenantId) : undefined;
  return [
    `Open the ${r?.name ?? 'Consumption Central'} report${url ? ` (${url})` : ''}, or in ${config.fabric.workspaceName ?? 'the workspace'} choose … (More options) next to it.`,
    'Choose Manage permissions, then Add user.',
    `Enter "${group}" and choose Grant.`,
  ];
}

/**
 * What the record keeps once the user says they shared the report. On the Fabric route it's the
 * report's ID, so a report published again is asked about again. On the PAX route it's true, and
 * publishing a different report clears it.
 * @param {import('../config.js').InstallConfig} config
 * @returns {string | true | undefined}
 */
const sharedMark = (config) => (isPax(config) ? true : config.semanticModel.report?.id);

/**
 * The report still needs sharing with the viewer group: there is a group and a report, and nobody
 * has said this report was shared.
 * @param {import('../config.js').InstallConfig} config
 */
export const shareReportPending = (config) => {
  const id = config.semanticModel.report?.id;
  return reportsOn(config) && !!config.access?.groupId && !!id && config.access.reportShared !== sharedMark(config);
};

/**
 * Asks the user to share the report with the viewer group, once. Build on the model lets members
 * query it, but opening the report takes a share, and Power BI has no API for sharing a report
 * with a group. Asked straight after the report is published and before the first load, which can
 * take hours, so viewers can open it while the data loads. Not asked again once done.
 * @param {Ctx} ctx
 */
export async function shareReport(ctx) {
  const { ui, config } = ctx;
  const a = config.access;
  if (!shareReportPending(config)) {
    if (!a?.groupId) ui.warn("There's no viewer group yet, so there's nothing to share. The summary at the end says what to do.");
    else if (!config.semanticModel.report?.id) ui.warn("There's no report yet, so there's nothing to share. The summary at the end says how to publish it.");
    return;
  }
  const group = a?.groupName ?? VIEWER_GROUP_NAME;
  ui.info(`Members of "${group}" can open the report once it's shared with the group. Power BI has no API for that, so it takes a few clicks:`);
  shareReportSteps(config).forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
  ui.note(
    isPax(config)
      ? `After that, give people access by adding them to the group. They need no workspace role. ${PRO_VIEWERS}`
      : 'After that, give people access by adding them to the group.',
  );
  const done = await ui.select(
    'Have you shared the report?',
    [
      { name: "I've shared it", value: true, description: `Members of "${group}" can open the report.` },
      { name: 'Later', value: false, description: 'The summary at the end reminds you, and Repair asks again.' },
    ],
    false,
  );
  if (!done) {
    ui.note('Until it\'s shared, people in the group get "no access" when they open the report.');
    return;
  }
  /** @type {import('../config.js').AccessConfig} */ (a).reportShared = sharedMark(config);
  ctx.save();
  ui.ok(`The report is shared with "${group}"`);
}

/**
 * The `access` command: shows the viewer group and adds viewers or owners to it.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models  The models the group should have Build on.
 */
export async function accessCommand(ctx, models) {
  const { ui, config, api } = ctx;
  if (!config.access?.groupId) await planAccess(ctx);
  ctx.save();
  ui.heading('Viewer access');
  const group = await ensureViewerGroup(ctx);
  if (!group) return;
  for (;;) {
    const [members, owners] = await Promise.all([api.graph.groupMembers(group.id).catch(() => []), api.graph.groupOwners(group.id).catch(() => [])]);
    ui.info(`${members.length} ${members.length === 1 ? 'member' : 'members'}; owners: ${owners.map((o) => o.userPrincipalName ?? o.displayName).join(', ') || 'none'}`);
    ui.note(`Owners can also manage it at ${myGroupsUrl(group.id)}`);
    const action = await ui.select(
      'What next?',
      [
        { name: 'Add viewers', value: 'members', description: 'People or groups, by email or group name.' },
        { name: 'Add an owner', value: 'owner', description: 'Owners can add and remove viewers themselves.' },
        { name: 'Give the group Build on the model again', value: 'grants', description: 'Repairs access to the model.' },
        ...(shareReportPending(config) ? [{ name: 'Share the report with the group', value: 'share', description: 'Once only. Members get "no access" on the report until it\'s shared.' }] : []),
        { name: 'Done', value: 'done' },
      ],
      'done',
    );
    if (action === 'done') return;
    if (action === 'grants') {
      await grantModelAccess(ctx, models);
      continue;
    }
    if (action === 'share') {
      await shareReport(ctx);
      continue;
    }
    const names = (await ui.input(action === 'owner' ? 'Owner email' : 'Emails or group names, separated by commas')).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      const p = await api.graph.resolvePrincipal(name).catch(() => null);
      if (!p || (action === 'owner' && p.kind !== 'user')) {
        ui.warn(`No ${action === 'owner' ? 'user' : 'user or group'} called "${name}"`);
        continue;
      }
      const added = action === 'owner' ? await api.graph.addGroupOwner(group.id, p.id) : await api.graph.addGroupMember(group.id, p.id);
      ui.ok(`${p.displayName} ${added ? 'added' : 'was already there'}`);
    }
  }
}
