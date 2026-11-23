const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const loadTypescript = (module, path) => {
  const source = fs.readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  module._compile(output.outputText, path)
}
require.extensions['.ts'] = loadTypescript
require.extensions['.tsx'] = loadTypescript

const { studioModel } = require('../src/metrics/studio.ts')
const { StudioConsumption, StudioCost, StudioForecast } = require('../src/pages/Studio.tsx')
const { DataContext, DEFAULT_SETTINGS } = require('../src/data/store.ts')

const resourceOnly = {
  groupAttrs: [], groups: new Map(), studioTenant: [], studioUsers: [],
  studioAgents: [
    { agent: 'Resource A', product: 'Power Automate', feature: '', model: '', env: '', billed: 0, nonBilled: 12 },
    { agent: 'Resource B', product: 'Power Automate', feature: '', model: '', env: '', billed: 1, nonBilled: 3 },
  ],
}

test('resource data without tenant history is not treated as an empty Studio dataset', () => {
  const model = studioModel(resourceOnly, {}, DEFAULT_SETTINGS)

  assert.equal(model.agents.length, 2)
  assert.equal(model.agentTotal, 16)
  assert.match(model.headline, /tenant/i)
  assert.match(model.forecast.note, /tenant history/i)
  assert.equal(model.forecast.cost30, null)
  assert.match(model.agents[0].action, /mostly non-billed/)
  assert.doesNotMatch(model.agents[0].action, /covered/i)
})

test('resource-only pages show the snapshot and do not invent a tenant forecast', () => {
  const render = (component) => renderToStaticMarkup(React.createElement(
    DataContext.Provider,
    { value: { ds: resourceOnly, filters: {}, settings: DEFAULT_SETTINGS } },
    React.createElement(component),
  ))
  const consumption = render(StudioConsumption)
  assert.match(consumption, /Resources in the resource snapshot/)
  assert.match(consumption, /Resource A/)
  assert.match(consumption, /No tenant consumption rows/)
  const cost = render(StudioCost)
  assert.match(cost, /Resource snapshot billed credits/)
  assert.match(cost, /Resource B/)
  assert.match(cost, /No tenant consumption rows/)
  const forecast = render(StudioForecast)
  assert.match(forecast, /A forecast requires tenant consumption history/)
  assert.doesNotMatch(forecast, /No Studio data loaded/)
})

test('user snapshot remains the source for resource totals when supplied', () => {
  const ds = {
    ...resourceOnly,
    studioUsers: [{ email: 'person@example.test', name: 'Person', agent: 'Resource A', billable: 5, credits: 7, licensed: true }],
  }
  const render = (component) => renderToStaticMarkup(React.createElement(
    DataContext.Provider,
    { value: { ds, filters: {}, settings: DEFAULT_SETTINGS } },
    React.createElement(component),
  ))
  assert.match(render(StudioConsumption), /Resources in the user snapshot/)
  const cost = render(StudioCost)
  assert.match(cost, /User snapshot billable credits at the PAYG rate/)
  assert.match(cost, /Billable credits/)
  assert.doesNotMatch(cost, /Resource snapshot billed credits/)
})
