const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const originalLoad = Module._load
Module._load = function (request, ...args) {
  if (request === 'virtual:embedded-sample') return {}
  return originalLoad.call(this, request, ...args)
}
const loadTypescript = (module, path) => {
  const source = fs.readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  module._compile(output.outputText.replaceAll('import.meta.env.BASE_URL', '"/"'), path)
}
require.extensions['.ts'] = loadTypescript
require.extensions['.tsx'] = loadTypescript

const { parseCsv } = require('../src/data/csv.ts')
const { buildDataset, loadFiles } = require('../src/data/load.ts')
const { DataContext } = require('../src/data/store.ts')
const { CostManagement } = require('../src/pages/CostManagement.tsx')

const file = (name, text) => ({ name, ...parseCsv(text) })
const service = file('CopilotCostServiceDaily.csv', 'Date,ServiceId,ConsumedQuantity,Unit\n2026-01-01,cowork,2.5,copilotCredit')
const funding = file('CopilotCostFundingMonthly.csv', 'Month,FundingClass,ConsumedQuantity,Unit,LatestSourceDateTime\n2026-01-01,prepaid,3,copilotCredit,2026-01-02T00:00:00Z')
const balance = file('CopilotCostBalance.csv', 'AsOfUTC,BillingMethod,PurchasedQuantity,ConsumedQuantity,RemainingQuantity,Unit,LastModifiedDateTime\n2026-01-02T00:00:00Z,prepaid,,4,,copilotCredit,')

test('Graph CSVs stay separate and render missing balance quantities as blanks', () => {
  const { dataset, found } = buildDataset([service, funding, balance], 'fixture', false)
  assert.deepEqual(found.map((f) => f.kind), ['costService', 'costFunding', 'costBalance'])
  assert.equal(dataset.costService[0].credits, 2.5)
  assert.equal(dataset.costFunding[0].credits, 3)
  assert.equal(dataset.costBalance[0].remaining, null)
  assert.equal(dataset.credits.length, 0)
  const html = renderToStaticMarkup(React.createElement(
    DataContext.Provider, { value: { ds: dataset } }, React.createElement(CostManagement),
  ))
  assert.match(html, /Service usage by completed UTC day/)
  assert.match(html, /Funding usage by calendar month/)
  assert.match(html, /Tenant balance snapshot/)
  assert.match(html, /cowork/)
  assert.match(html, /2\.50/)
  assert.match(html, /2026-01-02T00:00:00Z/)
  assert.match(html, /–/)
})

test('invalid or ambiguous Graph files fail instead of showing zero or duplicate totals', () => {
  assert.throws(() => buildDataset([service, service], 'fixture', false), /only one costService/)
  assert.throws(() => buildDataset([file('CopilotCostBalance.csv', 'bad\nvalue')], 'fixture', false), /unexpected schema/)
  assert.throws(() => buildDataset([file('bad.csv', 'Date,ServiceId,ConsumedQuantity,Unit\n2026-01-01,cowork,nope,copilotCredit')], 'fixture', false), /invalid ConsumedQuantity/)
  assert.throws(() => buildDataset([file('bad.csv', 'Date,ServiceId,ConsumedQuantity,Unit\n2026-01-01,cowork,1,USD')], 'fixture', false), /unexpected credit unit/)
  assert.throws(() => buildDataset([file('bad.csv', 'Month,FundingClass,ConsumedQuantity,Unit,LatestSourceDateTime\n2026-02-31,prepaid,1,copilotCredit,')], 'fixture', false), /invalid Month/)
})

test('malformed CSV rows fail during file loading', async () => {
  const text = 'Date,ServiceId,ConsumedQuantity,Unit\n2026-01-01,cowork,1,copilotCredit,extra'
  await assert.rejects(loadFiles([new File([text], 'CopilotCostServiceDaily.csv')]), /CSV parsing failed/)
  const duplicate = 'Date,ServiceId,ConsumedQuantity,Unit,unit\n2026-01-01,cowork,1,copilotCredit,copilotCredit'
  await assert.rejects(loadFiles([new File([duplicate], 'CopilotCostServiceDaily.csv')]), /duplicate column headers/)
})
