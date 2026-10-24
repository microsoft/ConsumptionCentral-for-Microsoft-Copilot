// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDataFlags, help, parseCli } from '../src/cli.js';
import { emptyConfig } from '../src/config.js';

const SUB = '00000000-0000-0000-0000-00000000000c';
const ACCOUNT = '/providers/Microsoft.Billing/billingAccounts/12345678';
const SOURCES = 'coworkCredits, coworkTasks, studioCredits, github, azureAi, orgData, commercialTerms';

/** Parses as if outside Azure Cloud Shell, whatever this machine's environment. @param {string[]} argv */
const cli = (...argv) => parseCli(argv, {});

test('cli: --github-enterprise and --billing-scope go with install or preview, trimmed', () => {
  const args = cli('--github-enterprise', '  contoso  ', '--billing-scope', ` /subscriptions/${SUB}// `);
  assert.equal(args.command, 'install');
  assert.equal(args.githubEnterprise, 'contoso');
  assert.equal(args.billingScope, `/subscriptions/${SUB}`);
  assert.deepEqual(args.dataSources, {});

  assert.equal(cli('preview', '--github-enterprise', 'Contoso-Labs').githubEnterprise, 'Contoso-Labs');
  assert.equal(cli('--dry-run', '--billing-scope', `${ACCOUNT}/billingProfiles/AB12-CD34`).billingScope, `${ACCOUNT}/billingProfiles/AB12-CD34`);
  const none = cli('install');
  assert.equal(none.githubEnterprise, undefined);
  assert.equal(none.billingScope, undefined);
  const text = help().replace(/\s+/g, ' ');
  assert.match(text, / --github-enterprise <slug> With install: the enterprise, as in github\.com\/enterprises\/<slug>, whose Copilot billing Ingest_GitHub_API reads \(needs github=api\) /);
  assert.match(text, / --billing-scope <id> With install: the subscription \(\/subscriptions\/<id>\), billing account or billing profile Ingest_CommercialTerms reads the credit rate from \(needs commercialTerms=api\) /);
});

test('cli: the GitHub enterprise and billing scope are refused with any other command', () => {
  assert.throws(() => cli('run', '--github-enterprise', 'contoso'), {
    message: '--data, --csv and --github-enterprise go with install. To add exports later, use upload.',
  });
  assert.throws(() => cli('update', '--billing-scope', ACCOUNT), {
    message: '--data, --csv and --billing-scope go with install. To add exports later, use upload.',
  });
  assert.throws(() => cli('upload', 'usage.csv', '--github-enterprise', 'contoso', '--billing-scope', ACCOUNT), {
    message: '--data, --csv and --github-enterprise and --billing-scope go with install. To add exports later, use upload.',
  });
  assert.throws(() => cli('github-token', '--github-enterprise', 'contoso labs'), /go with install/, 'the command is checked before the value');
  for (const flag of ['--github-enterprise', '--billing-scope']) {
    assert.throws(() => cli('--ui', flag, flag === '--billing-scope' ? ACCOUNT : 'contoso'), {
      message: 'With --ui, choose data sources and exports on the Data sources page.',
    });
  }
});

test('cli: a bad enterprise slug or billing scope says what it should be', () => {
  const slug = '--github-enterprise should be the slug from github.com/enterprises/<slug>: letters, digits and hyphens.';
  assert.throws(() => cli('--github-enterprise', 'github.com/enterprises/contoso'), { message: slug });
  assert.throws(() => cli('--github-enterprise', 'contoso labs'), { message: slug });
  assert.throws(() => cli('--github-enterprise', '   '), { message: slug });
  const scope =
    '--billing-scope should be a subscription (/subscriptions/<id>), a billing account (/providers/Microsoft.Billing/billingAccounts/<id>) or a billing profile (…/billingAccounts/<id>/billingProfiles/<id>).';
  assert.throws(() => cli('--billing-scope', '/subscriptions/contoso'), { message: scope });
  assert.throws(() => cli('--billing-scope', `/subscriptions/${SUB}/resourceGroups/rg-contoso`), { message: scope });
  assert.throws(() => cli('--billing-scope', `${ACCOUNT}/invoiceSections/XY12`), { message: scope });
});

test('cli: --github-enterprise and --billing-scope leave each source as --data or the record has it', () => {
  // Help says each needs its source's api mode; that is not checked here, so an existing install can change either alone.
  const args = cli('--github-enterprise', 'contoso', '--billing-scope', ACCOUNT);
  assert.deepEqual(args.dataSources, {});
  const config = emptyConfig();
  const before = { ...config.dataSources };
  applyDataFlags(config, args);
  assert.deepEqual(config.dataSources, before);
  assert.equal(config.github?.enterprise, 'contoso');
  assert.equal(config.commercialTerms?.scope, ACCOUNT);
});

