# Measure reference

Every documented measure in the Consumption Central model, grouped as it appears in the Power BI
field list.

**This file is generated from the model itself** — the descriptions here are the same ones
you see in a tooltip when you hover a field in Power BI. If a measure is missing, it has no
description in the model and should be given one.

221 documented measures.

---

## Studio

### Forecast

**`Daily Run Rate`** · *Credit Consumption (Tenant)*  
Average Studio credits per calendar day across the observed history window. Missing dates inside that span count as zero usage rather than inflating an active-day average.

**`Projected Credits (30d)`** · *Credit Consumption (Tenant)*  
First forecast month, using the same fitted or selected growth rate as the projection chart.

**`Projected Cost (30d)`** · *Credit Consumption (Tenant)*  
Projected 30-day cost, valued at the blended rate implied by the actual prepaid / pay-as-you-go split rather than a single assumed price.

**`Projected Cost by Agent (12mo)`** · *Credit Consumption (Agent)*  
This agent's slice of the projected twelve-month cost, allocated by its share of consumption. Same assumption as the 30-day version: the mix between agents is taken to hold.

**`Projected Cost by Agent (30d)`** · *Credit Consumption (Agent)*  
This agent's slice of the projected 30-day cost. The per-agent export carries no date, so an agent cannot have its own run rate. This allocates the tenant projection by the agent's share of consumption instead, which assumes the mix between agents holds. Fine for sizing, wrong for an agent that is ramping or being retired.

**`Projected Cost by Group (12mo)`** · *Credit Consumption (User)*  
This group's slice of the projected twelve-month cost, allocated by its share of user-attributed consumption.

**`Projected Cost by Group (30d)`** · *Credit Consumption (User)*  
This group's slice of the projected 30-day cost. The per-user export carries no date, so this allocates the tenant projection by the group's share of user-attributed consumption. Only covers credits that reached a named user - agent and environment activity with no person attached is not in the share, so these will not sum to the tenant total.

**`Projected Credits (Horizon)`** · *Credit Consumption (Tenant)*  
Sum of forecast months over the selected planning horizon, using the same fitted or selected growth rate as the projection chart.

**`Studio Days Observed`** · *Credit Consumption (Tenant)*  
Distinct days on which any Studio consumption was recorded. The export only contains days with activity, so this is the true observation count.

**`Studio Entitlement Days Remaining`** · *Credit Consumption (Tenant)*  
How long the prepaid capacity lasts at the current daily rate. Counts only environments that hold capacity - an environment with none cannot run one down. Blank when there is no prepaid capacity to burn through.

**`Studio Forecast Confidence`** · *Credit Consumption (Tenant)*  
History-length and coverage indication. A fit needs at least 28 calendar days and 7 days with positive consumption; sparse or shorter windows remain low confidence. This is not a statistical prediction interval.

**`Studio Forecast Note`** · *Credit Consumption (Tenant)*  
States whether the projection uses historical fitting, a selected scenario, or a flat fallback because usable history is insufficient. Also discloses the missing-day assumption and growth bounds.

**`Studio Forecast Summary`** · *Credit Consumption (Tenant)*  
Written summary of the Studio outlook, filter-aware. Leads with the twelve month number so it answers the page title.

**`Studio Growth Applied %`** · *Credit Consumption (Tenant)*  
On **Fitted from history**, uses the fitted monthly rate when history is sufficient; otherwise falls back to flat and explains why. Manual scenarios keep their selected rates.

**`Studio Fitted Monthly Growth %`** · *Credit Consumption (Tenant)*  
Fits a log trend to the seven-day rolling average of dated tenant consumption. Requires at least 28 calendar days and 7 positive-consumption days. Missing dates inside the span are treated as zero; fitted monthly growth is bounded to -30%/+30% for planning.

**`Studio History Span Days`** / **`Studio History Coverage %`** · *Credit Consumption (Tenant)*  
Calendar span between the first and last dated observations in scope, and the fraction of that span with recorded rows. Environment and selected-period filters remain in scope.

**`Studio Month Cost`** · *Credit Consumption (Tenant)*  
Cost of that month at the blended rate actually being achieved across the measured prepaid and pay-as-you-go split.

**`Studio Month Credits`** · *Credit Consumption (Tenant)*  
Credits expected in a given month ahead, growing a 30-day run rate forward at the applied rate.

**`Studio Sessions Proxy`** · *Credit Consumption (Tenant)*  
Distinct days with recorded Studio activity in the current selection.

**`Studio Year Cost`** · *Credit Consumption (Tenant)*  
Cost over the next twelve months at today's achieved blended rate.

**`Studio Year Credits`** · *Credit Consumption (Tenant)*  
Credits projected over the next twelve months, compounding the chosen growth rate month on month.

### Adoption

**`Agents without User Activity`** · *Agent Bridge*  
Agents present in the per-agent export but with no recorded user activity - typically system or orchestration agents.

**`Avg Agents per User`** · *Credit Consumption (User)*  
Agents touched per user - a breadth-of-adoption signal within Studio.

**`Org Filter Status`** · *Credit Consumption (User)*  
Plain statement of whether the Group By control will reach the Studio figures on this page, and which grains it cannot reach.

**`Org Match Rate`** · *Credit Consumption (User)*  
Share of Studio users that resolve to a record in the org dimension. Studio reports a work email and the org export a UPN; in most tenants these are the same string, but they need not be. A low figure here means slicing Studio by department will silently drop people.

**`Studio Users with Copilot Licence`** · *Credit Consumption (User)*  
Studio users who also hold a Microsoft Copilot licence.

### Billing

**`Agent Credit Share %`** · *Credit Consumption (Agent)*  
This agent's share of all consumed Studio credits in the current view.

