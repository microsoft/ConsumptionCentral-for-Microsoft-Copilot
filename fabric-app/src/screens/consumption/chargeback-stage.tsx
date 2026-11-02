//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { ChoiceMenu } from "@/components/choice-menu";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { NotFilteredHint } from "@/components/not-filtered-hint";
import { ModelUpdateRequired, QueryError, QueryLoading } from "@/components/query-states";
import { NoteCard, RollupGrid, type TreeColumn } from "@/components/report-panels";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useModelRequirementState } from "@/hooks/use-model-requirements";
import { formatKpi } from "@/lib/format-kpi";
import { formatPeriod } from "@/lib/format-period";
import { formatCell } from "@/lib/tree-grid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import {
    chargeback,
    CHARGEBACK_LABEL_COLUMN,
    coworkPeriodFilter,
    groupByFilter,
    serviceFilter,
    serviceLabel,
    summariseChargeback,
    toChargebackTree,
    type ChargeTo,
    type ConsumptionOptions,
} from "@/queries/consumption";
import { CREDIT_CURRENCY, moneyCell, SMALL, useConsumptionTable } from "./data";

const STAGE = "chargeback";
const TITLE = "Chargeback";
const DESCRIPTION = "What each cost centre or department owes for Cowork and Work IQ credits, from the spending policy file.";
const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-5";
const money = moneyCell(CREDIT_CURRENCY);

const CHARGE_TO: readonly { id: ChargeTo; label: string }[] = [
    { id: "costCentre", label: "Cost centre" },
    { id: "department", label: "Department" },
];

const NOUN: Record<ChargeTo, { one: string; label: string; many: string; other: string }> = {
    costCentre: { one: "cost centre", label: "Cost centre", many: "Cost centres", other: "Department" },
    department: { one: "department", label: "Department", many: "Departments", other: "Cost centre" },
};

function columns(by: ChargeTo): readonly TreeColumn[] {
    return [
        { id: "Other", header: NOUN[by].other, width: 140 },
        { id: "Billing Owner", header: "Billing owner", width: 140 },
        { id: "Charge Code", header: "Charge code", width: 116 },
        { id: "Credits", header: "Credits", width: 104, format: formatCell("whole") },
        { id: "Prepaid Cost", header: "Prepaid", width: 108, format: money },
        { id: "PAYG Cost", header: "Pay-as-you-go", width: 132, format: money },
        { id: "Cost", header: "Total cost", width: 116, format: money, heat: true },
        { id: "Share", header: "Share", width: 88, format: formatCell("percent") },
    ];
}

interface ChargebackStageProps {
    options: ConsumptionOptions | undefined;
    rates: string | undefined;
}

/**
 * The report's Chargeback page: Cowork's cost charged to the cost centre or
 * department on each person's spending policy. Models from before the
 * billing columns get the update notice instead of an engine error.
 */
export function ChargebackStage({ options, rates }: ChargebackStageProps) {
    const requirements = useModelRequirementState("chargeback");
    if (requirements.status === "outdated" || requirements.status === "checking") {
        return (
            <Section id={stageAnchor(STAGE)} title={TITLE} description={DESCRIPTION}>
                {requirements.status === "outdated" ? <ModelUpdateRequired missing={requirements.missing} /> : <QueryLoading />}
            </Section>
        );
    }
    return <ChargebackContent options={options} rates={rates} />;
}

