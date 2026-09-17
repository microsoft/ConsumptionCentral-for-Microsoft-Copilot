let
    Key = (n as text) as text => Text.Lower(Text.Remove(n, {" ", "_", "-"})),
    Clean = (v as any) as nullable text =>
        if v = null then null else let t = Text.Trim(Text.From(v)) in if t = "" then null else t,
    Identity = (v as any) as nullable text =>
        let t = Clean(v) in if t = null then null else Text.Lower(t),
    IdAliases = {
        "userprincipalname", "upn", "userprincipal", "email", "mail",
        "personid", "personidnormalized", "personidnormalised",
        "entraid", "entraobjectid", "objectid", "aadobjectid", "aadid", "aad",
        "peoplehistoricalid", "personhistoricalid", "phid"
    },
    NotOrg = IdAliases & {
        "serviceid", "servicename", "spendingpolicyid", "spendingpolicyname",
        "policyname", "policylimit", "policyservicesincluded", "includedservices",
        "metricdate", "date", "week", "weekstart", "sessioncount",
        "spendingpolicylimit", "totalcopilotcreditsused", "creditsused", "userlimit", "planlimit",
        "iscopilotlicensed", "standardtimezone", "timezone"
    },
    Aliases = {
        {"DisplayName", {"displayname", "name", "fullname", "preferredname"}},
        {"Department", {"department", "dept"}},
        {"Organisation", {"organisation", "organization"}},
        {"JobTitle", {"jobtitle", "title", "role"}},
        {"JobFamily", {"jobfamily", "function", "functiontype", "jobfunction"}},
        {"City", {"city", "officelocation", "location"}},
        {"Country", {"country", "countryorregion", "region"}},
        {"CostCenter", {"costcenter", "costcentre"}},
        {"Manager", {"manager", "managername", "supervisor", "managerid", "managerupn", "manageruserprincipalname"}},
        {"BusinessUnit", {"businessunit", "division", "segment", "companyname", "company"}}
    },
    Canonical = List.Transform(Aliases, each _{0}),
    Expected = {"UserPrincipalName"} & Canonical,
    Known = List.Combine(List.Transform(Aliases, each _{1})),
    ColumnsFor = (columns as list, aliases as list) as list =>
        List.Combine(List.Transform(aliases, (a) => List.Select(columns, each Key(_) = a))),
    Ids = (row as record, columns as list) as list =>
        List.Distinct(List.RemoveNulls(List.Transform(columns, each Identity(Record.Field(row, _))))),
    EmptyEdges = #table(type table [Alias = text, ResolvedKey = text], {}),
    ToEdges = (rows as list) as table =>
        if List.IsEmpty(rows) then EmptyEdges
        else Table.FromRecords(rows, type table [Alias = text, ResolvedKey = text]),
    Index = (edges as table) as record =>
        let
            // Eager list index: table buffering is shallow, so buffer grouped key lists too.
            Grouped = Table.Buffer(Table.Group(edges, {"Alias"}, {
                {"Keys", each List.Buffer(List.Distinct([ResolvedKey])), type list}
            })),
            Keys = List.Buffer(Grouped[Keys]),
            Aliases = List.Buffer(Grouped[Alias])
        in
            Record.FromList(Keys, Aliases),
    Targets = (ids as list, index as record) as list =>
        List.Distinct(List.Combine(List.Transform(ids, each Record.FieldOrDefault(index, _, {})))),

    // Metrics never depend on this crosswalk or the roster. Only org enrichment does.
    RosterIds = Table.Buffer(Table.TransformColumns(
        Table.SelectColumns(VivaSeatRoster, {"PersonId", "userPrincipalName"}), {
            {"PersonId", Identity, type nullable text},
            {"userPrincipalName", Identity, type nullable text}
        })),
    // Use the consumption key even when the roster has no resolved UPN.
    Roster = Table.Buffer(Table.AddColumn(RosterIds, "ResolvedKey",
        each if [userPrincipalName] <> null then [userPrincipalName] else [PersonId],
        type nullable text)),
    MetricIdentityColumns = ColumnsFor(Table.ColumnNames(VivaCreditMetrics), IdAliases),
    MetricIds = Table.SelectColumns(VivaCreditMetrics, MetricIdentityColumns),
    Linked = Table.NestedJoin(MetricIds, {"PersonId"}, Roster, {"PersonId"}, "roster", JoinKind.Inner),
    Resolved = Table.ExpandTableColumn(Linked, "roster", {"ResolvedKey"}, {"ResolvedKey"}),
    BaseRows = List.Buffer(Table.ToRecords(Table.Buffer(Table.Distinct(Resolved)))),
    BaseEdges = Table.Buffer(ToEdges(List.Combine(List.Transform(BaseRows, (row) =>
        let
            Identifiers = Ids(row, MetricIdentityColumns)
        in
            if row[ResolvedKey] = null then {}
            else List.Transform(List.Union({Identifiers, {row[ResolvedKey]}}),
                (id) => [Alias = id, ResolvedKey = row[ResolvedKey]]))))),
    BaseIndex = Index(BaseEdges),

    // Technical inline fields (Domain/PopulationType) do not replace historical HR data.
    Inline = VivaOrgFromMetrics,
    Historical = VivaOrgAttributes,
    VivaSource =
        if Inline = null then Historical
        else if Historical = null then Inline
        else Table.Combine({Inline, Historical}),
    EntraSource = try EntraOrgSource otherwise null,
    SourceEdges = (src as nullable table) as table =>
        if src = null then EmptyEdges
        else
            let
                Columns = ColumnsFor(Table.ColumnNames(src), IdAliases),
                Rows = List.Buffer(Table.ToRecords(Table.Buffer(Table.Distinct(Table.SelectColumns(src, Columns))))),
                Edges = List.Combine(List.Transform(Rows, (row) =>
                    let
                        Identifiers = Ids(row, Columns),
                        Matches = Targets(Identifiers, BaseIndex)
                    in
                        List.Combine(List.Transform(Identifiers, (id) =>
                            List.Transform(Matches, (target) => [Alias = id, ResolvedKey = target])))))
            in
                Table.Buffer(ToEdges(Edges)),
    // Shared identifiers can connect a file's UPN to AAD-only consumption (and vice versa).
    // Retain conflicting evidence in the index; never pick an arbitrary mapping.
    Crosswalk = Index(Table.Buffer(Table.Combine({BaseEdges, SourceEdges(VivaSource), SourceEdges(EntraSource)}))),
    Resolve = (ids as list) as nullable text =>
        let Matches = List.Buffer(Targets(ids, Crosswalk))
        in
            if List.Count(Matches) = 1 then Matches{0}
            else if List.IsEmpty(Matches) then List.First(ids, null)
            else null,

    Normalise = (src as nullable table) as nullable table =>
        if src = null then null
        else
            let
                Present = List.Buffer(Table.ColumnNames(src)),
                IdentityColumns = List.Buffer(ColumnsFor(Present, IdAliases)),
                Extras = List.Buffer(List.Select(Present, each
                    not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_)))),
                Keep = List.Buffer(Expected & Extras),
                Bindings = List.Buffer(List.Transform(Aliases, (spec) =>
                    List.Buffer(List.Distinct(
                        (if List.Contains(Present, spec{0}) then {spec{0}} else {})
                        & ColumnsFor(Present, spec{1}))))),
                Rows = List.Buffer(List.Transform(Table.ToRecords(src), (row) =>
                    Record.FromList(
                        {Resolve(Ids(row, IdentityColumns))}
                        & List.Transform(Bindings, (columns) =>
                            List.First(List.RemoveNulls(
                                List.Transform(columns, each Clean(Record.Field(row, _)))), null))
                        & List.Transform(Extras, each Clean(Record.Field(row, _))),
                        Keep))),
                Named = Table.Buffer(Table.FromRecords(Rows, Keep, MissingField.UseNull)),
                Real = Table.SelectRows(Named, each [UserPrincipalName] <> null),
                // Coalesce duplicate source rows per attribute, after normalising actual keys.
                Grouped = Table.Buffer(Table.Group(Real, {"UserPrincipalName"},
                    List.Transform(List.RemoveItems(Keep, {"UserPrincipalName"}), (c) =>
                        {c, each List.First(List.RemoveNulls(Table.Column(_, c)), null), type nullable text})))
            in
                Grouped,
    Viva = Normalise(VivaSource),
    Entra = Normalise(EntraSource),
    AllCols = List.Union({
        Expected,
        if Viva = null then {} else Table.ColumnNames(Viva),
        if Entra = null then {} else Table.ColumnNames(Entra)
    }),
    Attrs = List.RemoveItems(AllCols, {"UserPrincipalName"}),
    Empty = #table(AllCols, {}),
    // Pad each source before expansion: extra columns need not exist in both.
    V = Table.Buffer(Table.SelectColumns(if Viva = null then Empty else Viva, AllCols, MissingField.UseNull)),
    E = Table.Buffer(Table.SelectColumns(if Entra = null then Empty else Entra, AllCols, MissingField.UseNull)),
    Spine = Table.RenameColumns(
        Table.SelectRows(Table.SelectColumns(Roster, {"ResolvedKey"}), each [ResolvedKey] <> null),
        {{"ResolvedKey", "UserPrincipalName"}}),
    // Three independent exports, three independent opinions on how to spell
    // an address, and Table.Distinct compares them case-SENSITIVELY while
    // the DAX relationship downstream does not. A directory saying AlexW@x
    // beside a Viva export saying alexw@x therefore reached the model as two
    // Org rows for one person, and Org is the one side of every
    // relationship, so the refresh failed outright on the duplicate key.
    //
    // The same fold is applied to the two indexes below. Deduplicating the
    // spine alone would fix the crash and replace it with a quieter bug:
    // the surviving spelling would no longer match the other source, and
    // that person would load fine with no department at all.
    Fold = (u as nullable text) as nullable text =>
        if u = null then null else Text.Lower(Text.Trim(u)),
    // Record.FromList raises on a repeated field name, so each side is
    // reduced to one row per folded key before it is indexed.
    ByFoldedKey = (t as table) as table =>
        Table.RemoveColumns(
            Table.Distinct(
                Table.AddColumn(
                    Table.SelectRows(t, each [UserPrincipalName] <> null
                        and Text.Trim([UserPrincipalName]) <> ""),
                    "_upnKey", each Fold([UserPrincipalName]), type text),
                {"_upnKey"}),
            {"_upnKey"}),
    Upns = Table.Buffer(ByFoldedKey(Table.Combine({
        Spine, Table.SelectColumns(E, {"UserPrincipalName"}), Table.SelectColumns(V, {"UserPrincipalName"})
    }))),
    // V and E have one buffered row per key; index once instead of re-reading nested joins per attribute.
    VK = Table.Buffer(ByFoldedKey(V)),
    EK = Table.Buffer(ByFoldedKey(E)),
    VIndex = Record.FromList(List.Buffer(Table.ToRecords(VK)), List.Buffer(List.Transform(VK[UserPrincipalName], Fold))),
    EIndex = Record.FromList(List.Buffer(Table.ToRecords(EK)), List.Buffer(List.Transform(EK[UserPrincipalName], Fold))),
    Merged = Table.FromRecords(List.Transform(Table.ToRecords(Upns), (row) =>
        let
            VivaRow = Record.FieldOrDefault(VIndex, Fold(row[UserPrincipalName]), []),
            EntraRow = Record.FieldOrDefault(EIndex, Fold(row[UserPrincipalName]), [])
        in
            Record.FromList({row[UserPrincipalName]} & List.Transform(Attrs, (c) =>
                let
                    e = Record.FieldOrDefault(EntraRow, c, null),
                    v = Record.FieldOrDefault(VivaRow, c, null)
                in
                    if e <> null and e <> "" then e else v), AllCols)),
        AllCols, MissingField.UseNull),
    Typed = Table.TransformColumnTypes(Merged, List.Transform(AllCols, each {_, type text}))
in
    Typed
