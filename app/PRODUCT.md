<!-- impeccable:product-schema 1 -->
# Consumption Central app

## Platform
A web app that ships two ways: as a single self-contained HTML file that runs offline in Edge or Chrome, and as a Copilot **Managed App** (Copilot Managed Runtime). It is designed desktop first, for 1280–1600px, and works down to 390px.

## Users
- **FinOps and finance owners.** They track what Copilot credits cost across products, reconcile against the bill, and plan next year's budget.
- **Copilot, Copilot Studio and GitHub admins.** They decide where to trim: idle seats, oversized prepaid packs, runaway agents, under-used provisioned capacity.

They know their own billing and are familiar with the Power BI report. They open the app monthly, often while preparing a cost review.

## Purpose
This is an app version of the Consumption Central Power BI report. It keeps **the same information as the PBI**: every measure, chart and table, including the Cowork Tasks page, with the same DAX definitions.

The navigation is simpler. Instead of 24 report pages, there are six top tabs with short sub-views:
- Overview
- Cowork & Work IQ
- Copilot Studio
- GitHub Copilot
- Azure AI Foundry
- Guide

## Data
- The input is the CSV exports used by the Local CSV path: Cowork credits and tasks, people metadata, spending policies, Copilot Studio, GitHub AI usage, Azure AI spend, deployment health, billing reconciliation and Entra org attributes.
- All parsing and metric calculation happens in the browser. Data never leaves the tenant.
- Any subset of sources can be loaded. Missing sources show a dash or an empty state.
- A synthetic sample is bundled, and it is always clearly labelled as sample data.

## Constraints
- Metric definitions must match the PBI's DAX. Deliberate presentation changes are listed in the Guide.
- No external CDNs, fonts or network calls. The Managed Runtime CSP blocks them.
- Accessibility: WCAG AA contrast, controls reachable by keyboard, and visible focus.

## Brand and tone
Microsoft-adjacent, calm and analytical. The look follows a reference cost-dashboard design: a dark-teal header band over a white working surface. Labels use plain English, and the numbers are the hero.

## Anti-goals
- No marketing hero, decorative gradients or illustration.
- No dashboards made of cards inside cards.
- Don't drop any PBI metric to "simplify". Simplify through grouping and navigation instead.