function ChargebackContent({ options, rates }: ChargebackStageProps) {
    const [by, setBy] = useState<ChargeTo>("costCentre");
    const [period, setPeriod] = useState<string>();
    const [service, setService] = useState<string>();

    const periods = options?.coworkPeriods ?? [];
    const services = useMemo(
        () => (options?.services ?? []).map((value) => ({ value, label: serviceLabel(value) })),
        [options?.services],
    );
    const extra = useMemo(
        () => [
            groupByFilter(undefined),
            ...(period ? [coworkPeriodFilter(period)] : []),
            ...(service ? [serviceFilter(service)] : []),
        ],
        [period, service],
    );

    const result = useConsumptionTable(chargeback(by), extra);
    const toTree = useCallback((table: DataTable) => toChargebackTree(table, by), [by]);
    const summary = useMemo(() => (result.table ? summariseChargeback(toTree(result.table)) : undefined), [result.table, toTree]);
    const noun = NOUN[by];
    const percent = (value: number | undefined) => (value === undefined ? undefined : formatKpi(value, "percent"));

    return (
        <Section
            id={stageAnchor(STAGE)}
            title={TITLE}
            description={DESCRIPTION}
            actions={
                <div className="flex flex-wrap items-center gap-200">
                    {periods.length > 0 && (
                        <ChoiceMenu
                            label="Period"
                            allLabel={formatPeriod(periods[0])}
                            choices={periods.slice(1).map((value) => ({ value, label: formatPeriod(value) }))}
                            value={period}
                            onChange={setPeriod}
                        />
                    )}
                    {services.length > 1 && (
                        <ChoiceMenu label="Service" allLabel="Cowork and Work IQ" choices={services} value={service} onChange={setService} />
                    )}
                    <SegmentedControl label="Charge to" options={CHARGE_TO} value={by} onChange={setBy} />
                </div>
            }
        >
            <NotFilteredHint from={[result.notFilteredBy]} />
            {result.error !== undefined ? (
                <QueryError message={result.error} onRetry={result.refetch} />
            ) : !summary ? (
                result.table ? null : (
                    <div className={KPI_GRID}>
                        {Array.from({ length: 5 }, (_, index) => (
                            <QueryLoading key={index} />
                        ))}
                    </div>
                )
            ) : (
                <div className={KPI_GRID} data-export="">
                    <KpiCard
                        label="Total chargeback"
                        value={summary.cost}
                        format="money"
                        prefix={CREDIT_CURRENCY}
                        emphasis
                        detail={
                            <div className="flex flex-col gap-100">
                                <KpiStat label="Prepaid" value={summary.prepaidCost} format="money" prefix={CREDIT_CURRENCY} />
                                <KpiStat label="Pay-as-you-go" value={summary.paygCost} format="money" prefix={CREDIT_CURRENCY} />
                            </div>
                        }
                    />
                    <KpiCard label="Credits charged" value={summary.credits} />
                    <KpiCard
                        label="Prepaid share"
                        value={summary.prepaidShare}
                        format="percent"
                        detail="Of the tenant's credits, from the capacity pack"
                    />
                    <KpiCard label={`${noun.many} charged`} value={summary.charged} />
                    <KpiCard
                        label="Not assigned"
                        value={summary.unassignedShare}
                        format="percent"
                        detail={`Of the cost, with no ${noun.one} or no policy`}
                    />
                </div>
            )}

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <RollupGrid
                    result={result}
                    toTree={toTree}
                    labelColumn={CHARGEBACK_LABEL_COLUMN}
                    labelHeader={`${noun.label} / policy`}
                    labelWidth={232}
                    columns={columns(by)}
                    variant={by}
                    title={`Cost by ${noun.one}`}
                    subtitle={`Each ${noun.one}, largest first, then the spending policies charged to it`}
                    emptyTitle="Nothing to charge"
                    emptyDescription="No one in this period and service used Cowork or Work IQ credits."
                />
                <NoteCard
                    title="How the cost is split"
                    notes={[
                        {
                            term: "Who is charged",
                            text: `Each person's credits go to the ${noun.one} on their current spending policy.`,
                        },
                        {
                            term: "Prepaid",
                            text: `The capacity pack is shared across the tenant: ${percent(summary?.prepaidShare) ?? "a share"} of every line's credits is charged at the prepaid rate.`,
                        },
                        { term: "Pay-as-you-go", text: "The rest of each line's credits, at the pay-as-you-go rate." },
                        { term: "Rates in use", text: rates },
                    ]}
                >
                    {summary?.noBillingColumns && (
                        <p className={`${SMALL} border-t border-border px-500 py-300 text-muted-foreground`}>
                            <span className="font-semibold text-foreground">No billing columns yet. </span>
                            Add CostCentre, Department, BillingOwner and ChargeCode to the spending policy file, then run
                            the loads again. A fresh Viva export does not have them, so add them back after each one.
                        </p>
                    )}
                </NoteCard>
            </div>
        </Section>
    );
}