**`Billed Credit Ratio`** · *Credit Consumption (Agent)*  
The share of an agent's credits that were chargeable. High is not necessarily bad - it means the agent's work falls outside what prepaid capacity covers. Shown as "Charged %".

**`Billing Active Users`** · *Credit Consumption (User)*  
Distinct people who consumed at least one Studio credit.

**`Billing Agents with Credits`** · *Credit Consumption (Agent)*  
Distinct agents appearing in the billing actuals.

**`Billing Period`** · *Credit Consumption (Tenant)*  
Coverage window of the loaded export, inferred from Usage_Date. The per-agent and per-user exports carry no date, so this states the period every figure on the page refers to.

**`Group Credit Share %`** · *Credit Consumption (User)*  
This group's share of user-attributed Studio credits. Separate from User Credit Share % because the denominator has to clear the Group By and Org tables too. A visual grouped by Group By[Group] filters through Org, so clearing only the fact table leaves the denominator scoped to the group and every share reads 100%.

**`Studio Consumed Credits (Tenant)`** · *Credit Consumption (Tenant)*  
All Studio credits consumed: prepaid plus pay-as-you-go.

**`Studio Entitled Capacity`** · *Credit Consumption (Tenant)*  
Credits bought up front for an environment. Microsoft calls this "entitlement" in the Studio admin centre; the report says "Prepaid capacity" to match the word used on the Cowork pages for the same idea. Real money, unlike the user and policy limits on Cowork, which are only caps. The export repeats this on every daily row, so this reads the latest value per environment rather than summing across days.

**`Studio Entitlement Headroom`** · *Credit Consumption (Tenant)*  
Prepaid credits still unused, across environments that hold any. Shown as "Prepaid left". Environments with no prepaid capacity bill directly and are excluded rather than dragging this negative.

**`Studio Entitlement Utilisation %`** · *Credit Consumption (Tenant)*  
How much of the prepaid capacity has been used, across environments that hold any. Over 100% means prepaid is exhausted and usage has spilled onto pay-as-you-go. Shown as "Prepaid used %".

**`Studio PAYG Consumed`** · *Credit Consumption (Tenant)*  
Pay-as-you-go credits consumed above entitlement, billed as overage. Gated on the selected period, but narrowing rather than replacing existing date context so the figure still varies along a date axis.

**`Studio Prepaid Consumed`** · *Credit Consumption (Tenant)*  
Prepaid credits consumed, drawn from committed entitlement capacity. Gated on the selected period, but narrowing rather than replacing existing date context so the figure still varies along a date axis.

**`Studio Prepaid Cost`** · *Credit Consumption (Tenant)*  
Cost of Studio consumption drawn from prepaid capacity packs.

**`Studio Prepaid Share %`** · *Credit Consumption (Tenant)*  
Share of Studio spend covered by prepaid capacity rather than billed as pay-as-you-go overage.

**`Studio Total Credits Used`** · *Credit Consumption (User)*  
All credits used across users, billable or not.

**`Total Billable Cost`** · *Credit Consumption (Tenant)*  
Headline Studio cost: prepaid and pay-as-you-go consumption each valued at their own rate. The entitlement export gives the split as measured fact, so this does not assume a single blended price.

**`Total Billable Credits Used`** · *Credit Consumption (User)*  
The chargeable portion of user consumption.

**`Total Billed Credits`** · *Credit Consumption (Agent)*  
Credits the customer is actually charged for.

**`Total Non-Billed Credits`** · *Credit Consumption (Agent)*  
Credits consumed inside entitlement and therefore not charged.

**`User Credit Share %`** · *Credit Consumption (User)*  
This user's share of all Studio credits in the current view.

### Optimisation

**`Agent Action`** · *Credit Consumption (Agent)*  
Recommended action for an agent, combining how much it consumes with how much of that consumption is actually chargeable. These labels must stay character-identical to 'Agent Action Group'[Action], which the Agents by Recommended Action chart matches against.

**`Agents in Action`** · *Agent Action Group*  
Number of agents whose current recommended action matches this label. Mirrors User Count on the Cowork seat chart. Counts agents from the per-agent export rather than the agent bridge. The bridge also carries agents seen only in the per-user export, and those have no agent-grain consumption to classify - they would land in "Unused" purely because they are missing from this file.

**`Agents with No Consumption`** · *Credit Consumption (Agent)*  
Agents present in the export that consumed nothing at all - typically built and then abandoned.

**`Consumption Without Entitlement`** · *Credit Consumption (Tenant)*  
Credits used in environments that hold no prepaid capacity at all, so every credit bills directly. Shown as "Credits with no prepaid cover".

**`Cost in Action`** · *Agent Action Group*  
Billable cost of the agents sitting in this recommended action, so the chart can show what each group is worth in money as well as headcount.

**`Cost per Consumed Credit`** · *Credit Consumption (Agent)*  
Average cost of every credit an agent consumes, billed or not. Reveals which agents are genuinely expensive rather than merely busy.

**`Cost per Studio User`** · *Credit Consumption (User)*  
Studio cost attributable to each consuming person.

**`Credits in Action`** · *Agent Action Group*  
Credits consumed by the agents sitting in this recommended action, for use as a tooltip on the Agents by Recommended Action chart.

**`Entitlement Absorbed %`** · *Credit Consumption (Agent)*  
The share of an agent's credits covered by prepaid capacity, so they never reached a bill. Shown as "Covered, not charged".

**`Environments In Use`** · *Credit Consumption (Tenant)*  
Environments carrying real consumption, so tables can drop the empty ones.

**`Environments Without Entitlement`** · *Credit Consumption (Tenant)*  
How many environments are consuming credits without any prepaid capacity behind them.

**`Features Used`** · *Credit Consumption (Agent)*  
Distinct billable features an agent draws on. Breadth here usually means a richer agent, and a more expensive one.

