let
	// The one place this model lists its data files. DataFiles and
	// CoworkTaskInput both read from here, so reading another store means
	// replacing only this query: SourceFiles.SharePoint.m, next to the
	// template, reads a SharePoint folder instead of a local one.
	Root = if DataFolder = null then "" else Text.Trim(Text.From(DataFolder)),
	// Folders may be separated by / or \.
	Segments = (path as text) as number =>
		List.Count(List.Select(Text.SplitAny(path, "/\"), each _ <> "")),
	RootDepth = Segments(Root),
	Listing = if Root = "" then null else Folder.Files(Root),
	Kept = if Listing = null then null
		else Table.SelectColumns(Listing, {"Content", "Name", "Extension", "Date modified", "Folder Path"}),
	// Depth 0 is the folder DataFolder names. Folder.Files recurses, and a
	// stale copy left in a subfolder should never quietly outrank the file
	// the customer put in the folder they nominated.
	Files = if Kept = null then null
		else Table.AddColumn(Kept, "Depth",
			each Segments([#"Folder Path"]) - RootDepth, Int64.Type)
in
	Files