test('cli: --data takes source=mode pairs, repeated or comma-separated, in any case and with the aliases', () => {
  assert.deepEqual(cli('--data', 'studioCredits=flow, github=token', '--data', 'COWORKCREDITS=Dataflow', '--data', 'orgData=csv,commercialTerms=API').dataSources, {
    studioCredits: 'api',
    github: 'api',
    coworkCredits: 'api',
    orgData: 'csv',
    commercialTerms: 'api',
  });
  assert.deepEqual(cli('--data', 'github=csv', '--data', 'github=skip').dataSources, { github: 'skip' }, 'the last one wins');
  assert.deepEqual(cli('preview', '--data', 'azureAi=api', '--csv', 'usage.csv').dataSources, { azureAi: 'api' });
  assert.deepEqual(cli('preview', '--csv', 'usage.csv').csvFiles, ['usage.csv']);
});

test('cli: --data refuses sources it does not have and modes a source cannot take', () => {
  assert.throws(() => cli('--data', 'agent365=api'), { message: `--data: unknown source "agent365". Use one of ${SOURCES}.` });
  for (const ah of ['productFeedback=csv', 'workday=csv', 'audit=api']) assert.throws(() => cli('--data', ah), /--data: unknown source/, ah);
  assert.throws(() => cli('--data', 'commercialTerms=csv'), { message: '--data: commercialTerms can be api or skip, not "csv".' });
  assert.throws(() => cli('--data', 'coworkTasks=api'), { message: '--data: coworkTasks can be csv or skip, not "api".' });
  assert.throws(() => cli('--data', 'github=flow'), { message: '--data: github can be api or csv or skip or token, not "flow".' });
  assert.throws(() => cli('--data', 'studioCredits'), { message: '--data: studioCredits can be api or csv or skip or flow, not "".' });
  assert.throws(() => cli('upload', '--data', 'github=csv'), { message: '--data, --csv go with install. To add exports later, use upload.' });
  assert.throws(() => cli('--ui', '--data', 'github=api'), { message: 'With --ui, choose data sources and exports on the Data sources page.' });
});

test('applyDataFlags: --data changes only the sources it names', () => {
  const config = emptyConfig();
  config.dataSources.orgData = 'csv';
  const before = { ...config.dataSources };
  applyDataFlags(config, cli('--data', 'github=api,commercialTerms=api'));
  assert.deepEqual(config.dataSources, { ...before, github: 'api', commercialTerms: 'api' });
  applyDataFlags(config, cli());
  assert.deepEqual(config.dataSources, { ...before, github: 'api', commercialTerms: 'api' });
});

test('applyDataFlags: another GitHub enterprise needs a new token; the same one in other capitals keeps it', () => {
  const config = emptyConfig();
  applyDataFlags(config, cli('--github-enterprise', 'contoso'));
  assert.deepEqual(config.github, { enterprise: 'contoso' });

  const token = { tokenSetAt: '2026-05-01T00:00:00Z', tokenExpires: '2026-08-01T00:00:00Z' };
  config.github = { enterprise: 'contoso', secretName: 'consumption-central-github-pat-2', tokenInNotebook: true, ...token };
  applyDataFlags(config, cli('--github-enterprise', 'CONTOSO'));
  assert.deepEqual(config.github, { enterprise: 'CONTOSO', secretName: 'consumption-central-github-pat-2', tokenInNotebook: true, ...token });

  applyDataFlags(config, cli());
  assert.equal(config.github.enterprise, 'CONTOSO', 'no flag, no change');

  applyDataFlags(config, cli('--github-enterprise', 'contoso-labs'));
  assert.deepEqual(config.github, { enterprise: 'contoso-labs', secretName: 'consumption-central-github-pat-2', tokenInNotebook: true });
});

test('applyDataFlags: another billing scope is read again after setup; the same one keeps its last run', () => {
  const config = emptyConfig();
  applyDataFlags(config, cli('--billing-scope', `${ACCOUNT}/`));
  assert.deepEqual(config.commercialTerms, { scope: ACCOUNT });

  const ran = { scopeName: 'Contoso Dev', ranAt: '2026-05-02T00:00:00Z', status: 'Completed' };
  config.commercialTerms = { scope: `/SUBSCRIPTIONS/${SUB.toUpperCase()}/`, ...ran };
  applyDataFlags(config, cli('--billing-scope', `/subscriptions/${SUB}`));
  assert.deepEqual(config.commercialTerms, { scope: `/subscriptions/${SUB}`, ...ran });

  applyDataFlags(config, cli());
  assert.deepEqual(config.commercialTerms, { scope: `/subscriptions/${SUB}`, ...ran }, 'no flag, no change');

  applyDataFlags(config, cli('--billing-scope', ACCOUNT));
  assert.deepEqual(config.commercialTerms, { scope: ACCOUNT });
});