**`Studio Concentration Summary`** · *Credit Consumption (User)*  
Plain-language reading of how concentrated Studio usage is.

**`Studio Headline`** · *Credit Consumption (Tenant)*  
The single most important thing about Studio spend right now, stated in words. Names the environment carrying most consumption and whether it sits inside an entitlement, because that is what decides the bill.

**`Studio PAYG Share %`** · *Credit Consumption (Tenant)*  
Share of consumption billed as pay-as-you-go overage rather than drawn from prepaid entitlement. A rising value means capacity is undersized.

**`Studio Top 10% Share`** · *Credit Consumption (User)*  
Share of Studio credits used by the heaviest 10% of users. Studio adoption is usually far more concentrated than Cowork.

**`Unlicensed Credits`** · *Credit Consumption (User)*  
Studio credits consumed by people who hold no M365 Copilot licence. Worth knowing: it is demand that a licence purchase would not remove.

---

## GHCP

### Period

**`GHCP Billing Period`** · *GHCP Period*  
Coverage window of the figures on the page, so a reader never has to guess what 'credits' refers to. Mirrors the Billing period tag on the Studio pages.

**`GHCP Period Label`** · *GHCP Period*  
Names the window in prose, for subtitles and narrative cards.

**`GHCP Period Months`** · *GHCP Period*  
Whole calendar months of history in scope. Zero means everything exported. Defaults to zero so every existing figure is unchanged until someone narrows the window.

**`GHCP Period Start`** · *GHCP Period*  
First date still in scope, for measures to filter against. Snaps to the 1st of a month rather than counting days back, because the credit pool resets on the 1st - a window that starts mid-month would be compared against a full month's allowance.

### Forecast

**`GHCP Forecast Confidence`** · *GitHub Usage*  
Confidence in the GitHub Copilot projection, based on how many months of history the fitted growth rate has to work with.

**`GHCP Latest Month Credits`** · *GitHub Usage*  
Credits consumed in the most recent complete month inside the selected period. The basis for every forward-looking figure on the forecast page.

**`GHCP Observed Growth %`** · *GitHub Usage*  
Observed month-on-month growth in credit consumption, fitted across the selected period. Blank when only one month is in scope - a single point cannot describe a trend.

**`GHCP Overage From September`** · *GitHub Usage*  
What the latest month's consumption would cost once the promotional allowance ends on 1 September 2026 - same usage, smaller pool. This is the single most useful number on the page: a tenant reviewing a zero-overage bill today has no other way to see it coming.

**`GHCP Year Credit Share %`** · *GitHub Usage*  
How much of the twelve-month projection is credits drawn beyond the included allowance, as opposed to fixed seat cost.

### Allowance

**`GHCP Monthly Pool`** · *GitHub User*  
Credits included with the seats held, pooled enterprise-wide. This is a pool, not a per-person entitlement. One developer's unused allowance covers another's excess, so there is no such thing as a developer being individually over their limit.

**`GHCP Pool Change %`** · *GitHub User*  
How far the pool changes at the allowance change date. Zero when the tenant is already on the standard entitlement.

**`GHCP Pool From September`** · *GitHub User*  
The pool that applies from the allowance change date, using the standard per-plan entitlements. Both the date and the entitlements are parameters - see Settings.

**`GHCP Pool Headroom`** · *GitHub User*  
Credits left in this month's pool at the latest month's consumption. Negative would mean the pool is already exhausted.

**`GHCP Pool Used %`** · *GitHub User*  
How much of the shared pool the latest month consumed.

### Consumption

**`GHCP Active Developers`** · *GitHub Usage*  
Developers who consumed at least one AI credit in the selected period.

**`GHCP Credits Used`** · *GitHub Usage*  
AI credits consumed through GitHub Copilot in the selected period. Code completions and next-edit suggestions are unlimited on every paid plan and never appear here, so completion volume is not a cost driver.

**`GHCP Credits per Developer`** · *GitHub Usage*  
Average credits per active developer.

**`GHCP Days Observed`** · *GitHub Usage*  
Distinct days on which any GitHub Copilot consumption was recorded, within the selected period.

**`GHCP Licensed Developers`** · *GitHub Usage*  
Developers holding a Copilot seat, whether or not they used it.

**`GHCP Months Observed`** · *GitHub Usage*  
Distinct calendar months present in the selected period. Counting days and dividing by 28 overstates the monthly rate, because the export only carries working days - about 20 a month, not 28.

### Cost

**`GHCP Allowance Absorbed`** · *GitHub Usage*  
The portion of consumption absorbed by the included allowance and therefore never billed. GitHub computes this server-side, so unlike the Cowork prepaid split it is measured rather than assumed.

**`GHCP Gross Value`** · *GitHub Usage*  
What the consumption would be worth with no allowance behind it. NOT a cost. Most or all of it is absorbed by the credits included with the seats, so it is shown as "Usage value (not billed)" rather than sitting in a cost row where it would read as a bill.

**`GHCP Overage Cost`** · *GitHub Usage*  
Credit consumption beyond the shared pool, billed pay-as-you-go at the rate in Settings. GitHub calls this overage; it is the same mechanism as Cowork pay-as-you-go, so the report uses one term for both.

**`GHCP Overage Share %`** · *GitHub Usage*  
Share of consumption that fell outside the included allowance.

**`GHCP Seat Cost (Monthly)`** · *GitHub User*  
Seat cost per month. Copilot Business is $19 a seat, Enterprise $39. For most tenants this dwarfs credit overage, so a cost page that shows only credits misses where the money actually goes.

**`GHCP Total Cost`** · *GitHub Usage*  
Total cost of running GitHub Copilot: seats plus any credit overage.

### Narrative

**`GHCP Basis Note`** · *GitHub Usage*  
Plain statement of what the GHCP figures rest on and what they exclude.

