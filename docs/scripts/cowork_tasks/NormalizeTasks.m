(source as nullable table, people as nullable table) as table =>
let
    Fail = (field as text, problem as text) =>
        error Error.Record("CoworkTasks.InvalidExport", problem, [Column = field]),
    Key = (s as text) => Text.Lower(Text.Select(s, {"a".."z", "A".."Z", "0".."9"})),
    Clean = (v as any) as nullable text =>
        if v = null then null
        else let t = Text.Trim(Text.From(v)) in if t = "" then null else t,
    Identity = (v as any) as nullable text =>
        let t = Clean(v) in if t = null then null else Text.Lower(t),
    Label = (v as any) as text => let t = Clean(v) in if t = null then "Not supplied" else t,
    Bind = (t as table, specs as list) as table =>
        let
            Columns = Table.ColumnNames(t),
            Pick = (spec as list) =>
                let
                    Matches = List.Select(Columns, (c) => List.Contains(List.Transform(spec, Key), Key(c))),
                    Exact = List.Select(Matches, each _ = spec{0})
                in
                    if List.Count(Exact) = 1 then Exact{0}
                    else if List.Count(Matches) > 1 then Fail(spec{0}, "Ambiguous column aliases; keep one source column.")
                    else List.First(Matches, null),
            Bindings = List.Transform(specs, Pick)
        in
            Table.FromColumns(
                List.Transform(Bindings, each if _ = null then List.Repeat({null}, Table.RowCount(t)) else Table.Column(t, _)),
                List.Transform(specs, each _{0})),
    NumberValue = (v as any, field as text, allowMissing as logical) as nullable number =>
        if v = null or (Value.Is(v, type text) and Text.Trim(v) = "") then
            if allowMissing then null else Fail(field, "A required numeric value is missing.")
        else if not (Value.Is(v, type number) or Value.Is(v, type text)) then
            Fail(field, "Expected a numeric value, not a logical, date or structured value.")
        else
            let n = try Number.From(v, "en-US")
            in
                if n[HasError] then Fail(field, "Expected a nonnegative finite number.")
                else if Number.IsNaN(n[Value]) or n[Value] = #infinity or n[Value] = -#infinity or n[Value] < 0
                then Fail(field, "Expected a nonnegative finite number.")
                else n[Value],
    CountValue = (v as any) as number =>
        let n = NumberValue(v, "TaskCount", false)
        in if n <> Number.RoundDown(n) or n > 9007199254740991
           then Fail("TaskCount", "Expected a nonnegative whole task count within the supported integer range.")
           else Int64.From(n),
    DateValue = (v as any) as date =>
        let d = try
            if Value.Is(v, type date) then v
            else if Value.Is(v, type datetime) then Date.From(v)
            else Date.FromText(Text.Trim(Text.From(v)), [Format="yyyy-MM-dd", Culture="en-US"])
        in if d[HasError] or d[Value] = null
           then Fail("MetricDate", "Expected a populated ISO week-start date (yyyy-MM-dd).")
           else d[Value],
    Licence = (v as any) as nullable logical =>
        let t = Identity(v)
        in if t = null then null
           else if List.Contains({"true", "yes", "1"}, t) then true
           else if List.Contains({"false", "no", "0"}, t) then false
           else Fail("IsCopilotLicensed", "Expected true/false, yes/no or 1/0."),
    Specs = {
        {"PersonId", "person_id"},
        {"UserPrincipalName", "user_principal_name", "UPN"},
        {"MetricDate", "metric_date"},
        {"TaskCategory", "task_category"},
        {"TaskType", "task_type"},
        {"CreditsUsed", "credits_used", "Total credits used"},
        {"TaskCount", "task_count", "Total Cowork tasks"},
        {"PeopleHistoricalId", "people_historical_id"},
        {"Organization", "Organisation"},
        {"FunctionType", "function_type"},
        {"IsCopilotLicensed", "is_copilot_licensed"}
    },
    Empty = #table(type table [
        PersonId=text, UserPrincipalName=text, MetricDate=date,
        TaskCategory=text, TaskType=text, CreditsUsed=number, TaskCount=Int64.Type,
        PeopleHistoricalId=text, Organization=text, FunctionType=text, IsCopilotLicensed=logical
    ], {}),
    Raw = if source = null then Empty else Bind(source, Specs),
    Typed = Table.TransformColumns(Raw, {
        {"PersonId", Identity, type text}, {"UserPrincipalName", Identity, type text},
        {"MetricDate", DateValue, type date},
        {"TaskCategory", Label, type text}, {"TaskType", Label, type text},
        {"CreditsUsed", each NumberValue(_, "CreditsUsed", true), type number},
        {"TaskCount", CountValue, Int64.Type},
        {"PeopleHistoricalId", Identity, type text},
        {"Organization", Clean, type text}, {"FunctionType", Clean, type text},
        {"IsCopilotLicensed", Licence, type logical}
    }),
    PersonKey = Table.AddColumn(Typed, "_person", each
        if [PersonId] <> null then [PersonId]
        else if [UserPrincipalName] <> null then [UserPrincipalName]
        else Fail("PersonId", "Each task row needs PersonId or UserPrincipalName."), type text),
    Named = Table.RenameColumns(Table.RemoveColumns(PersonKey, {"PersonId"}), {{"_person", "PersonId"}}),
    MetadataSpecs = {
        {"PeopleHistoricalId", "people_historical_id"},
        {"Organization", "Organisation"},
        {"FunctionType", "function_type"},
        {"IsCopilotLicensed", "is_copilot_licensed"}
    },
    MetadataRaw = if people = null then #table(List.Transform(MetadataSpecs, each _{0}), {})
                  else Bind(people, MetadataSpecs),
    MetadataTyped = Table.TransformColumns(MetadataRaw, {
        {"PeopleHistoricalId", Identity, type text},
        {"Organization", Clean, type text}, {"FunctionType", Clean, type text},
        {"IsCopilotLicensed", Licence, type logical}
    }),
    MetadataRows = Table.Distinct(Table.SelectRows(MetadataTyped, each [PeopleHistoricalId] <> null)),
    MetadataCounts = Table.Group(MetadataRows, {"PeopleHistoricalId"}, {{"Rows", each Table.RowCount(_), Int64.Type}}),
    Metadata = if Table.IsEmpty(Table.SelectRows(MetadataCounts, each [Rows] > 1)) then MetadataRows
               else Fail("PeopleHistoricalId", "Conflicting metadata rows share a historical key; reconcile companion files."),
    Joined = Table.NestedJoin(Named, {"PeopleHistoricalId"}, Metadata, {"PeopleHistoricalId"}, "_metadata", JoinKind.LeftOuter),
    Expanded = Table.ExpandTableColumn(Joined, "_metadata",
        {"Organization", "FunctionType", "IsCopilotLicensed"}, {"_org", "_function", "_licence"}),
    CoalescedOrg = Table.AddColumn(Expanded, "_organization", each if [Organization] <> null then [Organization] else [_org], type text),
    CoalescedFunction = Table.AddColumn(CoalescedOrg, "_functionType", each if [FunctionType] <> null then [FunctionType] else [_function], type text),
    CoalescedLicence = Table.AddColumn(CoalescedFunction, "_isLicensed", each if [IsCopilotLicensed] <> null then [IsCopilotLicensed] else [_licence], type logical),
    Coalesced = Table.RenameColumns(Table.RemoveColumns(CoalescedLicence,
        {"Organization", "FunctionType", "IsCopilotLicensed", "_org", "_function", "_licence"}), {
        {"_organization", "Organization"}, {"_functionType", "FunctionType"}, {"_isLicensed", "IsCopilotLicensed"}
    }),
    CategoryKey = Table.AddColumn(Coalesced, "CategoryKey", each Text.Lower([TaskCategory]), type text),
    TypeKey = Table.AddColumn(CategoryKey, "_typeKey", each Text.Lower([TaskType]), type text),
    DistinctRows = Table.Distinct(TypeKey),
    Counts = Table.Group(DistinctRows, {"PersonId", "MetricDate", "CategoryKey", "_typeKey"},
        {{"Rows", each Table.RowCount(_), Int64.Type}}),
    Unique = if Table.IsEmpty(Table.SelectRows(Counts, each [Rows] > 1)) then DistinctRows
             else Fail("TaskCount", "Conflicting task rows share person, week, category and type; reconcile overlapping exports."),
    PeopleKey = Table.AddColumn(Unique, "PeopleKey", each
        Text.FromBinary(Json.FromValue({[PersonId], [PeopleHistoricalId], [Organization], [FunctionType], [IsCopilotLicensed]})),
        type text),
    Result = Table.RemoveColumns(PeopleKey, {"_typeKey"})
in
    Result
