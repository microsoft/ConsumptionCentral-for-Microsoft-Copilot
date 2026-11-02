//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CONSUMPTION_COWORK } from "@/lib/filter-profiles";
import type { Row } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection as connection, FORMAT_CREDITS, FORMAT_MONEY, FORMAT_PERCENT } from "../shared";
import chargebackQuery from "./chargeback.dax?raw";

/** Who the Chargeback stage charges: the cost centre or the department on each spending policy. */
export type ChargeTo = "costCentre" | "department";

/** The model's word for a policy with no cost centre or department in the file. */
export const NOT_ASSIGNED = "(Not assigned)";
/** People whose spending policy is not in the policy file, or who have none. */
export const NO_POLICY = "(No policy)";

/** The grid's first column: the cost centre or department on group rows, the policy on leaf rows. */
export const CHARGEBACK_LABEL_COLUMN = "Charge To";

const COST_CENTRE = "SpendingPolicyCostCentre";
const DEPARTMENT = "SpendingPolicyDepartment";
const POLICY_ID = "SpendingPolicySpendingPolicyId";
const POLICY_NAME = "SpendingPolicyPolicy Name";

/** Columns every row carries. `Other` is the policy's department on the cost-centre lens, and the reverse. */
export const CHARGEBACK_FIELDS = [
    "Other",
    "Billing Owner",
    "Charge Code",
    "Credits",
    "Prepaid Cost",
    "PAYG Cost",
    "Cost",
    "Share",
    "Prepaid Share",
] as const;

const chargebackColumns: ColumnMetadataMap = {
    "SpendingPolicy[CostCentre]": { name: COST_CENTRE, displayName: "Cost centre" },
    "SpendingPolicy[SpendingPolicyId]": { name: POLICY_ID, displayName: "Policy ID" },
    "SpendingPolicy[Policy Name]": { name: POLICY_NAME, displayName: "Policy" },
    "SpendingPolicy[Department]": { name: DEPARTMENT, displayName: "Department" },
    "SpendingPolicy[BillingOwner]": { name: "SpendingPolicyBillingOwner", displayName: "Billing owner" },
    "SpendingPolicy[ChargeCode]": { name: "SpendingPolicyChargeCode", displayName: "Charge code" },
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[Credits]": { name: "Credits", displayName: "Credits", format: FORMAT_CREDITS },
    "[Prepaid Cost]": { name: "Prepaid Cost", displayName: "Prepaid", format: FORMAT_MONEY },
    "[PAYG Cost]": { name: "PAYG Cost", displayName: "Pay-as-you-go", format: FORMAT_MONEY },
    "[Cost]": { name: "Cost", displayName: "Total cost", format: FORMAT_MONEY },
    "[Prepaid Share]": { name: "Prepaid Share", displayName: "Prepaid share", format: FORMAT_PERCENT },
};

const SWAP = /'SpendingPolicy'\[(CostCentre|Department)\]/g;

/**
 * The report's Chargeback page: each cost centre or department, then the
 * spending policies charged to it, with their credits and cost. Prepaid
 * capacity is shared across the tenant pro rata, so the rows add up to
 * Cowork's total cost.
 */
export function chargeback(by: ChargeTo = "costCentre") {
    const query =
        by === "department"
            ? chargebackQuery.replace(SWAP, (_, column: string) =>
                  column === "CostCentre" ? "'SpendingPolicy'[Department]" : "'SpendingPolicy'[CostCentre]",
              )
            : chargebackQuery;
    return { connection, filters: CONSUMPTION_COWORK, query, columnMetadata: chargebackColumns };
}

function named(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function amount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** True for a group nobody can be charged: a policy without the column, or no policy at all. */
export function isUnassigned(label: unknown): boolean {
    return label === NOT_ASSIGNED || label === NO_POLICY;
}

/** Each cost centre or department, largest first, holding the policies charged to it. */
export function toChargebackTree(table: DataTable, by: ChargeTo = "costCentre"): RollupTree {
    const group = by === "department" ? DEPARTMENT : COST_CENTRE;
    const other = by === "department" ? COST_CENTRE : DEPARTMENT;
    const index = new Map(table.columns.map((column, i) => [column.name, i]));
    const pick = (row: readonly unknown[], column: string) => {
        const i = index.get(column);
        return i === undefined ? undefined : row[i];
    };
    // The grid reads every row's columns by the same names on both lenses.
    const renamed: DataTable = {
        ...table,
        columns: [
            ...table.columns,
            { name: "Other" },
            { name: "Billing Owner" },
            { name: "Charge Code" },
            { name: "Share" },
        ] as DataTable["columns"],
        rows: table.rows.map((row) => [
            ...row,
            pick(row, other),
            pick(row, "SpendingPolicyBillingOwner"),
            pick(row, "SpendingPolicyChargeCode"),
            undefined,
        ]),
    };
    const tree = toRollupTree(renamed, {
        group,
        leaf: POLICY_ID,
        leafLabel: (id, cell) => {
            const policy = named(id);
            if (!policy || policy === "00000000-0000-0000-0000-000000000000") return NO_POLICY;
            return named(cell(POLICY_NAME)) ?? `Policy ${policy.slice(0, 8)}`;
        },
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: CHARGEBACK_LABEL_COLUMN,
        fields: CHARGEBACK_FIELDS,
        blankLabel: NO_POLICY,
    });
    const total = amount(tree.total?.Cost);
    const share = (row: Row): Row => ({ ...row, Share: total > 0 ? amount(row.Cost) / total : null });
    return {
        rows: tree.rows.map((row) => {
            const children = row._children as Row[] | undefined;
            return children ? { ...share(row), _children: children.map(share) } : share(row);
        }),
        total: tree.total && share(tree.total),
    };
}

export interface ChargebackSummary {
    cost: number;
    prepaidCost: number;
    paygCost: number;
    credits: number;
    /** Tenant-wide share of credits paid from the capacity pack. */
    prepaidShare: number | undefined;
    /** Cost centres or departments with a charge, not counting the unassigned. */
    charged: number;
    /** Share of the cost nobody can be charged for. */
    unassignedShare: number | undefined;
    /** True when no policy names a cost centre or department, so the file has no billing columns yet. */
    noBillingColumns: boolean;
}

/** The stage's headline figures, from the same rows as the grid. */
export function summariseChargeback(tree: RollupTree): ChargebackSummary | undefined {
    if (!tree.total) return undefined;
    const cost = amount(tree.total.Cost);
    const unassigned = tree.rows
        .filter((row) => isUnassigned(row[CHARGEBACK_LABEL_COLUMN]))
        .reduce((sum, row) => sum + amount(row.Cost), 0);
    const prepaidShare = tree.total["Prepaid Share"];
    return {
        cost,
        prepaidCost: amount(tree.total["Prepaid Cost"]),
        paygCost: amount(tree.total["PAYG Cost"]),
        credits: amount(tree.total.Credits),
        prepaidShare: typeof prepaidShare === "number" ? prepaidShare : undefined,
        charged: tree.rows.filter((row) => !isUnassigned(row[CHARGEBACK_LABEL_COLUMN]) && amount(row.Credits) > 0).length,
        unassignedShare: cost > 0 ? unassigned / cost : undefined,
        noBillingColumns: tree.rows.length > 0 && tree.rows.every((row) => isUnassigned(row[CHARGEBACK_LABEL_COLUMN])),
    };
}
