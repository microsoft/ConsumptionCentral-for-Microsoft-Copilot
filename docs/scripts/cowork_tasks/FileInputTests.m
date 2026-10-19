let
    Read = (name as text) => ReadFixture(FixtureRoot & "\" & name),
    Normalize = (name as text) =>
        let Input = Read(name) in CoworkTaskNormalize(Input[Data], Input[People]),
    Force = (t as table) => List.Sum(List.Transform(Table.ToRows(t), (row) =>
        List.Sum(List.Transform(row, (v) => if v = null then 0 else Text.Length(Text.From(v, "en-US")))))),
    Check = (name as text, passed as logical, optional diagnostic as nullable text) =>
        {name, if passed then true
            else error Error.Record("CoworkTasks.FileRegressionFailed", name, diagnostic)},
    Legacy = Read("legacy-only"),
    Partial = Normalize("partial"),
    TaskOnly = Normalize("task-only"),
    Combined = Normalize("combined"),
    Invalid = try Force(Normalize("malformed")),
    Unavailable = Read("unavailable"),
    Tests = {
        Check("file: absent tasks preserve legacy input", not Legacy[Supplied] and Table.RowCount(Normalize("legacy-only")) = 0),
        Check("file: zero bytes are supplied but empty", Read("zero-byte")[Supplied] and Table.RowCount(Normalize("zero-byte")) = 0),
        Check("file: header only is supplied but empty", Read("header-only")[Supplied] and Table.RowCount(Normalize("header-only")) = 0),
        Check("file: partial optional fields retain null credits", Partial{0}[TaskCount] = 2 and Partial{0}[CreditsUsed] = null and Partial{0}[TaskCategory] = "Not supplied"),
        Check("file: task-only counts and fractional credits", Table.RowCount(TaskOnly) = 7 and List.Sum(TaskOnly[TaskCount]) = 10 and List.Sum(TaskOnly[CreditsUsed]) = 38),
        Check("file: combined input joins task companion", List.Sum(Combined[TaskCount]) = 10 and List.Count(List.Distinct(Combined[Organization])) = 3),
        Check("file: malformed values surface actionable errors", Invalid[HasError] and Invalid[Error][Reason] = "CoworkTasks.InvalidExport"),
        Check("file: unavailable folder reports status without failing refresh",
            Unavailable[SourceUnavailable] and not Unavailable[Supplied] and Unavailable[Data] = null),
        Check("file: blank folder is optional", not ReadFixture("")[SourceUnavailable] and not ReadFixture("")[Supplied])
    }
in
    #table(type table [Case=text, Passed=logical], Tests)
