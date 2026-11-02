# Commercial terms — where the numbers come from

Consumption Central asks for seven values. One is your data folder; the other six are commercial terms.

**None of the exports carry pricing.** Viva Insights, PPAC and GitHub all report *consumption* —
credits used, seats held — and none of them says what a credit costs you. That is why the template
asks.

This page covers where to find each, and which can be looked up automatically.

---

## The short version

| Parameter | Default | Where yours comes from |
|---|---|---|
| `CreditRate` | 0.01 | Your agreement or invoice. List price is $0.01 and [verifiable via API](#verifying-the-list-rate). |
| `PrepaidCreditRate` | 0.008 | Your prepaid capacity agreement. Placeholder assumes 20% off — see [the tier warning](#the-prepaid-rate-default-assumes-the-largest-tier). |
| `PrepaidCreditBalance` | 0 | M365 admin center → Copilot → Cost management |
| `GitHubBusinessSeatPrice` | 19 | Your GitHub agreement. [List price][ghp]. |
| `GitHubEnterpriseSeatPrice` | 39 | Your GitHub agreement. [List price][ghp]. |
| `BillingPeriodWeeks` | 4 | Your billing cycle |

Every one of these is also written into the parameter's own description, so hovering the **ⓘ** in
the template prompt tells you what to type without coming here.

The **Cowork: Chargeback** page and the app's Chargeback view price with the same three Cowork values:
the prepaid share of each cost centre's credits at `PrepaidCreditRate`, the rest at `CreditRate`,
with the share set by `PrepaidCreditBalance`. The Fabric App uses the commercial terms typed in it.
No separate chargeback rate exists to set.

---

## Can any of it be looked up automatically?

Asked properly, and the answer is mostly no — but one is genuinely useful.

| | Automatable? | |
|---|---|---|
| `CreditRate` (list) | ✅ **Yes** | Azure Retail Prices API, public, no auth |
| `CreditRate` (your negotiated rate) | ⚠️ Possible | Azure Cost Management, needs auth — see below |
| `PrepaidCreditBalance` | ⚠️ Possible | Reservations + Cost Management, pipeline only |
| `PrepaidCreditRate` | ❌ No | Tier *discounts* are published; your tier is not — see below |
| GitHub seat prices | ❌ No | Contract values. No GitHub API returns a price. |

### The prepaid rate default assumes the largest tier

The **Copilot Credit Pre-Purchase Plan (P3)** discount is set by the size of the annual commitment.
The September 2026 *Copilot Credits Guide* publishes the full ladder:

| Tier | Copilot Credits | Discount | Implied rate |
|---:|---:|---:|---:|
| 1 | 300,000 | 5% | 0.0095 |
| 2 | 1,500,000 | 6% | 0.0094 |
| 3 | 3,000,000 | 7% | 0.0093 |
| 4 | 15,000,000 | 8% | 0.0092 |
| 5 | 30,000,000 | 10% | 0.0090 |
| 6 | 75,000,000 | 12% | 0.0088 |
| 7 | 150,000,000 | 14% | 0.0086 |
| 8 | 225,000,000 | 17% | 0.0083 |
| 9 | 300,000,000 | 20% | 0.0080 |

> **The `0.008` default is tier 9** — a 300,000,000-credit annual commitment, the largest discount
> Microsoft offers. It was chosen as a round placeholder, not as a typical rate. Most organisations
> land in tiers 1–4, so a customer who accepts the default **understates prepaid cost by up to 15%**.
> Set it from your own agreement, or from the implied-rate column above if you know your tier.

Two further things the guide is explicit about, both of which change how the prepaid numbers on the
Optimization page should be read:

- **Unused credits expire at the end of the annual term.** They do not roll over. An underused
  balance is a loss, not a saving deferred.
- If usage exceeds the balance, the excess **bills pay-as-you-go** rather than failing — which is why
  the template prices consumption beyond the balance at `CreditRate`, not `PrepaidCreditRate`.

Both the pay-as-you-go meter and the P3 plan **decrement the Microsoft Azure Consumption Commitment
(MACC)**, so Copilot credit spend counts toward an existing Azure commitment.

### Verifying the list rate

The Azure Retail Prices API is public and needs no authentication:

```
https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Microsoft Copilot Studio' and meterName eq 'Pay As You Go Copilot Credit' and armRegionName eq 'eastus'&api-version=2023-01-01-preview
```

Returns, verified live 2026-08-05:

```json
{
  "retailPrice": 0.01,
  "meterName": "Pay As You Go Copilot Credit",
  "productName": "Microsoft Copilot Studio",
  "serviceFamily": "Microsoft 365 Copilot",
  "unitOfMeasure": "1",
  "effectiveStartDate": "2025-09-01T00:00:00Z"
}
```

Swap `eastus` for your region. The rate is $0.01 across all ~30 regions checked.

Note the service name: Cowork and Work IQ credits bill under **Microsoft Copilot Studio** in Azure,
not under a "Cowork" meter. Searching for Cowork returns nothing.

**We deliberately do not call this from the template.** It would add a network dependency to every
refresh, and it only returns the *list* price — which is already the default. A customer with a
negotiated rate still has to type theirs. Use the URL to confirm the list rate has not moved; keep
the parameter for what you actually pay.

### Your actual negotiated rate

Copilot credits bill to an Azure subscription, so they appear in **Azure Cost Management** — and
cost divided by quantity is your genuine effective rate, discounts included.

```http
POST https://management.azure.com/subscriptions/{SUB}/providers/Microsoft.CostManagement/query?api-version=2025-03-01
Authorization: Bearer {token}

{
  "type": "Usage",
  "timeframe": "MonthToDate",
  "dataset": {
    "granularity": "None",
    "aggregation": {
      "totalCost":     { "name": "CostInBillingCurrency", "function": "Sum" },
      "totalQuantity": { "name": "Quantity",              "function": "Sum" }
    },
    "filter": {
      "and": [
        { "dimensions": { "name": "ServiceName", "operator": "In",
                          "values": ["Microsoft Copilot Studio"] } },
        { "dimensions": { "name": "MeterName", "operator": "In",
                          "values": ["Pay As You Go Copilot Credit"] } }
      ]
    }
  }
}
```

Effective rate = `CostInBillingCurrency / Quantity`.

Needs **Cost Management Reader** on the subscription, and prior usage to divide by. Use
`AmortizedCost` rather than `ActualCost` if you hold prepaid capacity — reservation-covered usage
shows as $0 under ActualCost, which would make the rate look like zero.

This suits the [Fabric path](../2.%20Fabric/), where a service principal and a pipeline already
exist. It is a poor fit for the CSV template, which would need interactive auth on every refresh.

> **This is now built.** [`Ingest_CommercialTerms.ipynb`](../2.%20Fabric/notebooks/Ingest_CommercialTerms.ipynb)
> runs the query above, derives the rate, refuses to write anything implausible, and publishes a
> one-row `commercial_terms` table. The Fabric template reads that table in preference to its
> parameters, per column — so the report shows your invoiced rate without anyone retyping it, and a
> customer who skips the notebook is unaffected.

### Prepaid balance — the one worth automating

`PrepaidCreditBalance` is the only commercial value that genuinely moves month to month. It can be
derived as *(P3 reservation quantity) − (consumed reservation units from Cost Details)*, using the
Reservations API plus Cost Management.

There is no single endpoint, so this is pipeline work, not a template query. If you hold P3 capacity
and are on the Fabric path, it is the automation with the best return of the five.

### Chargeback actuals — possible later, not built

Chargeback today is an *allocation*: credits from Viva Insights, priced at the rates above. Azure Cost
Management could supply the *billed* amount, through the same Query API that
`Ingest_CommercialTerms.ipynb` already calls and `Ingest_Azure_AI.ipynb` uses for
`copilot_payg_spend`. What it can and can't add:

- **It can** give the billed pay-as-you-go total for Copilot credits per subscription, resource group
  or tag, per day. That is enough to check the allocation against the invoice.
- **It can't** give a cost per person or per spending policy. Cost Management is resource-grained,
  with no person in the data, so it can't replace the allocation.
- **Per department** actuals would need each cost centre billed through its own subscription, resource
  group or tag, plus a mapping table from that scope to the `CostCentre` column.
- Prepaid capacity shows as reservation draw-down (`AmortizedCost`), not per cost centre, so the
  pro-rata share would still be needed.

So the useful later step is a `copilot_cost_actuals` table and a billed-against-allocated
reconciliation, not a different chargeback. The Fabric App's Cowork stage already shows what was
billed in Azure next to the estimate.

### What genuinely cannot be automated

**Prepaid rate.** The P3 discount *ladder* is published — see
[the tier table above](#the-prepaid-rate-default-assumes-the-largest-tier) — but which tier you hold
is not exposed by any API, and the resulting per-credit price is only visible in the Azure portal's
Reservations blade. It can be derived retrospectively from a past purchase, but that tells you what
you paid last time, not what you pay now.

**GitHub seat prices.** No GitHub API returns a price. The billing API confirms the *plan*
(`plan_type: business` / `enterprise`), which at least prevents applying the wrong tier — the
[API ingester](../2.%20Fabric/notebooks/Ingest_GitHub_API.ipynb) uses it for that — but the rate is
a contract value.

---

## If your agreement prices products differently

`CreditRate` is one number covering Cowork, Studio and GitHub, because all three publish $0.01.

If yours differ, leave the parameter alone and edit the **Settings** query
(*Transform data → Settings*). It keeps a separate column per product:

```m
CreditRate,        PrepaidCreditRate,      // Cowork
CreditRate,        PrepaidCreditRate,      // Studio
PrepaidCreditBalance,
CreditRate,        GitHubBusinessSeatPrice, GitHubEnterpriseSeatPrice
```

Replace any `CreditRate` reference with a literal — `0.009` — and that product alone re-prices.

---

## Sources

| Finding | Source | Checked |
|---|---|---|
| Retail Prices API carries the credit meter at $0.01 | Live API call | 2026-08-05 |
| Copilot credits bill to an Azure subscription | [usage-based-billing-overview][ubo] | 2026-07-30 |
| P3 prepaid discount tiers | [copilot-credit-p3][p3] | 2026-07-17 |
| P3 tier ladder, 5%–20%; unused credits expire at end of term; both constructs decrement MACC | Copilot Credits Guide, September 2026, p5 | 2026-09-17 |
| Cost Management query API | [Query API reference][cmq] | 2026-08-05 |
| GitHub published seat pricing | [Copilot plans][ghp] | 2026-08-05 |

[ubo]: https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-overview-copilot-credits
[p3]: https://learn.microsoft.com/en-us/azure/cost-management-billing/reservations/copilot-credit-p3
[cmq]: https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage
[ghp]: https://github.com/features/copilot/plans
