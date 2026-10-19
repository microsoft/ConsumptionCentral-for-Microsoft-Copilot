let
    Root = if DataFolder = null then "" else Text.Trim(Text.From(DataFolder)),
    Listing = if Root = "" then null else Folder.Files(Root),
    // Folder tables can defer path/access errors until enumeration.
    Attempt = try (if Listing = null then null else Table.RowCount(Listing)),
    // Optional file discovery must not block connector-only Viva refreshes.
    Files = if Attempt[HasError] then null else Listing,
    Candidates = if Files = null then #table({"Content", "Folder Path", "Name", "Date modified", "Depth"}, {})
        else Table.AddColumn(Table.SelectRows(Files, each
            Text.Lower([Extension]) = ".csv" and
            Text.StartsWith(Text.Lower(Text.Remove([Name], {" ", "_", "-"})), "coworkweeklymetrics")),
            "Depth", each List.Count(Text.Split(Text.Replace([#"Folder Path"], "/", "\"), "\")), Int64.Type),
    Ranked = Table.Sort(Candidates, {{"Depth", Order.Ascending}, {"Date modified", Order.Descending}, {"Name", Order.Ascending}}),
    Selected = if Table.IsEmpty(Ranked) then null else Ranked{0},
    Read = (bin as binary) as table =>
        if Binary.Length(bin) = 0 then #table({}, {})
        else Table.PromoteHeaders(Csv.Document(bin,
            [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]), [PromoteAllScalars=true]),
    Companions = if Selected = null then #table({"Content"}, {})
        else Table.SelectRows(Files, each [#"Folder Path"] = Selected[#"Folder Path"]
            and Text.Lower([Name]) = "peoplemetadata.csv"),
    People = if Table.IsEmpty(Companions) then null else Read(Companions{0}[Content]),
    Raw = if Selected = null then null else Read(Selected[Content])
in
    [Data=Raw, People=People, Supplied=Selected <> null, SourceUnavailable=Attempt[HasError]]
