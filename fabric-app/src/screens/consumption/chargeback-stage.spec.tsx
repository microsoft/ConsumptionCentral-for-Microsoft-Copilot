//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pageStages, StageFilterContext } from "@/hooks/stage-filter.context";
import type { RequirementProbeState } from "@/lib/model-requirements";
import { chargeback } from "@/queries/consumption";
import { ChargebackStage } from "./chargeback-stage";

const mocked = vi.hoisted(() => ({
    asked: [] as string[],
    requirements: { status: "ok" } as RequirementProbeState,
}));

vi.mock("@/hooks/use-model-requirements", () => ({
    useModelRequirementState: () => mocked.requirements,
}));

vi.mock("./data", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./data")>();
    const result = (source: { query: string }) => {
        mocked.asked.push(source.query);
        return { data: undefined, isLoading: true, refetch: () => undefined, row: undefined, notFilteredBy: [] };
    };
    return { ...actual, useConsumptionSummary: result, useConsumptionTable: result };
});

vi.mock("@/components/report-panels", () => ({
    NoteCard: () => null,
    RollupGrid: ({ title }: { title: string }) => <p>{title}</p>,
}));

function renderStage() {
    render(
        <StageFilterContext.Provider value={pageStages("chargeback")}>
            <ChargebackStage options={undefined} rates={undefined} />
        </StageFilterContext.Provider>,
    );
}

describe("ChargebackStage", () => {
    beforeEach(() => {
        mocked.asked.length = 0;
    });

    it("charges cost centres by default", () => {
        mocked.requirements = { status: "ok" };
        renderStage();
        expect(mocked.asked).toContain(chargeback("costCentre").query);
        expect(screen.getByText("Cost by cost centre")).toBeTruthy();
    });

    it("asks for an update instead of querying a model without the billing columns", () => {
        mocked.requirements = { status: "outdated", missing: ["SpendingPolicy[CostCentre]"] };
        renderStage();
        expect(mocked.asked).toEqual([]);
        expect(screen.getByRole("alert").textContent).toContain("SpendingPolicy[CostCentre]");
    });
});