**`GHCP Concentration Summary`** · *GitHub Usage*  
Where credit consumption is concentrated, in words.

**`GHCP Cost Headline`** · *GitHub Usage*  
One line stating where GitHub Copilot cost actually sits, so the page opens with a sentence rather than a number.

**`GHCP Forecast Summary`** · *GitHub Usage*  
Plain-English summary of the GitHub Copilot forecast. Every figure is read from the model, including how much history the fitted rate is based on.

**`GHCP September Cliff`** · *GitHub Usage*  
What happens to the included AI credit allowance when the published rates change. Reads the date and the standard allowances from 'GHCP Allowance Change', says nothing is pending if this tenant is already on standard rates, and switches to past tense once the date has passed. VAR names avoid Today and Lead: both are DAX functions, and a colliding VAR name breaks every query on the model rather than just this measure.

### Optimisation

**`GHCP Coding Agent Share %`** · *GitHub Usage*  
Share of credits consumed by autonomous coding agent runs rather than interactive chat. Agent work is billed under its own SKU and behaves very differently - it runs unattended, so it scales with jobs, not with people.

**`GHCP Cost per Developer`** · *GitHub Usage*  
Monthly cost of a seat plus its share of any overage.

**`GHCP Powerful Model Share %`** · *GitHub Usage*  
Share of credits spent on the most expensive model tier. High-end models cost roughly ten times a lightweight one per token, so a large share here is the biggest single lever on credit consumption.

**`GHCP Seat Cost With No Credit Use`** · *GitHub Usage*  
Monthly seat cost carried by developers who consumed no credits in the selected period.

**`GHCP Seats With No Credit Use`** · *GitHub Usage*  
Seats held by developers who consumed no credits at all in the period. Completions are unlimited and unmetered, so a developer can be genuinely productive and still appear here - treat it as a prompt to check, not proof the seat is wasted.

**`GHCP Top 10% Share`** · *GitHub Usage*  
Share of credits consumed by the heaviest 10% of developers. A high figure means pool pressure is driven by a small group, so enablement or guardrails aimed at them move the number more than anything org-wide.

---

## All products

**`All Cost /mo`** · *Settings*  
All three products' monthly cost added together. Cowork and Studio are credit consumption; GitHub is mostly seats, which is why it dominates.

**`All Credits /mo`** · *Settings*  
All three products' monthly credit run rate added together.

**`All Products Headline`** · *Settings*  
One line on what the combined page can and cannot tell you.

**`Combined Caveat`** · *Settings*  
Why the combined figures understate Copilot Studio. Adapts to whether any unattributed Studio credits are actually present in this tenant's export.

**`Cowork Cost /mo`** · *CoworkBilling*  
Cowork cost normalised to a month.

**`Cowork Credits /mo`** · *CoworkBilling*  
Cowork credits normalised to a month. The three products are exported over different windows - Cowork 13 weeks, GitHub 3 months, Studio 9 days - so raw totals cannot be compared. Every figure on the combined page is a monthly run rate for that reason.

**`GHCP Cost /mo`** · *GitHub Usage*  
GitHub Copilot cost normalised to a month: seats plus any credit overage. Seats are already a monthly figure; overage is averaged over the months in the selection.

**`GHCP Credits /mo`** · *GitHub Usage*  
GitHub Copilot credits normalised to a month, from the calendar months actually present in the selection.

**`Source Windows`** · *Settings*  
States the window each product was exported over, so nobody reads the combined figures as like-for-like actuals.

**`Studio Cost /mo`** · *Credit Consumption (User)*  
Copilot Studio cost normalised to a month, for credits attributed to a named user.

**`Studio Credits /mo`** · *Credit Consumption (User)*  
Copilot Studio credits normalised to a month, from the days observed. Covers only credits attributed to a named user - the agent and environment exports carry no person, so this is a floor rather than the whole picture.

---

## Cowork task breakdown

These measures live on `Cowork Tasks`, use a separate task calendar/period and never contribute to
the existing billing totals. See [basis and editable assumptions](COWORK-TASKS.md).

| Measure | Definition |
|---|---|
| `Reported Cowork Tasks` | Sum of reported task counts; blank with no rows, zero only when measured |
| `Cowork Task Credits` | Sum of fractional task credits; blank if any selected row omits credits |
| `Cowork Credits per Task` | Summed credits / summed tasks; blank at a zero denominator |
| `Cowork Task Share` | Tasks / tasks across the selected categories, preserving other filters |
| `Cowork Task Cost at PAYG` | Task credits x existing Cowork PAYG rate; estimated consumption cost only |
| `Cowork PAYG Cost per Task` | Estimated PAYG task cost / reported tasks |
| `Cowork Task Credit Coverage` | Share of tasks whose source row supplies credits |
| `Cowork Task Effort Minutes` | Selected category's Conservative, Typical or Optimistic assumption |
| `Cowork Valued Tasks` / `Cowork Task Valuation Coverage` | Mapped task counts and their share of reported tasks |
| `Cowork Unmapped Tasks` | Reported tasks without an explicit effort assumption |
| `Cowork Expert-equivalent Hours` | Sum of mapped task count x assumed minutes / 60 |
| `Cowork Expert Hours per Valued Task` | Estimated hours / mapped task count only |
| `Cowork Task Monetary Equivalent` | Covered hours x explicitly selected USD hourly value; otherwise blank |
| `Cowork Task Status Message` / `Cowork Task Value Basis` | Empty-state, coverage and visible scenario/rate explanations |

Unmapped category estimates are blank, not zero. No task-success multiplier, audit-chain expansion,
annualization, prepaid allocation or realized-savings assumption is included.

## Commercial inputs

**`Cowork Capacity Pack Balance Value`** · *Settings*  
Prepaid Capacity Pack credits available to draw down. The Cost page slicer overrides the deployment setting, so a reader can model buying a pack without changing the tenant's configuration.

