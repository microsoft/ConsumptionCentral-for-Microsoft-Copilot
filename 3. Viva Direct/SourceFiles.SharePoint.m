// SourceFiles, SharePoint form (SharePoint.Files).
//
// Replace the SourceFiles query with this text to read the data files from a
// SharePoint folder instead of a local one, then set two parameters:
//   SharePointSiteUrl  the site, such as https://contoso.sharepoint.com/sites/ConsumptionCentral
//   DataFolder         the folder, such as https://contoso.sharepoint.com/sites/ConsumptionCentral/Shared Documents/Consumption Central
// DataFolder also accepts the folder's address from the browser, or a path
// inside the site such as Shared Documents/Consumption Central.
//
// SharePoint.Files lists every file in the site, then keeps the folder and
// its subfolders, so a site that holds little else refreshes fastest.
// Depth 0 is the folder itself, as in the local form.
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
    FolderDepth = Segments(FolderKey),
    Listing = SharePoint.Files(Site, [ApiVersion = 15]),
    Inside = Table.SelectRows(Listing, each Text.StartsWith(Key([#"Folder Path"]), FolderKey)),
    Kept = Table.SelectColumns(Inside, {"Content", "Name", "Extension", "Date modified", "Folder Path"}),
    Files = Table.AddColumn(Kept, "Depth", each Segments(Key([#"Folder Path"])) - FolderDepth, Int64.Type)
in
    // An address problem fails here, with its own message, before any listing.
    if Given = "" then null else if Problem <> null then error Problem else Files
