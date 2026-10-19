let
    Check = (name as text, passed as logical) =>
        if passed then {name, true} else error Error.Record("CoworkTasks.RegressionFailed", name, null),
    File = (name as text, folder as text, depth as number, modified as date, contents as text) =>
        {name, folder, depth, modified, Text.ToBinary(contents)},
    Metadata = {
        File("peoplemetadata.csv", "root\people\", 1, #date(2026,9,6), "shallow"),
        File("peoplemetadata.csv", "root\people\", 1, #date(2026,9,13), "newest"),
        File("peoplemetadata.csv", "root\old\people\", 2, #date(2026,9,20), "deep")
    },
    Metrics = File("personservicecreditsmetrics.csv", "root\legacy\", 1, #date(2026,9,6), "metrics"),
    Task = File("coworkweeklymetrics.csv", "root\tasks\", 1, #date(2026,9,6), "tasks"),
    Rows = (rows as list) => #table({"MatchKey", "Folder Path", "Depth", "Date modified", "Content"}, rows),
    Lookup = (rows as list) => Text.FromBinary(ReadLegacy(Rows(rows))({"peoplemetadata"})),
    TaskRows = #table({"PersonId", "PeopleHistoricalId", "MetricDate", "TaskCount", "Organization", "FunctionType"}, {
        {"synthetic-a", "history-a", "2026-09-12", 2, "Example Division", "Research"},
        {"synthetic-a", "history-a", "2026-09-13", 3, "EXAMPLE DIVISION", "RESEARCH"}
    }),
    Data = CoworkTaskNormalize(TaskRows, null),
    People = ReadPeople(Data),
    Dates = ReadDates(Data),
    Period = ReadPeriod(Data),
    Span = Table.SelectRows(Period, each [Period] = "All history"){0}[Weeks],
    AllHistory = Table.SelectRows(Dates, each [WeeksAgo] < Span),
    Tests = {
        Check("legacy: relocated metadata keeps shallowest/newest selection", Lookup(Metadata & {Metrics}) = "newest"),
        Check("legacy: standalone metadata needs no metrics file", Lookup(Metadata) = "newest"),
        Check("legacy: tasks keep companion folders isolated", Lookup(Metadata & {Metrics, Task,
            File("peoplemetadata.csv", "root\legacy\", 1, #date(2026,9,1), "legacy"),
            File("peoplemetadata.csv", "root\tasks\", 1, #date(2026,9,20), "task")}) = "legacy"),
        Check("model: case-only attributes produce one dimension row", Table.RowCount(People) = 1),
        Check("model: every task retains a matching people key", List.AllTrue(List.Transform(Data[PeopleKey], each List.Contains(People[PeopleKey], _)))),
        Check("model: mixed weekdays span both Sunday weeks", Span = 2),
        Check("model: all history retains every input date", List.AllTrue(List.Transform(Data[MetricDate], each List.Contains(AllHistory[Date], _)))),
        Check("model: week starts are present in the calendar", List.Contains(Dates[Date], #date(2026,9,6)) and List.Contains(Dates[Date], #date(2026,9,13))),
        Check("model: no dates has an empty calendar", Table.IsEmpty(ReadDates(Table.FirstN(Data, 0)))),
        Check("model: empty all-history span is zero", ReadPeriod(Table.FirstN(Data, 0)){0}[Weeks] = 0),
        Check("file: permission failure is visible without blocking refresh", Denied[SourceUnavailable] and not Denied[Supplied] and Denied[Data] = null)
    }
in
    #table(type table [Case=text, Passed=logical], Tests)