**`Cowork PAYG Rate Value`** · *Settings*  
Cowork pay-as-you-go rate in force. Keeps its original name so every measure that already prices against it is unaffected by the move.

**`Cowork Prepaid Discount %`** · *Settings*  
How much cheaper a prepaid credit is than a pay-as-you-go one.

**`Cowork Prepaid Rate Value`** · *Settings*  
Cowork prepaid rate in force. Only bites when a pack balance is set.

**`GitHub Allowance Change Date`** · *Settings*  
The date the included GitHub AI credit allowance changes.

**`GitHub Business Seat Value`** · *Settings*  
Monthly list price of a Copilot Business seat.

**`GitHub Business Standard Value`** · *Settings*  
Included credits per Copilot Business seat from the change date.

**`GitHub Enterprise Seat Value`** · *Settings*  
Monthly list price of a Copilot Enterprise seat.

**`GitHub Enterprise Standard Value`** · *Settings*  
Included credits per Copilot Enterprise seat from the change date.

**`GitHub Rate Value`** · *Settings*  
GitHub Copilot pay-as-you-go rate per AI credit, once the included allowance is exhausted.

**`Rates In Use`** · *Settings*  
One line a reader can check the figures against, since the rates are no longer visible as slicers.

**`Studio Effective Rate`** · *Settings*  
Blended Studio rate actually achieved across the measured prepaid and pay-as-you-go split.

**`Studio PAYG Rate Value`** · *Settings*  
Copilot Studio pay-as-you-go rate in force.

**`Studio Prepaid Discount %`** · *Settings*  
Discount the prepaid Studio rate earns against pay-as-you-go.

**`Studio Prepaid Rate Value`** · *Settings*  
Copilot Studio prepaid rate in force. This one matters even with no pack balance entered, because the Studio export reports the prepaid and pay-as-you-go split as measured fact rather than as an assumption.

---

## Period

**`Cowork Period Label`** · *Cowork Period*  
Names the window in prose, for chart subtitles and narrative cards.

**`Cowork Period Weeks`** · *Cowork Period*  
Weeks of history in scope. Defaults to the four-week billing period, so every existing figure is unchanged until someone widens the window.

The Period slicers are single-select and saved on "Current period (4 weeks)", so the slicer always names the window the figures use. That option is always in the Cowork Period table; "Last 8 weeks" and "All history (N weeks)" appear only when that much history is loaded. If nothing is selected, the measure still falls back to four weeks.

**`Studio Period Days`** · *Studio Period*  
Days of history in scope. Zero means everything that was exported.

**`Studio Period Start`** · *Studio Period*  
The earliest usage date still in scope, for measures to filter against.

---

## Forecast

**`Cowork Forecast Summary`** · *CreditsWeekly*  
Plain-English summary of the Cowork forecast. Every figure, including the length of the fitting window, is read from the model - nothing about this tenant is written into the text.

**`Growth Applied %`** · *CreditsWeekly*  
The monthly growth rate the projection uses. Defaults to the rate fitted from 13 weeks of actual usage; move the slider to test a different rate.

**`Growth Is Override`** · *CreditsWeekly*  
True when the reader has overridden the fitted rate, so the page can say so.

**`Month Cost $`** · *CreditsWeekly*  
Cost of that month at the rate actually being achieved today, so a Capacity Pack discount carries through into the projection.

**`Month Credits`** · *CreditsWeekly*  
Credits expected in a given month ahead, growing the current period forward at the applied rate.

**`Year Cost $`** · *CreditsWeekly*  
Cost over the next twelve months at today's achieved rate.

**`Year Credits`** · *CreditsWeekly*  
Credits expected over the next twelve months.

### Model

**`Forecast Accuracy (Backtest)`** · *CreditsWeekly*  
Honest self-assessment: fit on all but the last four weeks, then score the prediction against those held-out weeks.

**`Implied Monthly Growth %`** · *CreditsWeekly*  
Weekly growth implied by the fit, restated monthly so it can be compared directly with the growth scenario picker.

**`Residual SD`** · *CreditsWeekly*  
Standard deviation of the fit residuals — drives the confidence band.

**`Trend Intercept`** · *CreditsWeekly*  
Regression baseline used to calculate fitted values. Internal maths with no business meaning on its own.

**`Trend R2`** · *CreditsWeekly*  
Goodness of fit. Below about 0.6 the linear projection should be treated as indicative only.

**`Trend Slope`** · *CreditsWeekly*  
Least-squares gradient of weekly credits against week index — the growth rate the data actually supports, as opposed to the slider guess.

### Rates

**`Cowork Prepaid Rate`** · *CoworkBilling*  
Now delegates to the Prepaid Rate what-if parameter. Previously this was the hard-coded literal 0.008; the parameter defaults to that same value, so existing figures are unchanged until someone moves the slider.

---

## Other

**`Cost Title`** · *Group By*  
Chart title that names the chosen grouping, replacing the dynamic header a field parameter would have given.

**`GHCP Growth Applied %`** · *GitHub Usage*  
The month-on-month growth rate used by the forecast. Follows the Growth Assumption slicer; with no selection, or on "Fitted from history", it uses the rate actually observed in this tenant's own usage.

**`GHCP Latest Usage Date`** · *GitHub Usage*  
The last day on which any GitHub Copilot credit was drawn, within the selected period. Anchors the projection - month 1 is the month after this.

**`GHCP Month Cost`** · *GitHub Usage*  
Projected total spend in projection month N - seats plus any credits drawn beyond that month's allowance.

**`GHCP Month Credit Cost`** · *GitHub Usage*  
Projected pay-as-you-go credit spend in projection month N: whatever the month's credits exceed that month's allowance, at the published rate.

