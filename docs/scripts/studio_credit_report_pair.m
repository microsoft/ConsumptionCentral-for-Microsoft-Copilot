let
    Files = __FILES__,
    Matches = if Files = null then #table({"Name", "Content"}, {})
        else Table.SelectRows(Files, each Text.StartsWith([Name], "StudioReportsPreview_")
            and Text.EndsWith(Text.Lower([Name]), ".json") and Binary.Length([Content]) > 0),
    Sorted = Table.Sort(Matches, {{"Name", Order.Descending}}),
    Latest = if Table.IsEmpty(Sorted) then null else Sorted{0}[Content],
    Package = if Latest = null then null else if Binary.Length(Latest) > 33554432
        then error Error.Record("CreditReportSize", "The report pair exceeds 32 MiB.", null)
        else Json.Document(Latest),
    Pair = if Package = null then null else if Value.Is(Package, type record)
        and Record.HasFields(Package, {"startDate", "endDate", "feature", "billing"}) then Package
        else error Error.Record("CreditReportPair", "Expected a complete feature and billing report pair.", null),
    ReadDate = (value as any) as date => Date.FromText(Text.From(value), [Format="yyyy-MM-dd", Culture="en-US"]),
    Start = if Pair = null then null else ReadDate(Pair[startDate]),
    End = if Pair = null then null else ReadDate(Pair[endDate]),
    Today = Date.From(DateTimeZone.FixedUtcNow()),
    ValidRange = if Pair = null then true else Start <= End and Duration.Days(End - Start) < 30 and End < Today,
    Fresh = if not ValidRange then error Error.Record("CreditReportRange", "Invalid or future report range.", null)
        else Pair <> null and Duration.Days(Today - End) <= 3,
    ReadRows = (payload as any, required as list) as table =>
        let
            Data = if Value.Is(payload, type text) then Text.ToBinary(payload, TextEncoding.Utf8)
                else if Value.Is(payload, type record) and Record.HasFields(payload, "$content")
                then Binary.FromText(Record.Field(payload, "$content"), BinaryEncoding.Base64)
                else error Error.Record("CreditReportPayload", "Expected CSV text or a connector binary wrapper.", null),
            Decoded = if Binary.Length(Data) >= 2 and Binary.ToList(Binary.Range(Data, 0, 2)) = {31, 139}
                then Binary.Decompress(Data, Compression.GZip) else Data,
            Raw = if Binary.Length(Decoded) > 16777216 then error Error.Record("CreditReportSize", "Decoded CSV exceeds 16 MiB.", null)
                else Csv.Document(Decoded, [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
            Headers = if Table.IsEmpty(Raw) then {} else List.Transform(Record.FieldValues(Raw{0}), each Text.Lower(Text.Trim(Text.From(_)))),
            Unique = List.Count(List.Distinct(Headers)) = List.Count(Headers),
            Checked = if Unique and List.ContainsAll(Headers, required) then Raw
                else error Error.Record("CreditReportHeaders", "Missing or duplicate report headers.", required),
            Named = Table.RenameColumns(Table.Skip(Checked), List.Zip({Table.ColumnNames(Checked), Headers}))
        in
            Named,
    Label = (row as record, name as text) as nullable text =>
        let Value = Record.FieldOrDefault(row, name, null)
        in if Value = null or Text.Trim(Text.From(Value)) = "" then null else Text.Trim(Text.From(Value)),
    Amount = (row as record, name as text) as number =>
        let Value = Label(row, name), Number = if Value = null then error Error.Record("CreditReportQuantity", "Missing credit amount.", name)
            else Number.FromText(Value, "en-US")
        in if Number.IsNaN(Number) or Number.Abs(Number) = #infinity then error Error.Record("CreditReportQuantity", "Invalid credit amount.", name) else Number,
    Day = (row as record, name as text) as date =>
        let Value = Label(row, name), Date = if Value = null then error Error.Record("CreditReportDate", "Missing report date.", name)
            else ReadDate(Text.Start(Value, 10)),
            Stamp = if Text.Length(Value) <= 10 then Date else Date.From(DateTimeZone.FromText(Value, [Culture="en-US"]))
        in if Stamp = Date and (if Fresh then Date >= Start and Date <= End else Date < Today) then Date
            else error Error.Record("CreditReportDate", "Date is outside the requested range.", name),
    LegacyFiles = if Files = null then #table({"Name", "Content"}, {}) else
        Table.Sort(Table.SelectRows(Files, each Text.StartsWith([Name], "StudioApiAgentDaily_")
            and Text.EndsWith(Text.Lower([Name]), ".csv")), {{"Name", Order.Descending}}),
    LegacyTables = if Fresh then {} else List.Transform(LegacyFiles[Content], each
        ReadRows(Text.FromBinary(_, TextEncoding.Utf8), {"usage date", "agent id", "billed credit", "feature", "channel", "environment id"})),
    LegacyAll = if List.IsEmpty(LegacyTables) then #table({}, {}) else Table.Combine(LegacyTables),
    Legacy = if Table.IsEmpty(LegacyAll) then LegacyAll else Table.Distinct(Table.Buffer(LegacyAll),
        {"usage date", "agent id", "feature", "channel", "environment id"}),
    Resources = if not Fresh then null else ReadRows(Pair[feature], {"consumptiondate", "product", "resourcetype", "billedcredits", "nonbilledcredits"}),
    Billing = if not Fresh then null else ReadRows(Pair[billing], {"billeddate", "capacitypackcreditsconsumed", "paygoconsumedquantity"}),
    ResourceRecords = if Resources = null then List.Transform(Table.ToRecords(Legacy), each [
        ConsumptionDate = Day(_, "usage date"), ResourceId = Label(_, "agent id"),
        ResourceName = Label(_, "agent name"), ResourceType = null, HarnessType = null, Product = null,
        Feature = Label(_, "feature"), Channel = Label(_, "channel"),
        EnvironmentId = Label(_, "environment id"), EnvironmentName = Label(_, "environment name"),
        BilledCredits = Amount(_, "billed credit"),
        NonBilledCredits = if Label(_, "non-billed credit") = null then null else Amount(_, "non-billed credit")
    ]) else List.Transform(Table.ToRecords(Resources), each [
        ConsumptionDate = Day(_, "consumptiondate"), ResourceId = Label(_, "resourceid"),
        ResourceName = Label(_, "resourcename"), ResourceType = Label(_, "resourcetype"),
        HarnessType = Label(_, "harnesstype"), Product = Label(_, "product"),
        Feature = Label(_, "feature"), Channel = Label(_, "channel"),
        EnvironmentId = Label(_, "environmentid"), EnvironmentName = Label(_, "environmentname"),
        BilledCredits = Amount(_, "billedcredits"), NonBilledCredits = Amount(_, "nonbilledcredits")
    ]),
    BillingRecords = if Billing = null then {} else List.Transform(Table.ToRecords(Billing), each [
        BilledDate = Day(_, "billeddate"), EnvironmentId = Label(_, "environmentid"),
        EnvironmentName = Label(_, "environmentname"), EntitlementId = Label(_, "entitlementid"),
        BillingPolicyId = Label(_, "billingpolicyid"),
        CapacityPackCreditsConsumed = Amount(_, "capacitypackcreditsconsumed"),
        PayGoConsumedQuantity = Amount(_, "paygoconsumedquantity")
    ])
in
    [Resources = ResourceRecords, Billing = BillingRecords, StartDate = Start, EndDate = End, Fresh = Fresh]
