let
    // Provisional ValueLens Cowork bands. Edit minutes here, not task observations.
    Assumptions = #table(type table [TaskCategory=text, Conservative=number, Typical=number, Optimistic=number], {
        {"Analysis & research", 30, 67, 92},
        {"Document & content creation", 12, 24, 42},
        {"Email workflows", 3, 7, 12},
        {"Meeting workflows", 12, 31, 43},
        {"Communication workflows", 2, 4, 11},
        {"Specialized workflows", 10, 25, 40},
        {"Write or debug code", 30, 56, 96},
        {"General assistance / Other", 2, 5, 8}
    }),
    Keyed = Table.AddColumn(Assumptions, "CategoryKey", each Text.Lower(Text.Trim([TaskCategory])), type text),
    Invalid = Table.SelectRows(Keyed, each [CategoryKey] = "" or
        List.NonNullCount({[Conservative], [Typical], [Optimistic]}) <> 3 or
        not List.AllTrue(List.Transform({[Conservative], [Typical], [Optimistic]},
            (n) => not Number.IsNaN(n) and n <> #infinity and n <> -#infinity and n >= 0)) or
        [Conservative] > [Typical] or [Typical] > [Optimistic]),
    Checked = if not Table.IsEmpty(Invalid) or
        Table.RowCount(Table.Distinct(Keyed, {"CategoryKey"})) <> Table.RowCount(Keyed)
        then error Error.Record("CoworkTasks.InvalidAssumptions",
            "Use unique category names and finite nonnegative minutes ordered Conservative <= Typical <= Optimistic.", null)
        else Keyed,
    Observed = Table.Distinct(Table.SelectColumns(CoworkTaskData, {"CategoryKey", "TaskCategory"}), {"CategoryKey"}),
    Unmapped = Table.SelectRows(Observed, each not List.Contains(Checked[CategoryKey], [CategoryKey])),
    Result = Table.Combine({Checked, Unmapped})
in
    Result