**`GHCP Month Credits`** · *GitHub Usage*  
Projected credits for month N of the next twelve, growing the most recent full month at the chosen rate.

**`GHCP Month Pool`** · *GitHub Usage*  
The included credit allowance that applies in projection month N. Steps down automatically for months at or beyond the allowance change date held in Settings.

**`GHCP Year Cost`** · *GitHub Usage*  
Total projected spend across the next twelve months - twelve months of seats, plus credits beyond the allowance applying in each month.

**`GHCP Year Credits`** · *GitHub Usage*  
Total projected credits across the next twelve months.

**`Grouped By`** · *Group By*  
Name of the attribute currently chosen, for chart titles. Reads "several attributes" if more than one is selected, which would double-count people.

**`Trend Window Weeks`** · *CreditsWeekly*  
How many weeks the Cowork trend line is actually fitted over. Mirrors the filter context used by [Trend Slope] and [Implied Monthly Growth %] so any prose quoting the window stays true to whatever history is loaded.

---

## Adoption

**`Lapsed Users (Week)`** · *CreditsWeekly*  
Users active last week who did not return this week.

**`Multi-Service %`** · *CreditsWeekly*  
Share of active users who touch more than one service - a depth-of-adoption signal.

**`Multi-Service Users`** · *CreditsWeekly*  
Users touching more than one service. Multi-service users are typically far stickier than single-service ones.

**`New Users (Week)`** · *CreditsWeekly*  
Users appearing for the very first time in the week in context.

**`WoW Retention %`** · *CreditsWeekly*  
Share of last week's active users who were also active this week.

---

## Allowance

**`Credits Over Policy Allowance`** · *CoworkBilling*  
Credits that would be refused because a policy reached its monthly spending limit. Users on that policy lose access to agents until credits reset on the 1st. Measured over the current billing period, because the configured limit is monthly.

**`Person Allowance`** · *CoworkBilling*  
Adds up each person's own monthly credit limit. This is a governance cap, not capacity anyone paid for - going over it is a policy event, not a bill. Shown as "User limits". Do not confuse with Policy Allowance, which adds up the limits on spending policies instead and gives a different number.

**`Person Allowance Used %`** · *CoworkBilling*  
Credits used as a share of the sum of people's own monthly limits. Over 100% means people collectively used more than their personal caps allowed. Shown as "Used vs user limits".

**`Person Headroom`** · *CoworkBilling*  
Credits still available before people hit their own monthly limits. Governance headroom, not money already spent.

**`Policies Over Allowance`** · *CoworkBilling*  
Spending policies whose current-period consumption has passed their configured monthly limit. Users on these policies lose agent access until the 1st of next month.

**`Policy Allowance`** · *CoworkBilling*  
Adds up the plan limits on the spending policies. A separate governance layer from Person Allowance - policies cap a group, user limits cap a person, and the two totals differ. Shown as "Policy limits".

**`Policy Allowance Used %`** · *CoworkBilling*  
Credits used as a share of the spending policy limits. Over 100% means consumption exceeded what the policies allow. Shown as "Used vs policy limits" - a different denominator from Person Allowance Used %.

**`Policy Headroom`** · *CoworkBilling*  
Credits still available before consumption exceeds the spending policy limits. Shown as "Credits left".

---

## Cost

**`Billing Basis`** · *CoworkBilling*  
How this period is actually billed. Derived from the prepaid balance against consumption, so it never has to be declared.

**`Blended Rate $`** · *CoworkBilling*  
The price actually paid per credit across both rates. Equals the pay-as-you-go rate when no prep aid balance is held.

**`Cowork PAYG Cost`** · *CoworkBilling*  
What the pay-as-you-go portion cost, after any prepaid balance was used up.

**`Cowork PAYG Credits`** · *CoworkBilling*  
Consumption billed at the pay-as-you-go rate, once prepaid is exhausted.

**`Cowork PAYG Share of Cost %`** · *CoworkBilling*  
Share of spend still going through pay-as-you-go. A high share means a Capacity Pack would likely reduce the bill.

**`Cowork Prepaid Balance`** · *CoworkBilling*  
Prepaid Capacity Pack credits available to draw down. Sourced from the Capacity Pack Balance input, because no Viva export carries the balance - it lives in admin centre under Cost management > Billing method. Automatically zero under pay-as-you-go only, where no packs are in play. Prepaid Capacity Pack credits available to draw down. Enter the balance shown in admin centre un der Cost management. Zero means everything bills pay-as-you-go.

**`Cowork Prepaid Cost`** · *CoworkBilling*  
What the prepaid draw-down cost. Zero when no Capacity Pack balance is held.

**`Cowork Prepaid Left`** · *CoworkBilling*  
Prepaid credits still unused. Money already spent that is not yet working.

**`Cowork Prepaid Used`** · *CoworkBilling*  
Consumption drawn from the prepaid balance. Prepaid is always consumed before pay-as-you-go.

**`Cowork Total Cost`** · *CoworkBilling*  
Consumption that falls inside the prepaid commitment. What the period actually costs: prepaid credits at the prepaid rate, the rest at the pay-as-you- go rate.

**`Seat Saving Basis Note`** · *CoworkBilling*  
States the basis used to price the right-sizing opportunity, so the number on the page is never read as a cash refund.

---

## Counts

**`Avg Weekly Active Users`** · *CoworkBilling*  
Average number of people active each week across the selected Cowork period. Uses the same window and seat scoping as Consuming Users, so it can never exceed it. Weekly Active Users counts anyone active in any loaded week when no week is in context, which is why it is not used on a card.

**`Consuming Users`** · *CoworkBilling*  
People who consumed the selected service in the selected period. Differs from User Count, which counts everyone holding a seat whether they used it or not.

**`User Count`** · *CoworkBilling*  
Distinct people holding a seat.

