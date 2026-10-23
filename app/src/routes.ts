import { useEffect, useState } from 'react'

export type TabId = 'overview' | 'cowork' | 'studio' | 'github' | 'azure' | 'guide'

export interface ViewDef {
  id: string
  label: string
  intro: string
}

export interface TabDef {
  id: TabId
  label: string
  intro: string
  views: ViewDef[]
}

const FOUR = (what: string): ViewDef[] => [
  { id: 'consumption', label: 'Consumption', intro: `Who is consuming ${what} credits, and how much?` },
  { id: 'cost', label: 'Cost', intro: 'What does it cost, and where does the money go?' },
  { id: 'optimization', label: 'Optimization', intro: 'Where is capacity or money being wasted?' },
  { id: 'forecast', label: 'Forecast', intro: 'Where is demand heading, and how confident are we?' },
]

export const TABS: TabDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    intro: 'Where credit spend is going across all four products, on the same dates.',
    views: [],
  },
  {
    id: 'cowork',
    label: 'Cowork & Work IQ',
    intro: 'Microsoft 365 Copilot credits, per person, per week.',
    views: [
      { id: 'consumption', label: 'Consumption', intro: 'Who is consuming credits, and how much?' },
      { id: 'cost', label: 'Cost', intro: 'What does it cost: prepaid, pay-as-you-go and blended?' },
      { id: 'tasks', label: 'Tasks', intro: 'Task mix, credit intensity and estimated work equivalent.' },
      { id: 'optimization', label: 'Optimization', intro: 'How do we optimize credit capacity and configuration?' },
      { id: 'forecast', label: 'Forecast', intro: 'Where is demand heading, and how confident are we?' },
    ],
  },
  {
    id: 'studio',
    label: 'Copilot Studio',
    intro: 'Credits consumed by Copilot Studio agents: per tenant, per agent and per user.',
    views: FOUR('Copilot Studio'),
  },
  {
    id: 'github',
    label: 'GitHub Copilot',
    intro: 'GitHub Copilot credits, seats and the monthly pool.',
    views: FOUR('GitHub Copilot'),
  },
  {
    id: 'azure',
    label: 'Azure AI Foundry',
    intro: 'Azure AI spend, tokens, provisioned capacity and billing reconciliation.',
    views: [
      { id: 'spend', label: 'Spend', intro: 'What is Azure AI costing, and what is driving it?' },
      { id: 'health', label: 'Capacity & health', intro: 'Is provisioned capacity used, and are deployments healthy?' },
      { id: 'recon', label: 'Reconciliation', intro: 'Does the usage estimate match the Azure bill?' },
    ],
  },
  {
    id: 'guide',
    label: 'Guide',
    intro: 'How to read the numbers, how the sources join, and what every term means.',
    views: [
      { id: 'start', label: 'Start here', intro: 'Where your Copilot credits go, and what to do about it.' },
      { id: 'read', label: 'How to read', intro: 'What the numbers mean, and what they cannot tell you.' },
      { id: 'cowork', label: 'Cowork', intro: 'Copilot credits consumed in Microsoft 365, per person, per week.' },
      { id: 'studio', label: 'Studio', intro: 'Credits consumed by Copilot Studio agents.' },
      { id: 'github', label: 'GitHub', intro: 'GitHub Copilot premium requests, seats and the monthly pool.' },
      { id: 'azure', label: 'Azure', intro: 'Azure AI spend, tokens and provisioned capacity.' },
      { id: 'glossary', label: 'Glossary', intro: 'What every term and metric in the report means.' },
    ],
  },
]

export interface Route {
  tab: TabDef
  view: string
}

function parse(hash: string): Route {
  const [t, v] = hash.replace(/^#\/?/, '').split('/')
  const tab = TABS.find((x) => x.id === t) ?? TABS[0]
  const view = tab.views.find((x) => x.id === v)?.id ?? tab.views[0]?.id ?? ''
  return { tab, view }
}

export function useRoute(): [Route, (tab: TabId, view?: string) => void] {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const go = (tab: TabId, view?: string) => {
    location.hash = `/${tab}${view ? `/${view}` : ''}`
  }
  return [route, go]
}
