// SourceFiles, SharePoint form (SharePoint.Contents). Not yet tested on a
// live site: SourceFiles.SharePoint.m is the supported form.
//
// Use it the same way: replace the SourceFiles query with this text and set
// SharePointSiteUrl and DataFolder as SourceFiles.SharePoint.m describes.
// Instead of listing every file in the site and filtering, this opens the
// folder by name (the library's name in its address, such as
// Shared Documents, then each subfolder) and walks only what is under it, so
// a large site should refresh faster. Depth 0 is the folder itself.
let
    // Shared resolve steps: keep identical in both SharePoint forms.
    Site = if SharePointSiteUrl = null then ""
        else Text.TrimEnd(Text.BeforeDelimiter(Text.Trim(Text.From(SharePointSiteUrl)), "?"), {"/", "\"}),
    Given = if DataFolder = null then "" else Text.Trim(Text.From(DataFolder)),
    // Uri.Parts decodes query values but not paths, so a path is decoded by
    // passing it through as a query value, with + & # = ; and space escaped.
    Decode = (path as text) as text =>
        if not Text.Contains(path, "%") then path
        else try Record.Field(Uri.Parts("http://localhost/?p=" & Text.Combine(List.Transform(Text.ToList(path), each
            if _ = "+" then "%2B" else if _ = "&" then "%26" else if _ = "#" then "%23"
            else if _ = "=" then "%3D" else if _ = ";" then "%3B" else if _ = " " then "%20" else _)))[Query], "p")
            otherwise path,
    // Decoded, separated by /, with one trailing /. Key also ignores case.
    Plain = (path as text) as text => Text.TrimEnd(Text.Replace(Decode(path), "\", "/"), "/") & "/",
    Key = (path as text) as text => Text.Lower(Plain(path)),
    Segments = (path as text) as number => List.Count(List.Select(Text.Split(path, "/"), each _ <> "")),
    Slashed = Text.Replace(Given, "\", "/"),
    Lowered = Text.Lower(Given),
    IsUrl = Text.StartsWith(Lowered, "https://") or Text.StartsWith(Lowered, "http://"),
    IsLocal = (Text.Length(Given) > 1 and Text.Middle(Given, 1, 1) = ":")
        or Text.StartsWith(Slashed, "//") or Text.StartsWith(Lowered, "file:"),
    // A sharing link (.../:f:/s/...) names the folder by a token, not a path.
    IsShared = IsUrl and Text.Contains(Text.BeforeDelimiter(Given, "?"), "/:"),
    Origin = (url as text) as text => Text.BeforeDelimiter(url, "/", 2),
    // A browser view names its folder in its id or RootFolder value, and a
    // library's own view (.../Forms/AllItems.aspx) stands for the library.
    FromUrl = (url as text) as text =>
        let
            Address = Text.BeforeDelimiter(url, "?"),
            Query = if Text.Contains(url, "?") then try Uri.Parts(url)[Query] otherwise [] else [],
            Viewed = Record.FieldOrDefault(Query, "id", Record.FieldOrDefault(Query, "RootFolder", null)),
            At = Text.PositionOf(Text.Lower(Address), "/forms/", Occurrence.Last)
        in
            if Viewed <> null then Origin(url) & Viewed
            else if At >= 0 and Text.EndsWith(Text.Lower(Address), ".aspx") then Text.Start(Address, At)
            else Address,
    Folder =
        if IsUrl then FromUrl(Given)
        else if Text.StartsWith(Slashed, "/") then Origin(Site) & Slashed
        else Site & "/" & Slashed,
    SiteKey = Key(Site),
    FolderPlain = Plain(Folder),
    FolderKey = Text.Lower(FolderPlain),
    Problem =
        if IsLocal then Error.Record("SourceFiles",
            "DataFolder is a local path, but this SourceFiles reads SharePoint. Set DataFolder to the SharePoint folder's address.",
            Given)
        else if IsShared then Error.Record("SourceFiles",
            "DataFolder is a sharing link. Open the folder in the browser and use the address bar instead.", Given)
        else if Site = "" then Error.Record("SourceFiles",
            "Set SharePointSiteUrl to the address of the SharePoint site that holds DataFolder.", Given)
        else if not Text.StartsWith(FolderKey, SiteKey) then Error.Record("SourceFiles",
            "DataFolder is not inside the SharePointSiteUrl site. SharePointSiteUrl is the site's own address, without a library, folder or page.",
            [DataFolder = Given, SharePointSiteUrl = Site])
        else null,
    // End of shared resolve steps.
    // Folder names below the site: the library, then each subfolder.
    Steps = List.Select(Text.Split(Text.Middle(FolderPlain, Text.Length(SiteKey)), "/"), each _ <> ""),
    Open = (listing as table, name as text) as table =>
        let
            Hits = Table.SelectRows(listing, each Text.Lower([Name]) = Text.Lower(name))
        in
            if Table.IsEmpty(Hits)
            then error Error.Record("SourceFiles",
                "SharePoint.Contents found no folder with this name on the way to DataFolder.", name)
            else Hits{0}[Content],
    // Files carry binary Content and folders a table. Folder Path and Depth
    // are built on the way down, in the same shape as the SharePoint.Files form.
    Walk = (listing as table, depth as number, path as text) as table =>
        let
            Here = Table.SelectColumns(Table.SelectRows(listing, each [Content] is binary),
                {"Content", "Name", "Date modified"}, MissingField.UseNull),
            Typed = Table.AddColumn(Here, "Extension", each
                if Text.Contains([Name], ".")
                then "." & Text.AfterDelimiter([Name], ".", {0, RelativePosition.FromEnd})
                else "", type text),
            Placed = Table.AddColumn(Table.AddColumn(Typed, "Folder Path", each path, type text),
                "Depth", each depth, Int64.Type),
            Shaped = Table.SelectColumns(Placed, {"Content", "Name", "Extension", "Date modified", "Folder Path", "Depth"}),
            Below = List.Transform(Table.ToRecords(Table.SelectRows(listing, each [Content] is table)),
                (folder) => @Walk(folder[Content], depth + 1, path & folder[Name] & "/"))
        in
            Table.Combine({Shaped} & Below),
    Files = Walk(List.Accumulate(Steps, SharePoint.Contents(Site, [ApiVersion = 15]), Open), 0, FolderPlain)
in
    // An address problem fails here, with its own message, before any listing.
    if Given = "" then null else if Problem <> null then error Problem else Files
