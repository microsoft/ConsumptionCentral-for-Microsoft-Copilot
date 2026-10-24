let
	// Optional on this path. Viva Direct reads Cowork through the
	// connector, so a tenant with only Cowork has no files at all -
	// that is a supported setup, not a misconfiguration.
	Raw = try SourceFiles otherwise null,
	Csvs = if Raw = null then null
		else Table.SelectRows(Raw, each Text.Lower([Extension]) = ".csv"),
	// SourceFiles supplies Depth, 0 for the folder DataFolder names, so
	// GetDataFile prefers that folder's copy to one left in a subfolder.
	Keyed = if Csvs = null then null
		else Table.AddColumn(Csvs, "MatchKey",
			each Text.Lower(Text.Remove([Name], {" ", "_", "-"})), type text)
in
	Keyed