---

## Credits

**`Cowork Total Credits Used`** · *CoworkBilling*  
Credits consumed in the selected period, defaulting to the current billing period.

---

## Optimisation

**`Action Meaning`** · *CoworkBilling*  
What acting on this recommendation actually means, in one short phrase. Sits beside the number so a reader never has to infer the action from the bucket name.

**`Action Value /mo`** · *CoworkBilling*  
Monthly value of acting on the recommendation, and nothing else. Right-Size Net $ is generic headroom arithmetic: it subtracts one column from another for whoever is in scope, so slicing it by action returned that group's unused headroom rather than the value of doing what the row says. That is why 'Correctly sized' showed a $5,739 saving and 'Hold' showed $620. Here only the actionable buckets carry a number: 1 reclaim -> the whole seat is released 2 review -> the whole seat, if the check confirms it 3 downsize -> the oversized portion is released 6 upgrade -> negative, because funding those people costs money 4 hold / 5 monitor / 7 correctly sized -> nothing, by definition

**`Actioned Seats`** · *CoworkBilling*  
Seats with a recommendation that carries a monthly value: reclaim, review, downsize or upgrade (actions 1, 2, 3 and 6). The seat count behind Right-Size Net $.

**`Additional Credits Needed`** · *CoworkBilling*  
Capacity required to properly fund users who persistently exceed their current seat.

**`Dormant Seat $`** · *CoworkBilling*  
Value of dormant capacity. Only a real saving under prepaid or hybrid - see Seat Saving Basis Note.

**`Dormant Seat Credits`** · *CoworkBilling*  
Assigned capacity tied up in seats that were never used this period.

**`Dormant Seats`** · *CoworkBilling*  
Seats with no consumption at all in the four-week billing snapshot. Not proof the seat is unused - it is one period, and the Period control does not reach this figure. Treat it as a list to check, not a list to cancel.

**`Licensed but Inactive`** · *CoworkBilling*  
Licensed people with no consumption in the four-week billing snapshot - a licence-management question rather than a capacity one. Not "never used": someone idle this period may have used Cowork earlier. Seat Action's "1. Reclaim - never used" is the never-used count.

**`Oversized Seats`** · *CoworkBilling*  
Seats recommended to downsize (action 3).

**`Oversized Seats $`** · *CoworkBilling*  
Monthly value released by downsizing oversized seats ("3. Downsize"): only the portion above the recommended limit. The same branch as Action Value /mo.

**`Reclaimable $`** · *CoworkBilling*  
Value of reclaimable capacity. Only a real saving under prepaid or hybrid - see Seat Saving Basis Note.

**`Reclaimable Credits`** · *CoworkBilling*  
Credits released if every oversized seat were resized to its 90th-percentile week. Excludes seats that need upgrading.

**`Right-Size Net $`** · *CoworkBilling*  
Value released each month by acting on every recommendation: reclaims and downsizes, less the cost of the upgrades. Positive is a net saving. Equals Unused Seats $ + Oversized Seats $ + Upgrade Seats $. Prefer it to Reclaimable $, which resizes every seat and is not scoped to the recommendation.

**`Seats to Downsize`** · *CoworkBilling*  
Active users whose seat materially exceeds what they consume.

**`Seats to Upgrade`** · *CoworkBilling*  
People persistently exceeding their seat, who are genuinely under-provisioned rather than merely spiky.

**`Unused Seats`** · *CoworkBilling*  
Seats recommended to reclaim or review (actions 1 and 2).

**`Unused Seats $`** · *CoworkBilling*  
Monthly value of the seats nobody is using: "1. Reclaim - never used" and "2. Review - no usage in billing period", each at its full limit. The same branches as Action Value /mo, so it ties to the Financial impact table.

**`Upgrade Seats`** · *CoworkBilling*  
Seats recommended to upgrade (action 6).

**`Upgrade Seats $`** · *CoworkBilling*  
Monthly cost of upgrading people who are persistently over their seat ("6. Upgrade - persistently over"). Negative, because it is spend rather than a saving. The same branch as Action Value /mo.

The Optimisation KPI row shows these three and Right-Size Net $ as four tiles, each with its seat count. Unused + Oversized + Upgrades = Net saving, the same total as the Financial impact by action table. Reclaimable $, Dormant Seat $, Seats to Upgrade, Seats to Downsize and Licensed but Inactive stay in the model but are no longer on the page: none of them matched a recommended action.

---

## Plain English

**`Cowork Concentration Summary`** · *CreditsWeekly*  
Plain-language reading of how concentrated consumption is, phrased the way a business reader would say it out loud.

**`Cowork Forecast Confidence`** · *CreditsWeekly*  
Hashed Viva person identifier. Use for distinct-person counts where UPN is unavailable. Forecast reliability expressed as a word rather than a coefficient. Combines how closely history follows a steady pattern with how accurate the model proved when tested against weeks it had never seen.

**`Cowork Forecast Confidence Note`** · *CreditsWeekly*  
What the confidence rating means for planning, in plain words.

**`Growth Summary`** · *CreditsWeekly*  
Weekly growth restated as a sentence fragment usable in a card subtitle.

**`Steadiness`** · *CreditsWeekly*  
Steadiness expressed in words, for readers who should not have to know what a coefficient of variation is.

---

## Risk

**`Anomaly Flag`** · *CreditsWeekly*  
Marks weeks that fall far outside the normal pattern and are worth investigating. Shown on the page as 'Unusual week'.

**`Consumption Gini`** · *CoworkBilling*  
Gini coefficient of credit consumption. 0 = perfectly even, 1 = one person consumes everything.

**`Cowork Top 10% Share`** · *CoworkBilling*  
Share of credits consumed by the heaviest 10% of users. High values mean the run-rate depends on a handful of people.

