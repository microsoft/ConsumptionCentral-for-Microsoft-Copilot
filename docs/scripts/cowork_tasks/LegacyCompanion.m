(patterns as list) as nullable binary =>
let
    LegacyPatterns = {"personservicecredits", "personm365credits", "m365creditsmetrics", "servicecredits", "creditsmetrics"},
    Ranked = (p as text) => Table.Sort(Table.SelectRows(DataFiles, each Text.Contains([MatchKey], p)),
        {{"Depth", Order.Ascending}, {"Date modified", Order.Descending}}),
    Matches = if DataFiles = null then {} else List.Select(List.Transform(LegacyPatterns, Ranked), each not Table.IsEmpty(_)),
    Metrics = if List.IsEmpty(Matches) then null else Matches{0}{0},
    Companion = if Metrics = null then null else
        Table.SelectRows(DataFiles, each [#"Folder Path"] = Metrics[#"Folder Path"]
            and List.AnyTrue(List.Transform(patterns, (p) => Text.Contains([MatchKey], p)))),
    Result = if Companion = null or Table.IsEmpty(Companion) then null
             else Table.Sort(Companion, {{"Date modified", Order.Descending}}){0}[Content]
in
    Result
