//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { isGroupRow } from "@/lib/rollup-tree";
import { toDataTable } from "@/lib/to-data-table";
import {
    chargeback,
    CHARGEBACK_LABEL_COLUMN,
    NO_POLICY,
    NOT_ASSIGNED,
    readsCommercialTerms,
    summariseChargeback,
    toChargebackTree,
    withCommercialTerms,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import rows from "./__fixtures__/chargeback.rows.json";

const columns = liveColumns.chargeback;

function table(source: Record<string, unknown>[], by: "costCentre" | "department" = "costCentre") {
    return toDataTable(
        { columns: columns.map((name) => ({ name })), rows: source.map((row) => columns.map((name) => row[name])) } as never,
        chargeback(by).columnMetadata,
    );
}

describe("chargeback query", () => {
    it("prices its allocation with its own measures, so the rates typed in the app reach it", () => {
        const { query } = chargeback();
        expect(readsCommercialTerms(query)).toBe(true);
        const priced = withCommercialTerms(query, { creditRate: 0.02, prepaidCreditRate: 0.009, prepaidCreditBalance: 5000 });
        expect(priced).toContain("MEASURE 'Settings'[Cowork PAYG Rate Value] = 0.02");
        expect(priced).toContain("MEASURE 'Settings'[Cowork Prepaid Rate Value] = 0.009");
        // The pack balance reaches the prepaid share through the model's own measure.
        expect(priced).toContain("MEASURE 'CoworkBilling'[Cowork Prepaid Balance] =");
    });

    it("shares the capacity pack across the whole tenant, whatever the policy, org or group", () => {
        const { query } = chargeback();
        const share = query.slice(query.indexOf("[Chargeback Prepaid Share %] ="), query.indexOf("[Allocated Credits] ="));
        for (const table of ["SpendingPolicy", "Org", "Group By", "CoworkBilling"]) {
            expect(share).toContain(`REMOVEFILTERS('${table}')`);
        }
        expect(share).toContain("MIN(Used, [Cowork Prepaid Balance])");
    });

    it("swaps cost centre and department for the department lens", () => {
        const byCentre = chargeback("costCentre").query;
        const byDepartment = chargeback("department").query;
        const groupOf = (query: string) => /ROLLUPADDISSUBTOTAL\(\s*'SpendingPolicy'\[(\w+)\]/.exec(query)?.[1];
        expect(groupOf(byCentre)).toBe("CostCentre");
        expect(groupOf(byDepartment)).toBe("Department");
        const swap = (query: string) =>
            query.replace(/'SpendingPolicy'\[(CostCentre|Department)\]/g, (_, column: string) =>
                column === "CostCentre" ? "'SpendingPolicy'[Department]" : "'SpendingPolicy'[CostCentre]",
            );
        expect(byDepartment).not.toBe(byCentre);
        expect(swap(byDepartment)).toBe(byCentre);
    });
});

describe("chargeback tree", () => {
    const tree = toChargebackTree(table(rows));

    it("lists cost centres largest first, then unassigned and policy-less cost, each holding its policies", () => {
        expect(tree.rows.map((row) => row[CHARGEBACK_LABEL_COLUMN])).toEqual(["CC-100", NOT_ASSIGNED, NO_POLICY]);
        expect(tree.rows.every(isGroupRow)).toBe(true);
        const [centre, unassigned, none] = tree.rows.map((row) => (row._children ?? []) as Record<string, unknown>[]);
        expect(centre.map((row) => row[CHARGEBACK_LABEL_COLUMN])).toEqual(["Finance analysts", "Finance leads"]);
        expect(centre.map((row) => [row.Other, row["Billing Owner"], row["Charge Code"]])).toEqual([
            ["Finance", "finance-ops@contoso.com", "FIN-7"],
            ["Finance", "finance-ops@contoso.com", "FIN-8"],
        ]);
        expect(unassigned.map((row) => row[CHARGEBACK_LABEL_COLUMN])).toEqual(["Policy a1b2c3d4"]);
        expect(none.map((row) => row[CHARGEBACK_LABEL_COLUMN])).toEqual([NO_POLICY]);
    });

    it("gives every row its share of the total cost", () => {
        expect(tree.total?.Share).toBe(1);
        const shares = (source: Record<string, unknown>[]) => source.map((row) => Math.round(Number(row.Share) * 1000) / 1000);
        expect(shares(tree.rows)).toEqual([0.6, 0.3, 0.1]);
        expect(shares((tree.rows[0]._children ?? []) as Record<string, unknown>[])).toEqual([0.4, 0.2]);
    });

    it("groups by department and shows the cost centre beside each policy on the department lens", () => {
        const swapped = rows.map((row) => ({
            ...row,
            "SpendingPolicy[CostCentre]": row["SpendingPolicy[Department]"] && `CC of ${row["SpendingPolicy[Department]"]}`,
            "SpendingPolicy[Department]": row["SpendingPolicy[CostCentre]"],
        }));
        const departments = toChargebackTree(table(swapped, "department"), "department");
        expect(departments.rows[0][CHARGEBACK_LABEL_COLUMN]).toBe("CC-100");
        const first = (departments.rows[0]._children ?? [])[0] as Record<string, unknown>;
        expect(first.Other).toBe("CC of Finance");
    });

    it("sums the headline from the same rows, counting only those who can be charged", () => {
        expect(summariseChargeback(tree)).toEqual({
            cost: 9,
            prepaidCost: 4,
            paygCost: 5,
            credits: 1000,
            prepaidShare: 0.5,
            charged: 1,
            unassignedShare: (2.7 + 0.9) / 9,
            noBillingColumns: false,
        });
    });

    it("notices a policy file with no billing columns yet", () => {
        const bare = rows.filter((row) => row["SpendingPolicy[CostCentre]"] !== "CC-100");
        expect(summariseChargeback(toChargebackTree(table(bare)))?.noBillingColumns).toBe(true);
        expect(summariseChargeback(toChargebackTree(table([])))).toBeUndefined();
    });
});