**`Credits per Session`** · *CoworkBilling*  
Average credits consumed per session - a session-intensity signal.

**`Top 1% Share`** · *CoworkBilling*  
Share of credits consumed by the heaviest 1% of users - a key-person dependency signal.

**`Ungoverned $`** · *CreditsWeekly*  
Spend recorded against no spending policy - usage that fell outside any policy window. A governance gap to close.

**`Ungoverned %`** · *CreditsWeekly*  
Share of credits falling outside policy control.

**`Ungoverned Credits`** · *CreditsWeekly*  
Credits recorded against the all-zero policy GUID — usage that fell outside any spending policy window. A governance gap.

**`Volatility (CV)`** · *CreditsWeekly*  
Weekly coefficient of variation. High = unpredictable spend needing a budget buffer. Low = safe to commit capacity against.

**`Z-Score (Week)`** · *CreditsWeekly*  
How far the week in context sits from that group's own mean, in standard deviations. Feeds the anomaly tripwire.

---

## Trend

**`Cowork Weekly Cost`** · *CreditsWeekly*  
What each week actually cost. Cowork Total Cost deliberately strips week context so it can honour the Period slicer, which makes it flat on a date axis. This reads the weekly grain instead, so it can be trended. Prepaid capacity is drawn down oldest week first, so a week only bills at the pay-as-you-go rate once the pack is exhausted. With no pack balance entered it reduces to credits x the pay-as-you-go rate.

**`Cowork Weekly PAYG Cost`** · *CreditsWeekly*  
The pay-as-you-go portion of a week's cost - what the prepaid pack did not cover. Stacks with Cowork Weekly Prepaid Cost to give Cowork Weekly Cost. With no pack balance entered this is the whole weekly cost, which is the correct answer for a pay-as-you-go tenant.

**`Cowork Weekly Prepaid Cost`** · *CreditsWeekly*  
The prepaid portion of a week's cost. Cowork Prepaid Cost is a period total - it strips week context so it can honour the Period slicer - so it renders flat on a weekly axis and cannot be stacked. This reads the weekly grain instead. The pack is drawn down oldest week first, so early weeks are prepaid and later weeks fall through to pay-as-you-go once it is exhausted.

**`Credits 4wk Rolling Avg`** · *CreditsWeekly*  
Average weekly credits over this week and the three before it - a smoothing line that removes single-week noise. Early weeks divide by however many weeks actually exist, so the line is not artificially deflated at the start of the series.

**`Weekly Active Users`** · *CreditsWeekly*  
Distinct people who consumed credits during the week.

**`Weekly Credits`** · *CreditsWeekly*  
Total credits consumed in the week under the current filters.

**`Weekly Credits WoW %`** · *CreditsWeekly*  
Week-over-week change in credit consumption.

---

## On reading these

A few conventions worth knowing:

- **Period-scoped measures render flat on a date axis by design.** Measures like
  `Cowork Total Cost` deliberately clear the week filter so they honour the Period slicer.
  For a trend, use the weekly-grain equivalent — `Cowork Weekly Prepaid Cost` and friends.
- **Share measures clear every grouping table.** A `% of total` that did not would read 100%
  on every row the moment you grouped by department.
- **Narrative measures return prose, not numbers.** They branch on the data and are safe to
  put on a card. None of them contains a hardcoded figure, date or judgement.

---

## Azure AI Foundry

All Foundry figures respect the **Period** control on that page (7 / 30 / 90 days, or everything
loaded). The gate sits on the base measures, so everything derived from them inherits it.

| Measure | What it is |
|---|---|
| `Foundry Cost` | Spend filtered to the exact service name `Foundry Models`; not all AI services or whole-solution Azure spend. |
| `Foundry Input Cost` / `Foundry Output Cost` | Split by token direction, parsed from the meter name |
| `Foundry Output Cost Share %` | Output tokens cost several times input, so a rising share explains a rising bill that token counts alone would not |
| `Foundry Tokens (M)` | Sums billing `UsageQuantity` without conversion. Only means millions of tokens when every selected quantity uses that unit; not valid for provisioned hours or mixed units. |
| `Foundry Cost per 1M Tokens` | Cost divided by that billing quantity. Only a per-million-token rate for a compatible token-meter selection in one currency. |
| `Foundry Days Observed` | Days with spend inside the selected window |
| `Foundry Daily Run Rate` / `Foundry Cost /mo` | Run rate, and that rate over 30 days |
| `Foundry Billing Period` | The dates the page currently covers |

**Tokens and provisioned capacity**

| Measure | What it is |
|---|---|
| `Prompt Tokens` / `Generated Tokens` / `Total Tokens` | Input/output families from Monitor; total adds the two and does not read the standalone `TotalTokens` metric. Supply one current/legacy alias per measurement, not both. |
| `AI Requests` / `Tokens per Request` | Volume, and average size per call |
| `PTU Utilisation %` | Mean utilisation of provisioned throughput. **AVERAGE, not SUM** — summing a percentage across days produces a number in the thousands that looks like a catastrophe. |
| `PTU Verdict` | Plain-English reading. Below 30% means capacity is largely idle. |

**Studio reconciliation**

| Measure | What it is |
|---|---|
| `Studio PAYG Billed (Azure)` | Azure-recorded Copilot Studio PAYG cost; subject to billing latency and adjustments, not a final invoice. |
| `Studio PAYG Credits (Azure)` | The same, as credits |
| `Studio Rate Implied by Azure` | Recorded cost divided by quantity. Compare like-for-like dates, scope, currency and units; differences may reflect timing, discounts or scope as well as a parameter. |

The shipped model does not convert currencies or normalize billing units. See
[Azure automation limitations](DATA-SOURCES.md#important-limits-of-the-shipped-azure-page)
before using automated feeds for chargeback.
