r"""Read-only, stdlib regression checks; run from the clone root:

  python -B docs\scripts\check_viva_query_org.py
  python -B docs\scripts\check_viva_query_org.py candidate.pbit --baseline original.pbit
  python -B docs\scripts\check_viva_query_org.py --in-memory-patched

The positional PBIT defaults to fix_viva_query_org.DEFAULT_PATH. The original
is EXPECTED to fail structural contracts. --in-memory-patched applies the current
patcher public APIs to bytes only, then tests that candidate against the input.
No PBIT, scratch files, dependencies, or network resources are created.

Package checks inspect actual sources, caches and records, not only replacement
byte equality. Baseline checks compare all 364 untouched ZIP local records and
central metadata (excluding relocated offsets), and all non-patch JSON fields.
This includes unchanged relationship metadata, DAX source strings, and report
bytes. JSON serialization of the two edited parts necessarily changes.

REFERENCE fixtures below are a small independent Python requirements oracle,
NOT an M interpreter or actual M/DAX execution. Structural checks bind important
branches to package sources but cannot prove refresh, M syntax/evaluation,
connector behavior, DAX results or visual behavior. Validate those in Desktop.
Explicit-roster fixtures intentionally bypass the base query's existing UPN
coalescing; they do not establish a live symptom's cause. Oracle attributes are
before the existing 5% coverage gate, which may legitimately omit sparse fields.
"""

import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import unittest
import zipfile

sys.dont_write_bytecode = True
import fix_viva_query_org as fix
from fix_org_upn_case import BUFFERED_NEW, BUFFERED_OLD

# Every record in the template except the two model parts the patcher may
# rewrite. All three shipping templates carry the same report layer, so this
# is a fixed number; it moves only when the report itself gains or loses parts.
UNAFFECTED_RECORDS = 364


def documents(package):
    return [fix.decode_part(package.contents[n], n)[0] for n in fix.PARTS]


def candidate(package):
    schema, unapplied = documents(package)
    before = copy.deepcopy((schema, unapplied))
    replacements = fix.load_replacements(fix.query_index(schema, unapplied)[2])
    changed = fix.patch_documents(schema, unapplied, replacements)
    updates = {
        name: fix.encode_part(after, package.contents[name].startswith(b"\xff\xfe"))
        for name, old, after in zip(fix.PARTS, before, (schema, unapplied))
        if old != after
    }
    raw = package.rebuild(updates)
    fix.validate_candidate(package, raw, updates, replacements, (schema, unapplied))
    return fix.Package(raw), changed


def unmodified_fields(package):
    schema, unapplied = documents(package)
    holders, queries, _ = fix.query_index(schema, unapplied)
    for name in fix.QUERY_NAMES:
        holders[name]["expression"] = queries[name]["text"] = "<allowed source edit>"
    for name, query in queries.items():
        if "lastLoadedAsTableFormulaText" in query:
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            if name in fix.QUERY_NAMES:
                cache["RootFormulaText"] = "<allowed source edit>"
            for ref in cache.get("ReferencedQueriesFormulaText", {}):
                if ref in fix.QUERY_NAMES:
                    cache["ReferencedQueriesFormulaText"][ref] = "<allowed source edit>"
            query["lastLoadedAsTableFormulaText"] = cache
    return json.dumps((schema, unapplied), ensure_ascii=False, sort_keys=True).encode("utf-8")


def compare_packages(test, before, after):
    test.assertEqual(list(before.infos), list(after.infos), "ZIP names/order")
    test.assertEqual(before.local_order, after.local_order)
    test.assertEqual((before.prefix, before.comment), (after.prefix, after.comment))
    test.assertEqual(before.end_record[:12] + before.end_record[20:],
                     after.end_record[:12] + after.end_record[20:])
    unaffected = set(before.infos) - set(fix.PARTS)
    test.assertEqual(len(unaffected), UNAFFECTED_RECORDS,
                     f"Expected exactly {UNAFFECTED_RECORDS} unaffected records")
    for name in before.infos:
        with test.subTest(part=name):
            a, b = before.central[name], after.central[name]
            if name in unaffected:
                test.assertEqual(before.locals[name], after.locals[name], "Full local record/payload")
                test.assertEqual(before.contents[name], after.contents[name], "Decoded payload")
                test.assertEqual(a[:42] + a[46:], b[:42] + b[46:], "Central metadata")
            else:
                test.assertEqual(a[:16] + a[28:42] + a[46:], b[:16] + b[28:42] + b[46:])
                ah, ap = before.payloads[name]
                bh, bp = after.payloads[name]
                a, b = before.locals[name], after.locals[name]
                test.assertEqual(a[:14] + a[26:ah], b[:14] + b[26:bh])
                test.assertEqual(a[ap:], b[bp:])
                test.assertEqual(before.contents[name][:2], after.contents[name][:2], "BOM convention")
    test.assertEqual(unmodified_fields(before), unmodified_fields(after),
                     "Non-patch schema, relationships, DAX, query names/order or cache fields changed")


def compact(text):
    return re.sub(r"\s+", "", re.sub(r"//[^\n]*", "", text))


PREVIOUS_SHA256 = {
    "VivaOrgFromMetrics": "2a275ab05362f73d5d90dfb8aff141dcfadc782524b6d259e15865c2b18faa36",
    "VivaOrgAttributes": "c83317c04ae758a63e7483ba9f4207ecd8f07702dab018ea7757b53b174a0d5d",
    "OrgNormalised": "366b7832441c1162fa699f807b73e22b06f3298afb889fe83286594d5b63084a",
}

PRE_PERFORMANCE_SHA256 = {
    "direct": {
        "VivaCreditMetrics": "679d7b773d70f49d4b83e96c68b2b957b82c58cb7c9593588132c68b32f5653b",
        "VivaOrgFromMetrics": "4597da3450a6f90fcfe193db09f5bac412929ea7a1c46d38663b9f2149615ddb",
        "VivaOrgAttributes": "299310e3069105d68fabacf2d9e23d0ffba66b5b860a1546e45bbb2296b41a2f",
        "OrgNormalised": "90cb52b38541fb2bb268d48e492af230aaf40deefb4e503fafca152126b56ee6",
    },
    "fabric": {
        "VivaOrgFromMetrics": "2a275ab05362f73d5d90dfb8aff141dcfadc782524b6d259e15865c2b18faa36",
        "OrgNormalised": "36910cedfc5326e679481a30d07acc343812f4949dbf99ca88d8afe332f4e996",
    },
}


def previous_sources(replacements):
    """Reverse exact changed blocks; captured hashes prevent fixture drift."""
    performance_inverses = {
        "VivaOrgFromMetrics": [
            ("Grouped = Table.Buffer(Table.Group(AsText, {\"PersonId\"}, List.Transform(OrgCols, (c) =>\n"
             "                    {c, each List.First(List.RemoveNulls(Table.Column(_, c)), null), type nullable text})))",
             "Grouped = Table.Group(AsText, {\"PersonId\"}, List.Transform(OrgCols, (c) =>\n"
             "                    {c, each List.First(List.RemoveNulls(Table.Column(_, c)), null), type nullable text}))"),
            ("RosterKeys = Table.Buffer(Table.AddColumn(\n"
             "                    Table.SelectColumns(VivaSeatRoster, {\"PersonId\", \"userPrincipalName\"}),\n"
             "                    \"UserPrincipalName\", each\n"
             "                        let Upn = Clean([userPrincipalName])\n"
             "                        in Text.Lower(if Upn = null then Text.Trim(Text.From([PersonId])) else Upn),\n"
             "                    type nullable text))",
             "RosterKeys = Table.AddColumn(\n"
             "                    Table.SelectColumns(VivaSeatRoster, {\"PersonId\", \"userPrincipalName\"}),\n"
             "                    \"UserPrincipalName\", each\n"
             "                        let Upn = Clean([userPrincipalName])\n"
             "                        in Text.Lower(if Upn = null then Text.Trim(Text.From([PersonId])) else Upn),\n"
             "                    type nullable text)"),
            ("NormalKeys = Table.Buffer(Table.ExpandTableColumn(\n"
             "                    Table.SelectColumns(Joined, {\"PersonId\", \"UserPrincipalName\", \"__attributes\"}),\n"
             "                    \"__attributes\", OrgCols))",
             "NormalKeys = Table.ExpandTableColumn(\n"
             "                    Table.SelectColumns(Joined, {\"PersonId\", \"UserPrincipalName\", \"__attributes\"}),\n"
             "                    \"__attributes\", OrgCols)"),
        ],
        "VivaOrgAttributes": [
            ("                // Buffer both grouped rows and nested key lists before building the PHID map.\n", ""),
            ("Grouped = Table.Buffer(Table.Group(Real, {\"PeopleHistoricalId\"}, {\n"
             "                    {\"Keys\", each List.Buffer(List.Distinct([ResolvedKey])), type list}\n"
             "                }))",
             "Grouped = Table.Group(Real, {\"PeopleHistoricalId\"}, {\n"
             "                    {\"Keys\", each List.Distinct([ResolvedKey]), type list}\n"
             "                })"),
            ("Unique = Table.Buffer(Table.SelectRows(Grouped, each List.Count([Keys]) = 1))",
             "Unique = Table.SelectRows(Grouped, each List.Count([Keys]) = 1)"),
            ("Map = Record.FromList(List.Buffer(List.Transform(Unique[Keys], each _{0})),\n"
             "                    List.Buffer(Unique[PeopleHistoricalId]))",
             "Map = Record.FromList(List.Transform(Unique[Keys], each _{0}), Unique[PeopleHistoricalId])"),
            ("Records = List.Buffer(List.Transform(Table.ToRecords(Source), (row) =>",
             "Records = List.Transform(Table.ToRecords(Source), (row) =>"),
            ("Record.Combine({row, [UserPrincipalName = Resolved]})))",
             "Record.Combine({row, [UserPrincipalName = Resolved]}))"),
        ],
        "OrgNormalised": [
            ("let Matches = List.Buffer(Targets(ids, Crosswalk))",
             "let Matches = Targets(ids, Crosswalk)"),
            ("Present = List.Buffer(Table.ColumnNames(src)),", "Present = Table.ColumnNames(src),"),
            ("IdentityColumns = List.Buffer(ColumnsFor(Present, IdAliases)),",
             "IdentityColumns = ColumnsFor(Present, IdAliases),"),
            ("Extras = List.Buffer(List.Select(Present, each\n"
             "                    not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_)))),",
             "Extras = List.Select(Present, each\n"
             "                    not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_))),"),
            ("Keep = List.Buffer(Expected & Extras),", "Keep = Expected & Extras,"),
            ("Bindings = List.Buffer(List.Transform(Aliases, (spec) =>\n"
             "                    List.Buffer(List.Distinct(\n"
             "                        (if List.Contains(Present, spec{0}) then {spec{0}} else {})\n"
             "                        & ColumnsFor(Present, spec{1}))))),",
             "Bindings = List.Transform(Aliases, (spec) =>\n"
             "                    List.Distinct(\n"
             "                        (if List.Contains(Present, spec{0}) then {spec{0}} else {})\n"
             "                        & ColumnsFor(Present, spec{1}))),"),
            ("Named = Table.Buffer(Table.FromRecords(Rows, Keep, MissingField.UseNull)),",
             "Named = Table.FromRecords(Rows, Keep, MissingField.UseNull),"),
            ('''    // V and E have one buffered row per key; index once instead of re-reading nested joins per attribute.
    VIndex = Record.FromList(List.Buffer(Table.ToRecords(V)), List.Buffer(V[UserPrincipalName])),
    EIndex = Record.FromList(List.Buffer(Table.ToRecords(E)), List.Buffer(E[UserPrincipalName])),
    Merged = Table.FromRecords(List.Transform(Table.ToRecords(Upns), (row) =>
        let
            VivaRow = Record.FieldOrDefault(VIndex, row[UserPrincipalName], []),
            EntraRow = Record.FieldOrDefault(EIndex, row[UserPrincipalName], [])
''', '''    JV = Table.NestedJoin(Upns, {"UserPrincipalName"}, V, {"UserPrincipalName"}, "v", JoinKind.LeftOuter),
    JE = Table.NestedJoin(JV, {"UserPrincipalName"}, E, {"UserPrincipalName"}, "e", JoinKind.LeftOuter),
    // Read nested records without temporary attribute names that could collide with custom columns.
    Merged = Table.FromRecords(List.Transform(Table.ToRecords(JE), (row) =>
        let
            VivaRow = if Table.IsEmpty(row[v]) then [] else row[v]{0},
            EntraRow = if Table.IsEmpty(row[e]) then [] else row[e]{0}
'''),
            ('''    Index = (edges as table) as record =>
        let
            // Eager list index: table buffering is shallow, so buffer grouped key lists too.
            Grouped = Table.Buffer(Table.Group(edges, {"Alias"}, {
                {"Keys", each List.Buffer(List.Distinct([ResolvedKey])), type list}
            })),
            Keys = List.Buffer(Grouped[Keys]),
            Aliases = List.Buffer(Grouped[Alias])
        in
            Record.FromList(Keys, Aliases),
''', '''    Index = (edges as table) as record =>
        let
            Grouped = Table.Group(edges, {"Alias"}, {
                {"Keys", each List.Distinct([ResolvedKey]), type list}
            })
        in
            Record.FromList(Grouped[Keys], Grouped[Alias]),
'''),
            ('''    RosterIds = Table.Buffer(Table.TransformColumns(
        Table.SelectColumns(VivaSeatRoster, {"PersonId", "userPrincipalName"}), {
            {"PersonId", Identity, type nullable text},
            {"userPrincipalName", Identity, type nullable text}
        })),
''', '''    RosterIds = Table.TransformColumns(
        Table.SelectColumns(VivaSeatRoster, {"PersonId", "userPrincipalName"}), {
            {"PersonId", Identity, type nullable text},
            {"userPrincipalName", Identity, type nullable text}
        }),
'''),
            ('''    Roster = Table.Buffer(Table.AddColumn(RosterIds, "ResolvedKey",
        each if [userPrincipalName] <> null then [userPrincipalName] else [PersonId],
        type nullable text)),
''', '''    Roster = Table.AddColumn(RosterIds, "ResolvedKey",
        each if [userPrincipalName] <> null then [userPrincipalName] else [PersonId],
        type nullable text),
'''),
            ("BaseRows = List.Buffer(Table.ToRecords(Table.Buffer(Table.Distinct(Resolved))))",
             "BaseRows = Table.ToRecords(Table.Distinct(Resolved))"),
            ("BaseEdges = Table.Buffer(ToEdges(List.Combine(List.Transform(BaseRows, (row) =>",
             "BaseEdges = ToEdges(List.Combine(List.Transform(BaseRows, (row) =>"),
            ("(id) => [Alias = id, ResolvedKey = row[ResolvedKey]])))))",
             "(id) => [Alias = id, ResolvedKey = row[ResolvedKey]]))))"),
            ("Rows = List.Buffer(Table.ToRecords(Table.Buffer(Table.Distinct(Table.SelectColumns(src, Columns)))))",
             "Rows = Table.ToRecords(Table.Distinct(Table.SelectColumns(src, Columns)))"),
            ("Table.Buffer(ToEdges(Edges))", "ToEdges(Edges)"),
            ("Crosswalk = Index(Table.Buffer(Table.Combine({BaseEdges, SourceEdges(VivaSource), SourceEdges(EntraSource)})))",
             "Crosswalk = Index(Table.Combine({BaseEdges, SourceEdges(VivaSource), SourceEdges(EntraSource)}))"),
            ("Rows = List.Buffer(List.Transform(Table.ToRecords(src), (row) =>",
             "Rows = List.Transform(Table.ToRecords(src), (row) =>"),
            ("Keep)))", "Keep))"),
            ("Grouped = Table.Buffer(Table.Group(Real, {\"UserPrincipalName\"},\n"
             "                    List.Transform(List.RemoveItems(Keep, {\"UserPrincipalName\"}), (c) =>\n"
             "                        {c, each List.First(List.RemoveNulls(Table.Column(_, c)), null), type nullable text})))",
             "Grouped = Table.Group(Real, {\"UserPrincipalName\"},\n"
             "                    List.Transform(List.RemoveItems(Keep, {\"UserPrincipalName\"}), (c) =>\n"
             "                        {c, each List.First(List.RemoveNulls(Table.Column(_, c)), null), type nullable text}))"),
            ("V = Table.Buffer(Table.SelectColumns(if Viva = null then Empty else Viva, AllCols, MissingField.UseNull))",
             "V = Table.SelectColumns(if Viva = null then Empty else Viva, AllCols, MissingField.UseNull)"),
            ("E = Table.Buffer(Table.SelectColumns(if Entra = null then Empty else Entra, AllCols, MissingField.UseNull))",
             "E = Table.SelectColumns(if Entra = null then Empty else Entra, AllCols, MissingField.UseNull)"),
            ('''Upns = Table.Buffer(Table.Distinct(Table.Combine({
        Spine, Table.SelectColumns(E, {"UserPrincipalName"}), Table.SelectColumns(V, {"UserPrincipalName"})
    })))''', '''Upns = Table.Distinct(Table.Combine({
        Spine, Table.SelectColumns(E, {"UserPrincipalName"}), Table.SelectColumns(V, {"UserPrincipalName"})
    }))'''),
        ],
    }
    inverses = {
        "VivaOrgFromMetrics": [
            ('''                // Resolve before expanding custom columns so helper names cannot collide.
                RosterKeys = Table.AddColumn(
                    Table.SelectColumns(VivaSeatRoster, {"PersonId", "userPrincipalName"}),
                    "UserPrincipalName", each
                        let Upn = Clean([userPrincipalName])
                        in Text.Lower(if Upn = null then Text.Trim(Text.From([PersonId])) else Upn),
                    type nullable text),
                Joined = Table.NestedJoin(RosterKeys, {"PersonId"}, Grouped, {"PersonId"},
                    "__attributes", JoinKind.LeftOuter),
                NormalKeys = Table.ExpandTableColumn(
                    Table.SelectColumns(Joined, {"PersonId", "UserPrincipalName", "__attributes"}),
                    "__attributes", OrgCols),
''', '''                Joined = Table.NestedJoin(VivaSeatRoster, {"PersonId"}, Grouped, {"PersonId"},
                    "__attributes", JoinKind.LeftOuter),
                Expanded = Table.ExpandTableColumn(
                    Table.SelectColumns(Joined, {"userPrincipalName", "__attributes"}), "__attributes", OrgCols),
                Named = Table.RenameColumns(Expanded, {{"userPrincipalName", "UserPrincipalName"}}),
                NormalKeys = Table.TransformColumns(Named, {{"UserPrincipalName",
                    each if _ = null then null else Text.Lower(Text.Trim(Text.From(_))), type nullable text}}),
'''),
            ('Table.SelectColumns(NormalKeys, {"PersonId", "UserPrincipalName"} & Live)',
             'Table.SelectColumns(NormalKeys, {"UserPrincipalName"} & Live)'),
        ],
        "VivaOrgAttributes": [
            ('                    {"PersonId", Identity, type nullable text},\n', ''),
            ('''                ResolvedIds = Table.AddColumn(NormalIds, "ResolvedKey",
                    each if [UserPrincipalName] <> null then [UserPrincipalName] else [PersonId],
                    type nullable text),
                Real = Table.SelectRows(ResolvedIds,
                    each [PeopleHistoricalId] <> null and [ResolvedKey] <> null),
''', '''                Real = Table.SelectRows(NormalIds,
                    each [PeopleHistoricalId] <> null and [UserPrincipalName] <> null),
'''),
            ('{"Keys", each List.Distinct([ResolvedKey]), type list}',
             '{"Keys", each List.Distinct([UserPrincipalName]), type list}'),
        ],
        "OrgNormalised": [
            ('''    // Technical inline fields (Domain/PopulationType) do not replace historical HR data.
    Inline = VivaOrgFromMetrics,
    Historical = VivaOrgAttributes,
    VivaSource =
        if Inline = null then Historical
        else if Historical = null then Inline
        else Table.Combine({Inline, Historical}),
''', '''    // Do not fetch optional historical tables when inline attributes already suffice.
    Inline = VivaOrgFromMetrics,
    VivaSource = if Inline <> null then Inline else VivaOrgAttributes,
'''),
            ('    RosterIds = Table.TransformColumns(', '    Roster = Table.TransformColumns('),
            ('''    // Use the consumption key even when the roster has no resolved UPN.
    Roster = Table.AddColumn(RosterIds, "ResolvedKey",
        each if [userPrincipalName] <> null then [userPrincipalName] else [PersonId],
        type nullable text),
''', ''),
            ('Table.ExpandTableColumn(Linked, "roster", {"ResolvedKey"}, {"ResolvedKey"})',
             'Table.ExpandTableColumn(Linked, "roster", {"userPrincipalName"}, {"ResolvedKey"})'),
            ('''        Table.SelectRows(Table.SelectColumns(Roster, {"ResolvedKey"}), each [ResolvedKey] <> null),
        {{"ResolvedKey", "UserPrincipalName"}}),
''', '        Table.SelectRows(Table.SelectColumns(Roster, {"userPrincipalName"}), '
             'each [userPrincipalName] <> null),\n'
             '        {{"userPrincipalName", "UserPrincipalName"}}),\n'),
        ],
    }
    # The Org key fold (docs/scripts/fix_org_upn_case.py) is the newest
    # revision, layered on top of the performance rewrite, so it has to come
    # off first or none of the older blocks below will match.
    fold_inverses = {
        "OrgNormalised": [(BUFFERED_NEW, BUFFERED_OLD)],
    }
    result = {}
    for name, blocks in inverses.items():
        text = replacements[name]
        for new, old in fold_inverses.get(name, ()):
            if text.count(new) != 1:
                raise AssertionError(f"{name}: case-fold fixture block must match exactly once")
            text = text.replace(new, old, 1)
        for new, old in performance_inverses.get(name, ()):
            if text.count(new) != 1:
                raise AssertionError(f"{name}: performance fixture block must match exactly once")
            text = text.replace(new, old, 1)
        for new, old in blocks:
            if text.count(new) != 1:
                raise AssertionError(f"{name}: historical fixture block must match exactly once")
            text = text.replace(new, old, 1)
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != PREVIOUS_SHA256[name]:
            raise AssertionError(f"{name}: reconstructed historical source hash drifted")
        result[name] = text
    return result


def replace_document_sources(schema, unapplied, sources):
    holders, queries, _ = fix.query_index(schema, unapplied)
    for name, text in sources.items():
        holders[name]["expression"] = text.split("\n")
        queries[name]["text"] = text.split("\n")
    for name, query in queries.items():
        if "lastLoadedAsTableFormulaText" not in query:
            continue
        cache = json.loads(query["lastLoadedAsTableFormulaText"])
        if name in sources:
            cache["RootFormulaText"] = sources[name]
        for ref in cache.get("ReferencedQueriesFormulaText", {}):
            if ref in sources:
                cache["ReferencedQueriesFormulaText"][ref] = sources[ref]
        query["lastLoadedAsTableFormulaText"] = json.dumps(cache)


def add_guard_caches(schema, unapplied, sources):
    """These expressions have no caches in the capture; make tests non-vacuous."""
    holders, queries, _ = fix.query_index(schema, unapplied)
    for name in (*sources, "VivaSeatRosterFromMetrics"):
        cache = json.loads(queries[name].get("lastLoadedAsTableFormulaText", "{}"))
        cache.update({
            "RootFormulaText": fix.source_text(holders[name]["expression"], name),
            "IncludesReferencedQueries": True,
            "ReferencedQueriesFormulaText": {
                **cache.get("ReferencedQueriesFormulaText", {}), **sources,
            },
            "RegressionSentinel": {"preserve": [1, None, "unchanged"]},
        })
        queries[name]["lastLoadedAsTableFormulaText"] = json.dumps(cache)


def package_from_documents(package, schema, unapplied):
    return fix.Package(package.rebuild({
        name: fix.encode_part(doc, package.contents[name].startswith(b"\xff\xfe"))
        for name, doc in zip(fix.PARTS, (schema, unapplied))
    }))


class PackageContracts(unittest.TestCase):
    package = baseline = input_package = None

    def setUp(self):
        self.schema, self.unapplied = documents(self.package)
        self.holders, self.queries, self.tables = fix.query_index(self.schema, self.unapplied)
        self.sources = {n: fix.source_text(h["expression"], n) for n, h in self.holders.items()}

    def contains(self, name, *fragments):
        for fragment in fragments:
            with self.subTest(query=name, contract=fragment):
                self.assertTrue(compact(fragment) in compact(self.sources[name]),
                                f"{name}: missing source contract: {fragment}")

    def test_names_sources_and_all_cached_copies_agree(self):
        self.assertEqual(set(self.holders), set(self.queries))
        caches = 0
        for name, query in self.queries.items():
            self.assertEqual(self.sources[name], fix.source_text(query["text"], name))
            if "lastLoadedAsTableFormulaText" not in query:
                continue
            caches += 1
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            self.assertEqual(cache["RootFormulaText"], self.sources[name], name)
            for ref, text in cache.get("ReferencedQueriesFormulaText", {}).items():
                self.assertEqual(text, self.sources[ref], f"{name} -> {ref}")
        self.assertGreater(caches, 0)

    def test_pre_performance_sources_are_explicit_prior_anchors(self):
        original_profile = fix.ACTIVE_PROFILE
        try:
            for profile, sources in PRE_PERFORMANCE_SHA256.items():
                fix.activate_profile(profile)
                for name, digest in sources.items():
                    with self.subTest(profile=profile, query=name):
                        self.assertIn(digest, fix.PROFILES[profile].get("previous_sha256", {}).get(name, ()))
        finally:
            fix.activate_profile(original_profile)

    def test_compact_indexes_are_eager_but_source_semantics_remain(self):
        self.contains("VivaCreditMetrics",
                      "Grouped = Table.Buffer(Table.Group(links",
                      "Labels = List.Buffer(Grouped[Label])",
                      "Aliases = List.Buffer(Grouped[Alias])",
                      "Keys = List.Buffer(KeysFor(row))",
                      "ResolvedComponents = Table.Buffer(Table.AddColumn(Components")
        self.contains("OrgNormalised",
                      "Grouped = Table.Buffer(Table.Group(edges",
                      '{"Keys", each List.Buffer(List.Distinct([ResolvedKey])), type list}',
                      "BaseRows = List.Buffer(Table.ToRecords(Table.Buffer(Table.Distinct(Resolved))))",
                      "Crosswalk = Index(Table.Buffer(Table.Combine({BaseEdges, SourceEdges(VivaSource), SourceEdges(EntraSource)})))",
                      "V = Table.Buffer(Table.SelectColumns(if Viva = null then Empty else Viva",
                      "Upns = Table.Buffer(ByFoldedKey(Table.Combine({")
        self.contains("VivaOrgAttributes",
                      '{"Keys", each List.Buffer(List.Distinct([ResolvedKey])), type list}',
                      "Unique = Table.Buffer(Table.SelectRows(Grouped",
                      "List.Buffer(Unique[PeopleHistoricalId])")

    def test_identity_fallbacks_and_null_cells(self):
        self.contains("VivaCreditMetrics", '"personidnormalized", "personidnormalised"',
                      '"entraid", "entraobjectid", "objectid", "aadobjectid", "aadid", "aad"',
                      '"peoplehistoricalid", "personhistoricalid", "phid"',
                      'List.First(List.RemoveNulls(List.Transform(columns, each Identity(Record.Field(row, _)))), null)',
                      'List.First(List.Combine({[Pids], [Upns], [Aads], [Phids]}))',
                      'Text.Lower(Text.Trim(Text.From(v)))')

    def test_reconciliation_precedes_downstream_person_grouping(self):
        self.contains("VivaCreditMetrics", 'Headers = VivaConnectorSource',
                      'KeysFor = (row as record)', 'Text.From(kind) & ":" & _',
                      'LabelStates = List.Generate(', 'Labels = List.Last(LabelStates)',
                      'PersonId = Record.Field(ResolvedIndex, Record.Field(Labels, KeysFor(row){0}))',
                      'List.Count([Pids]) > 1', 'List.Count([Components]) > 1',
                      'if not Table.IsEmpty(PidConflicts) then error Error.Record(',
                      'else if not Table.IsEmpty(KeyConflicts) then error Error.Record(',
                      '"VivaIdentityConflict"', '"VivaMissingIdentity"')
        self.assertNotIn("VivaSeatRoster", compact(self.sources["VivaCreditMetrics"]))
        self.contains("VivaSeatRosterFromMetrics", 'Table.Group(Rows, {"PersonId"}',
                      'if [UpnRaw] = null or [UpnRaw] = "" then [PersonId] else [UpnRaw]')

    def test_metrics_keep_inline_and_custom_columns(self):
        self.contains("VivaCreditMetrics", 'Table.SelectColumns(WithPlanLim, List.Union({',
                      'Table.ColumnNames(WithPlanLim)', 'MissingField.UseNull',
                      'Record.Combine({row, [', 'List.Union({Cols, List.Transform(IdentitySpecs, each _{0})})')

    def test_canonical_roster_keys_weekly_and_org(self):
        self.contains("CreditsWeekly", 'Table.NestedJoin(Metrics, {"PersonId"}, VivaSeatRoster, {"PersonId"}',
                      'if [SeatUpn] <> null and [SeatUpn] <> "" then [SeatUpn]',
                      'else if [UserPrincipalName] <> null and [UserPrincipalName] <> "" then [UserPrincipalName]',
                      'else [PersonId]', 'Text.Lower(Text.Trim(Text.From(')
        self.contains("VivaOrgFromMetrics", 'Table.Group(AsText, {"PersonId"}',
                      'Table.NestedJoin(RosterKeys, {"PersonId"}, Grouped, {"PersonId"}',
                      'JoinKind.LeftOuter',
                      'Table.SelectColumns(NormalKeys, {"PersonId", "UserPrincipalName"} & Live)')

    def test_query_only_org_receives_roster_fallback_not_null_upn(self):
        self.assertEqual(compact(self.sources["VivaSeatRosterFromFiles"]), "null")
        self.contains("VivaSeatRoster",
                      "if VivaSeatRosterFromFiles = null then VivaSeatRosterFromMetrics")
        self.contains("VivaSeatRosterFromMetrics",
                      'if [UpnRaw] = null or [UpnRaw] = "" then [PersonId] else [UpnRaw]',
                      '{{"UserPrincipalName","userPrincipalName"}}')
        self.contains("VivaOrgFromMetrics",
                      'RosterKeys = Table.Buffer(Table.AddColumn(',
                      'Table.SelectColumns(VivaSeatRoster, {"PersonId", "userPrincipalName"})',
                      '"UserPrincipalName", each let Upn = Clean([userPrincipalName]) '
                      'in Text.Lower(if Upn = null then Text.Trim(Text.From([PersonId])) else Upn)',
                      'if v = null then null else let t = Text.Trim(Text.From(v)) in if t = "" then null else t',
                      'NormalKeys = Table.Buffer(Table.ExpandTableColumn(',
                      'Table.SelectColumns(Joined, {"PersonId", "UserPrincipalName", "__attributes"})',
                      '"__attributes", OrgCols)',
                      'Live = List.Select(OrgCols, (c) => List.NonNullCount(Table.Column(NormalKeys, c)) > 0)')

    def test_org_aliases_coalescing_and_extra_attributes(self):
        self.contains("OrgNormalised", '{"Department", {"department", "dept"}}',
                      '{"Organisation", {"organisation", "organization"}}',
                      'not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_))',
                      'List.First(List.RemoveNulls(',
                      'Table.Group(Real, {"UserPrincipalName"}',
                      'if e <> null and e <> "" then e else v',
                      'Table.ColumnNames(Viva)', 'Table.ColumnNames(Entra)')

    def test_inline_technical_attributes_do_not_skip_historical_hr(self):
        self.contains("OrgNormalised", 'Historical = VivaOrgAttributes',
                      'if Inline = null then Historical',
                      'else if Historical = null then Inline',
                      'else Table.Combine({Inline, Historical})',
                      'Viva = Normalise(VivaSource)')
        self.assertNotIn('ifInline<>nullthenInlineelseVivaOrgAttributes',
                        compact(self.sources["OrgNormalised"]))

    def test_org_consumption_spine_and_fixed_source_columns(self):
        self.contains("OrgNormalised", 'Table.SelectColumns(VivaSeatRoster, {"PersonId", "userPrincipalName"})',
                      'RosterIds = Table.Buffer(Table.TransformColumns(',
                      '{"PersonId", Identity, type nullable text}',
                      '{"userPrincipalName", Identity, type nullable text}',
                      'Roster = Table.Buffer(Table.AddColumn(RosterIds, "ResolvedKey", '
                      'each if [userPrincipalName] <> null then [userPrincipalName] else [PersonId]',
                      'let t = Clean(v) in if t = null then null else Text.Lower(t)',
                      'Spine = Table.RenameColumns(', 'Upns = Table.Buffer(ByFoldedKey(Table.Combine({',
                      'Table.SelectRows(Table.SelectColumns(Roster, {"ResolvedKey"}), each [ResolvedKey] <> null)',
                      '{{"ResolvedKey", "UserPrincipalName"}}',
                      'Spine, Table.SelectColumns(E, {"UserPrincipalName"}), Table.SelectColumns(V, {"UserPrincipalName"})',
                      'Merged = Table.FromRecords(List.Transform(Table.ToRecords(Upns)',
                      'VivaRow = Record.FieldOrDefault(VIndex, Fold(row[UserPrincipalName]), [])',
                      'EntraRow = Record.FieldOrDefault(EIndex, Fold(row[UserPrincipalName]), [])')
        self.contains("Org", 'Table.SelectColumns(OrgNormalised,', 'MissingField.UseNull')
        self.assertNotIn(fix.PLACEHOLDER, self.sources["Org"])
        for column in self.tables["Org"]["columns"]:
            if column.get("type") != "calculated":
                self.assertIn(fix.m_string(column["sourceColumn"]), self.sources["Org"])

    def test_org_merge_indexes_unique_sources_before_per_attribute_access(self):
        self.contains("OrgNormalised",
                      'VIndex = Record.FromList(List.Buffer(Table.ToRecords(VK)), List.Buffer(List.Transform(VK[UserPrincipalName], Fold)))',
                      'EIndex = Record.FromList(List.Buffer(Table.ToRecords(EK)), List.Buffer(List.Transform(EK[UserPrincipalName], Fold)))',
                      'Named = Table.Buffer(Table.FromRecords(Rows, Keep, MissingField.UseNull))',
                      'Keep = List.Buffer(Expected & Extras)',
                      'Bindings = List.Buffer(List.Transform(Aliases',
                      'List.Buffer(List.Distinct(')
        self.assertNotIn('Table.NestedJoin(Upns', compact(self.sources["OrgNormalised"]))
        self.assertNotIn('Table.IsEmpty(row[', compact(self.sources["OrgNormalised"]))

    def test_org_key_is_folded_before_every_case_sensitive_comparison(self):
        """Org is the one side of every relationship, so its key must be unique
        under the case-insensitive comparison DAX applies, not the
        case-sensitive one Table.Distinct and Record.FromList apply."""
        self.contains("OrgNormalised",
                      'Fold = (u as nullable text) as nullable text =>',
                      'if u = null then null else Text.Lower(Text.Trim(u))',
                      'ByFoldedKey = (t as table) as table =>',
                      'VK = Table.Buffer(ByFoldedKey(V))',
                      'EK = Table.Buffer(ByFoldedKey(E))',
                      'Upns = Table.Buffer(ByFoldedKey(Table.Combine({')
        # The spine must not be deduplicated case-sensitively anywhere.
        self.assertNotIn('Upns=Table.Buffer(Table.Distinct(Table.Combine({',
                         compact(self.sources["OrgNormalised"]))
        # Folding only the spine would swap the crash for a silent miss, so the
        # per-attribute lookups have to read through the same fold.
        self.assertNotIn('Record.FieldOrDefault(VIndex,row[UserPrincipalName],[])',
                         compact(self.sources["OrgNormalised"]))
        self.assertNotIn('Record.FieldOrDefault(EIndex,row[UserPrincipalName],[])',
                         compact(self.sources["OrgNormalised"]))

    def test_crosswalk_and_ambiguity_guards(self):
        self.contains("OrgNormalised", 'Crosswalk = Index(Table.Buffer(Table.Combine({BaseEdges, SourceEdges(VivaSource), SourceEdges(EntraSource)})))',
                      'Table.ExpandTableColumn(Linked, "roster", {"ResolvedKey"}, {"ResolvedKey"})',
                      'List.Union({Identifiers, {row[ResolvedKey]}})',
                      '(id) => [Alias = id, ResolvedKey = row[ResolvedKey]]',
                      'if List.Count(Matches) = 1 then Matches{0}',
                      'else if List.IsEmpty(Matches) then List.First(ids, null)', 'else null',
                      'Resolve(Ids(row, IdentityColumns))', 'Matches = Targets(Identifiers, BaseIndex)')
        self.contains("VivaOrgAttributes", 'List.Count([Keys]) = 1',
                      '{"PersonId", Identity, type nullable text}',
                      'Text.Lower(Text.Trim(Text.From(v)))',
                      'if t = "" then null else t',
                      'ResolvedIds = Table.AddColumn(NormalIds, "ResolvedKey", '
                      'each if [UserPrincipalName] <> null then [UserPrincipalName] else [PersonId]',
                      'Real = Table.SelectRows(ResolvedIds, '
                      'each [PeopleHistoricalId] <> null and [ResolvedKey] <> null)',
                      '{"Keys", each List.Buffer(List.Distinct([ResolvedKey])), type list}',
                      'if List.Count(Phids) = 1 then Phids{0} else null',
                      'VivaSeatRoster', 'Record.FieldOrDefault(Map, Phid, null)')

    def test_policy_fields_are_not_org_attributes(self):
        for name in ("VivaOrgFromMetrics", "OrgNormalised"):
            self.contains(name, 'not List.Contains(NotOrg, Key(_))',
                          '"policyname", "policylimit", "policyservicesincluded", "includedservices"',
                          '"spendingpolicyid", "spendingpolicyname"', '"creditsused"', '"sessioncount"')

    def test_existing_sparse_and_intensity_logic(self):
        self.contains("Org Attribute Source", 'MinShare = 0.05',
                      'Covered(c) / Total >= MinShare', 'if List.IsEmpty(Useful)',
                      'Covered(c) > 0', 'if Blank(Record.Field(_, c)) then "(Not set)"',
                      'Table.Combine(List.Transform(Live, One))')
        dax = fix.source_text(self.tables["Group By"]["partitions"][0]["source"]["expression"], "Group By")
        for product in ("Cowork", "Studio", "GitHub"):
            self.assertIn(f'"Usage Intensity ({product})"', dax)
            self.assertIn(f"{product}Missing", dax)
        for token in ("SUMMARIZE(", "TOPN(", "EXCEPT(", '"0. Not used"', "NOT ISEMPTY(", "0.95", "0.99"):
            self.assertIn(token, dax)

    def test_baseline_exact_unaffected_records_and_model(self):
        if self.baseline is None:
            self.skipTest("Supply --baseline for original package preservation checks")
        compare_packages(self, self.baseline, self.package)

    def test_public_patcher_in_memory_preservation_and_idempotence(self):
        patched, _ = candidate(self.package)
        compare_packages(self, self.package, patched)
        twice, changed = candidate(patched)
        self.assertEqual(changed, ())
        self.assertEqual(patched.raw, twice.raw)

    def test_unsupported_source_guard_is_atomic(self):
        replacements = fix.load_replacements(self.tables)
        for name in fix.QUERY_NAMES:
            with self.subTest(query=name):
                schema, unapplied = documents(self.package)
                holders, queries, _ = fix.query_index(schema, unapplied)
                holders[name]["expression"] = queries[name]["text"] = ["let x = 987654321 in x"]
                before = copy.deepcopy((schema, unapplied))
                with self.assertRaisesRegex(fix.PatchError, "unsupported source"):
                    fix.patch_documents(schema, unapplied, replacements)
                self.assertEqual(before, (schema, unapplied))

    def assert_rejected_atomically(self, schema, unapplied, replacements, message):
        before = copy.deepcopy((schema, unapplied))
        with self.assertRaisesRegex(fix.PatchError, message):
            fix.patch_documents(schema, unapplied, replacements)
        self.assertEqual(before, (schema, unapplied), "Preflight mutated rejected documents")

    def assert_migration(self, before, expected):
        after, changed = candidate(before)
        self.assertEqual(set(changed), set(expected))
        compare_packages(self, before, after)
        holders, queries, tables = fix.query_index(*documents(after))
        replacements = fix.load_replacements(tables)
        for name in expected:
            self.assertEqual(fix.source_text(holders[name]["expression"], name), replacements[name])
            self.assertEqual(fix.source_text(queries[name]["text"], name), replacements[name])
        for name, query in queries.items():
            if "lastLoadedAsTableFormulaText" not in query:
                continue
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            if name in expected:
                self.assertEqual(cache["RootFormulaText"], replacements[name])
            for ref, text in cache.get("ReferencedQueriesFormulaText", {}).items():
                if ref in expected:
                    self.assertEqual(text, replacements[ref], f"{name} -> {ref}")
        twice, changed = candidate(after)
        self.assertEqual(changed, ())
        self.assertEqual(after.raw, twice.raw)

    def test_historical_package_migration_caches_preservation_and_idempotence(self):
        replacements = fix.load_replacements(self.tables)
        previous = previous_sources(replacements)
        # Always reconstruct fixtures, even after the on-disk package is upgraded.
        current, _ = candidate(self.package)
        schema, unapplied = documents(current)
        replace_document_sources(schema, unapplied, previous)
        add_guard_caches(schema, unapplied, previous)
        before = package_from_documents(current, schema, unapplied)
        self.assert_migration(before, previous)
        # Also exercise the actual unmodified historical capture when supplied.
        holders, _, _ = fix.query_index(*documents(self.input_package))
        if all(fix.source_text(holders[n]["expression"], n) == text for n, text in previous.items()):
            input_sources = {n: fix.source_text(holders[n]["expression"], n) for n in fix.QUERY_NAMES}
            replacements = fix.load_replacements(self.tables)
            expected = {
                n: text for n, text in input_sources.items()
                if text != replacements[n]
            }
            self.assert_migration(self.input_package, expected)

    def test_historical_cache_only_migration(self):
        current, _ = candidate(self.package)
        schema, unapplied = documents(current)
        previous = previous_sources(fix.load_replacements(self.tables))
        add_guard_caches(schema, unapplied, previous)
        _, queries, _ = fix.query_index(schema, unapplied)
        for name, text in previous.items():
            cache = json.loads(queries[name]["lastLoadedAsTableFormulaText"])
            cache["RootFormulaText"] = text
            queries[name]["lastLoadedAsTableFormulaText"] = json.dumps(cache)
        self.assert_migration(package_from_documents(current, schema, unapplied), previous)

    def test_historical_acceptance_is_scoped_to_query_and_profile(self):
        replacements = fix.load_replacements(self.tables)
        previous = previous_sources(replacements)
        original_profile = fix.ACTIVE_PROFILE
        try:
            for profile in ("direct", "fabric"):
                fix.activate_profile(profile)
                active_replacements = fix.load_replacements(self.tables)
                for source_name, text in previous.items():
                    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
                    for target in fix.QUERY_NAMES:
                        with self.subTest(profile=profile, source=source_name, target=target):
                            allowed_previous = digest in fix.PROFILES[profile].get("previous_sha256", {}).get(target, ())
                            if profile == "direct" and target == source_name:
                                fix.check_anchor(target, text, active_replacements, "historical fixture")
                            elif allowed_previous and target == source_name:
                                fix.check_anchor(target, text, active_replacements, "profile prior source")
                            else:
                                # Fabric's current inline source equals the Direct prior
                                # repair. Exact replacement acceptance is legitimate, but
                                # must not authorize that hash as history in this profile.
                                guarded_replacements = active_replacements
                                if text == active_replacements[target]:
                                    fix.check_anchor(target, text, active_replacements, "exact current source")
                                    guarded_replacements = {**active_replacements, target: text + "\n"}
                                with self.assertRaisesRegex(fix.PatchError, "unsupported source"):
                                    fix.check_anchor(target, text, guarded_replacements, "wrong historical scope")
        finally:
            fix.activate_profile(original_profile)

    def test_known_original_anchor_and_mixed_historical_migration(self):
        # Small genuine original source, not a mocked digest or patched allow-list.
        original = ("// One defensive load shared with Org Attribute, so both see the same\n"
                    "// normalised columns whatever the tenant's export looks like.\nOrgNormalised")
        digest = "b713d64139de5d7c27fbbbd8baff38a9646f2d79321a607273257896327a2f43"
        self.assertEqual(hashlib.sha256(original.encode("utf-8")).hexdigest(), digest)
        self.assertEqual(fix.ORIGINAL_SHA256["Org"], digest)
        replacements = fix.load_replacements(self.tables)
        fix.check_anchor("Org", original, replacements, "captured original")
        with self.assertRaisesRegex(fix.PatchError, "unsupported source"):
            fix.check_anchor("Org", original + " ", replacements, "modified original")
        current, _ = candidate(self.package)
        schema, unapplied = documents(current)
        sources = {**previous_sources(replacements), "Org": original}
        replace_document_sources(schema, unapplied, sources)
        add_guard_caches(schema, unapplied, sources)
        self.assert_migration(package_from_documents(current, schema, unapplied), sources)

    def test_one_character_current_and_historical_tampering_is_atomic(self):
        replacements = fix.load_replacements(self.tables)
        previous = previous_sources(replacements)
        current, _ = candidate(self.package)
        for revision, sources in (("historical", previous), ("current", replacements)):
            base_schema, base_unapplied = documents(current)
            replace_document_sources(base_schema, base_unapplied, sources)
            add_guard_caches(base_schema, base_unapplied, sources)
            for name, text in sources.items():
                tampered = ("L" if text[0] != "L" else "l") + text[1:]
                self.assertEqual(sum(a != b for a, b in zip(text, tampered)), 1)
                for location in ("model-and-query", "model-only", "query-only", "cache-root", "cache-reference"):
                    with self.subTest(revision=revision, query=name, location=location):
                        schema, unapplied = copy.deepcopy((base_schema, base_unapplied))
                        holders, queries, _ = fix.query_index(schema, unapplied)
                        if location in ("model-and-query", "model-only"):
                            holders[name]["expression"] = tampered.split("\n")
                        if location in ("model-and-query", "query-only"):
                            queries[name]["text"] = tampered.split("\n")
                        if location.startswith("cache-"):
                            owner = name if location == "cache-root" else "VivaSeatRosterFromMetrics"
                            cache = json.loads(queries[owner]["lastLoadedAsTableFormulaText"])
                            if location == "cache-root":
                                cache["RootFormulaText"] = tampered
                            else:
                                cache["ReferencedQueriesFormulaText"][name] = tampered
                            queries[owner]["lastLoadedAsTableFormulaText"] = json.dumps(cache)
                        message = ("source mismatch" if location in ("model-only", "query-only")
                                   else "unsupported source")
                        self.assert_rejected_atomically(schema, unapplied, replacements, message)

    def test_unknown_cache_reference_is_atomic(self):
        replacements = fix.load_replacements(self.tables)
        schema, unapplied = documents(self.package)
        previous = previous_sources(replacements)
        replace_document_sources(schema, unapplied, previous)
        add_guard_caches(schema, unapplied, previous)
        _, queries, _ = fix.query_index(schema, unapplied)
        query = queries["VivaSeatRosterFromMetrics"]
        cache = json.loads(query["lastLoadedAsTableFormulaText"])
        cache["ReferencedQueriesFormulaText"]["UnknownRegressionQuery"] = "let x = 1 in x"
        query["lastLoadedAsTableFormulaText"] = json.dumps(cache)
        self.assert_rejected_atomically(schema, unapplied, replacements, "unsupported cached reference")

    def test_unsupported_datamashup_guard(self):
        for name in ("DataMashup", "nested/dAtAmAsHuP"):
            with self.subTest(part=name):
                stream = io.BytesIO()
                with zipfile.ZipFile(stream, "w") as archive:
                    archive.writestr(name, b"synthetic unsupported mashup")
                with self.assertRaisesRegex(fix.PatchError, "DataMashup"):
                    fix.Package(stream.getvalue())


def clean(value):
    return str(value).strip() or None if value is not None else None


IDENTIFIERS = (("PersonId", "PersonIdNormalized"), ("UserPrincipalName", "UPN"),
               ("EntraId", "AAD"), ("PeopleHistoricalId", "PHID"))


def identities(row):
    return {(kind, clean(row.get(alias)).lower()) for kind, aliases in enumerate(IDENTIFIERS)
            for alias in aliases if clean(row.get(alias)) is not None}


def reference(rows, enrichment=()):
    """Small REFERENCE oracle: identity components, roster spine, attribute overlay."""
    components = []
    for row in rows:
        merged = identities(row)
        if not merged:
            raise ValueError("Missing identity")
        touching = [c for c in components if c & merged]
        components = [c for c in components if not c & merged]
        components.append(merged.union(*touching))
    index, totals, attrs = {}, {}, {}
    for component in components:
        if sum(kind == 0 for kind, _ in component) > 1:
            raise ValueError("Ambiguous explicit PersonIds")
        key = next((clean(r.get(a)).lower() for r in rows for a in IDENTIFIERS[1]
                    if clean(r.get(a)) and (1, clean(r[a]).lower()) in component), None)
        key = key or sorted(component)[0][1]
        if key in totals:
            raise ValueError("Ambiguous roster key")
        index.update({alias: key for alias in component})
        totals[key], attrs[key] = 0, {}
    for row in rows:
        key = index[next(iter(identities(row)))]
        totals[key] += row.get("CreditsUsed", 0)
        for name, value in row.items():
            if name in {"Department", "Organisation", "Organization", "City", "Custom"} and clean(value):
                attrs[key].setdefault("Organisation" if name == "Organization" else name, clean(value))
    crosswalk = {alias: {key} for alias, key in index.items()}
    for row in enrichment:
        targets = {index[i] for i in identities(row) if i in index}
        for alias in identities(row):
            crosswalk.setdefault(alias, set()).update(targets)
    for row in enrichment:
        targets = set().union(*(crosswalk.get(i, set()) for i in identities(row)))
        if len(targets) == 1:
            key = next(iter(targets))
            for name, value in row.items():
                if name in {"Department", "Organisation", "Organization", "City", "Custom"} and clean(value):
                    attrs[key]["Organisation" if name == "Organization" else name] = clean(value)
    return totals, attrs


def grouped(totals, attrs, attribute):
    result = {}
    for key, used in totals.items():
        label = attrs[key].get(attribute) or "(Not set)"
        result[label] = result.get(label, 0) + used
    return result


def identity(value):
    value = clean(value)
    return value.lower() if value is not None else None


def roster_keys(roster):
    """Requirements oracle accepts raw nullable/blank UPNs, never builds a roster."""
    result = {}
    for row in roster:
        person = identity(row["PersonId"])
        if person is None:
            raise ValueError("Missing roster PersonId")
        result[person] = identity(row.get("userPrincipalName")) or person
    return result


def phid_reference(metrics, roster, enrichment):
    """Synthetic optional PHID enrichment; conflicting evidence is not a mapping."""
    keys, mapping = roster_keys(roster), {}
    for row in metrics:
        person, phid = identity(row.get("PersonId")), identity(row.get("PeopleHistoricalId"))
        if person in keys and phid is not None:
            mapping.setdefault(phid, set()).add(keys[person])
    result = []
    for row in enrichment:
        phids = {identity(row.get(alias)) for alias in ("PeopleHistoricalId", "PersonHistoricalId", "PHID")
                 if identity(row.get(alias)) is not None}
        matches = mapping.get(next(iter(phids)), set()) if len(phids) == 1 else set()
        if len(matches) == 1:
            result.append({**row, "UserPrincipalName": next(iter(matches))})
    return result


def explicit_roster_reference(metrics, roster, enrichment=()):
    """Synthetic Python requirements, not M evaluation or connector simulation.

    Inputs are already reconciled metrics plus an independently supplied roster.
    Inline attributes coalesce by PersonId; the final org spine uses resolved keys.
    Enrichment exercises shared-identifier resolution and ambiguity independently.
    """
    keys = roster_keys(roster)
    id_names = {alias for aliases in IDENTIFIERS for alias in aliases} | {"userPrincipalName"}
    non_attributes = id_names | {"Week", "CreditsUsed", "SessionCount", "ServiceName", "PolicyName"}
    attributes = {name for row in metrics for name in row if name not in non_attributes}
    totals, by_person = {}, {person: {} for person in keys}
    crosswalk = {}
    for row in metrics:
        person = identity(row["PersonId"])
        target = keys[person]
        totals[target] = totals.get(target, 0) + row.get("CreditsUsed", 0)
        for name in attributes:
            if clean(row.get(name)) is not None:
                by_person[person].setdefault(name, clean(row[name]))
        for name in id_names:
            alias = identity(row.get(name))
            if alias is not None:
                crosswalk.setdefault(alias, set()).add(target)
        crosswalk.setdefault(target, set()).add(target)
    live = {name for values in by_person.values() for name in values}
    inline = ([{"PersonId": person, "UserPrincipalName": key,
                **{name: by_person[person].get(name) for name in live}}
               for person, key in keys.items()] if live else [])
    attrs = {key: {} for key in keys.values()}
    for row in inline:
        for name in live:
            if row[name] is not None:
                canonical = "Organisation" if name == "Organization" else name
                attrs[row["UserPrincipalName"]].setdefault(canonical, row[name])
    base = copy.deepcopy(crosswalk)
    for row in enrichment:
        ids = {identity(row.get(name)) for name in id_names} - {None}
        targets = set().union(*(base.get(i, set()) for i in ids))
        for alias in ids:
            crosswalk.setdefault(alias, set()).update(targets)
    for row in enrichment:
        ids = {identity(row.get(name)) for name in id_names} - {None}
        targets = set().union(*(crosswalk.get(i, set()) for i in ids))
        if len(targets) == 1:
            target = next(iter(targets))
            for name, value in row.items():
                if name not in non_attributes and clean(value) is not None:
                    attrs[target]["Organisation" if name == "Organization" else name] = clean(value)
    return totals, attrs, inline


class ExplicitRosterFixtures(unittest.TestCase):
    def test_nullable_and_blank_upn_keeps_person_and_arbitrary_inline_attributes(self):
        for upn in (None, "", " \t "):
            for custom in ("Research Cohort", "ResolvedKey", "__attributes", "roster"):
                with self.subTest(upn=upn, custom=custom):
                    rows = [{"PersonId": "p", "Department": " Dept ", "Organisation": " Org ",
                             custom: " Custom value ", "CreditsUsed": 11}]
                    roster = [{"PersonId": "p", "userPrincipalName": upn}]
                    snapshot = copy.deepcopy((rows, roster))
                    totals, attrs, inline = explicit_roster_reference(rows, roster)
                    expected = {"Department": "Dept", "Organisation": "Org", custom: "Custom value"}
                    self.assertEqual(totals, {"p": 11})
                    self.assertEqual(attrs, {"p": expected})
                    self.assertEqual(inline, [{"PersonId": "p", "UserPrincipalName": "p", **expected}])
                    for name, value in expected.items():
                        self.assertEqual(grouped(totals, attrs, name), {value: 11})
                    self.assertEqual((rows, roster), snapshot, "Oracle must not rewrite inputs")

    def test_mixed_known_and_unresolved_keys_preserve_people_and_totals(self):
        metrics = [
            {"PersonId": "p1", "Department": "D", "Organisation": "O", "CreditsUsed": 60},
            {"PersonId": "p2", "Department": "D", "Organisation": "O", "CreditsUsed": 30},
            {"PersonId": "p3", "Department": None, "CreditsUsed": 20},
        ]
        roster = [{"PersonId": "p1", "userPrincipalName": " Known@Example "},
                  {"PersonId": "p2", "userPrincipalName": None},
                  {"PersonId": "p3", "userPrincipalName": " "}]
        totals, attrs, inline = explicit_roster_reference(metrics, roster)
        self.assertEqual(totals, {"known@example": 60, "p2": 30, "p3": 20})
        self.assertEqual(set(attrs), set(totals))
        self.assertEqual(len(inline), 3)
        self.assertEqual(grouped(totals, attrs, "Department"), {"D": 90, "(Not set)": 20})
        self.assertEqual(grouped(totals, attrs, "Organisation"), {"O": 90, "(Not set)": 20})

    def test_all_blank_inline_attributes_preserve_spine(self):
        for value in (None, "", " \t"):
            with self.subTest(value=value):
                metrics = [{"PersonId": "p", "Department": value, "Organisation": value,
                            "Research Cohort": value, "CreditsUsed": 11}]
                totals, attrs, inline = explicit_roster_reference(
                    metrics, [{"PersonId": "p", "userPrincipalName": None},
                              {"PersonId": "spine-only", "userPrincipalName": ""}])
                self.assertEqual(inline, [], "No live inline table is a legitimate result")
                self.assertEqual(attrs, {"p": {}, "spine-only": {}})
                for name in ("Department", "Organisation", "Research Cohort"):
                    self.assertEqual(grouped(totals, attrs, name), {"(Not set)": 11})

    def test_repeated_weeks_keep_one_person_and_group_totals(self):
        metrics = [{"PersonId": "p", "Week": 1, "Department": "D", "Organisation": None,
                    "Research Cohort": "X", "CreditsUsed": 60},
                   {"PersonId": "p", "Week": 2, "Department": "", "Organisation": "O",
                    "Research Cohort": None, "CreditsUsed": 50}]
        for upn, key in ((None, "p"), ("", "p"), (" ", "p"), (" U@Example ", "u@example")):
            for reverse in (False, True):
                with self.subTest(upn=upn, reverse=reverse):
                    totals, attrs, inline = explicit_roster_reference(
                        metrics[::-1] if reverse else metrics,
                        [{"PersonId": "p", "userPrincipalName": upn}])
                    self.assertEqual(totals, {key: 110})
                    self.assertEqual(len(inline), 1, "No weekly fan-out before person ranking")
                    for name, label in (("Department", "D"), ("Organisation", "O"), ("Research Cohort", "X")):
                        self.assertEqual(grouped(totals, attrs, name), {label: 110})

    def test_unresolved_base_crosswalk_enriches_without_new_consumption_key(self):
        metrics = [{"PersonId": "p", "EntraId": "aad", "CreditsUsed": 42}]
        totals, attrs, _ = explicit_roster_reference(
            metrics, [{"PersonId": "p", "userPrincipalName": None}],
            [{"AAD": " AAD ", "UPN": "new@example"},
             {"UPN": " NEW@EXAMPLE ", "Department": "Linked", "Organisation": "Org"}])
        self.assertEqual(totals, {"p": 42})
        self.assertEqual(attrs, {"p": {"Department": "Linked", "Organisation": "Org"}})

    def test_phid_falls_back_to_personid_and_known_upn_wins(self):
        metrics = [{"PersonId": " P ", "PeopleHistoricalId": " H ", "CreditsUsed": 60},
                   {"PersonId": " P ", "PeopleHistoricalId": "h", "CreditsUsed": 50}]
        for upn, key in ((None, "p"), ("", "p"), (" \t", "p"), (" U@Example ", "u@example")):
            with self.subTest(upn=upn):
                roster = [{"PersonId": " P ", "userPrincipalName": upn}]
                source = [{"PHID": " H ", "Department": "D", "Organisation": "O", "Research Cohort": "X"}]
                enriched = phid_reference(metrics, roster, source)
                self.assertEqual(enriched, [{**source[0], "UserPrincipalName": key}])
                totals, attrs, inline = explicit_roster_reference(metrics, roster, enriched)
                self.assertEqual(inline, [])
                self.assertEqual(totals, {key: 110})
                for name, label in (("Department", "D"), ("Organisation", "O"), ("Research Cohort", "X")):
                    self.assertEqual(grouped(totals, attrs, name), {label: 110})

    def test_phid_and_crosswalk_ambiguities_still_do_not_choose_a_person(self):
        metrics = [{"PersonId": "a", "PeopleHistoricalId": "shared", "CreditsUsed": 60},
                   {"PersonId": "b", "PeopleHistoricalId": "shared", "CreditsUsed": 50},
                   {"PersonId": "a", "PeopleHistoricalId": "unique", "CreditsUsed": 0}]
        roster = [{"PersonId": "a", "userPrincipalName": None},
                  {"PersonId": "b", "userPrincipalName": " Known@Example "}]
        rejected = [{"PHID": "shared", "Department": "Wrong"},
                    {"PHID": "unique", "PeopleHistoricalId": "different", "Department": "Wrong"},
                    {"PHID": "unknown", "Department": "Wrong"},
                    {"PHID": " ", "Department": "Wrong"}]
        self.assertEqual(phid_reference(metrics, roster, rejected), [])
        self.assertEqual(phid_reference(metrics, roster, [{"PHID": " UNIQUE ", "Department": "Right"}]),
                         [{"PHID": " UNIQUE ", "Department": "Right", "UserPrincipalName": "a"}])
        totals, attrs, _ = explicit_roster_reference(
            metrics, roster, [{"PersonId": "a", "UPN": "shared-upn"},
                              {"PersonId": "b", "UPN": "shared-upn"},
                              {"UPN": "shared-upn", "Department": "Wrong"}])
        self.assertEqual(attrs, {"a": {}, "known@example": {}})
        self.assertEqual(grouped(totals, attrs, "Department"), {"(Not set)": 110})


class ReferenceFixtures(unittest.TestCase):
    def test_single_identity_variants(self):
        for alias in ("PersonId", "UPN", "EntraId", "PHID"):
            with self.subTest(alias=alias):
                self.assertEqual(reference([{alias: " A ", "CreditsUsed": 7}])[0], {"a": 7})

    def test_null_columns_fall_through(self):
        for alias in ("PersonId", "UPN", "EntraId", "PHID"):
            with self.subTest(alias=alias):
                row = {aliases[0]: None for aliases in IDENTIFIERS}
                row.update({alias: " X ", "CreditsUsed": 9})
                self.assertEqual(reference([row])[0], {"x": 9})
        self.assertEqual(reference([{"PersonId": None, "UserPrincipalName": " ",
                                     "UPN": " X ", "CreditsUsed": 9}])[0], {"x": 9})
        self.assertEqual(reference([{"PersonId": None, "PersonIdNormalized": " P ",
                                     "EntraId": None, "PHID": "h", "CreditsUsed": 9}])[0], {"p": 9})

    def test_repeated_weeks_partial_pid_aggregate_110_once(self):
        for reverse in (False, True):
            rows = [{"PersonId": "p", "UPN": " U@Example ", "CreditsUsed": 60, "Week": 1},
                    {"PersonId": None, "UPN": "u@example", "CreditsUsed": 50, "Week": 2}]
            totals, attrs = reference(rows[::-1] if reverse else rows)
            self.assertEqual(totals, {"u@example": 110})
            self.assertEqual(len(totals), 1, "One person before intensity ranking, not two groups")
            self.assertEqual(grouped(totals, attrs, "Department"), {"(Not set)": 110})

    def test_no_org_attributes_still_has_all_users(self):
        totals, attrs = reference([{"PersonId": "p", "CreditsUsed": 20}, {"PHID": "h", "CreditsUsed": 30}])
        self.assertEqual(set(attrs), {"p", "h"})
        self.assertEqual(grouped(totals, attrs, "City"), {"(Not set)": 50})

    def test_distinct_organisation_department_and_alias(self):
        totals, attrs = reference([{"PersonId": "p", "Organisation": "Org", "Department": "Dept"}])
        self.assertEqual(attrs["p"], {"Organisation": "Org", "Department": "Dept"})
        self.assertEqual(reference([{"PersonId": "p", "Organization": "US alias"}])[1]["p"]["Organisation"], "US alias")

    def test_entra_per_attribute_wins_extra_and_blank_fallback(self):
        totals, attrs = reference([{"UPN": "u", "Department": "Inline", "City": "Dublin", "Custom": "one"}],
                                 [{"UPN": " U ", "Department": "Entra", "City": " ", "Custom": "two",
                                   "Organization": "Entra-only"}])
        self.assertEqual(attrs["u"], {"Department": "Entra", "City": "Dublin",
                                     "Custom": "two", "Organisation": "Entra-only"})

    def test_aad_to_upn_crosswalk_with_shared_identifier(self):
        totals, attrs = reference([{"EntraId": "a", "CreditsUsed": 42}],
                                 [{"AAD": " A ", "UPN": "u"}, {"UPN": " U ", "Department": "Linked"}])
        self.assertEqual(grouped(totals, attrs, "Department"), {"Linked": 42})

    def test_ambiguous_mapping_not_arbitrary(self):
        totals, attrs = reference([{"PersonId": "a"}, {"PersonId": "b"}],
                                 [{"PersonId": "a", "UPN": "shared"},
                                  {"PersonId": "b", "UPN": "shared"},
                                  {"UPN": "shared", "Department": "Wrong"}])
        self.assertTrue(all("Department" not in a for a in attrs.values()))
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            reference([{"PersonId": "a", "UPN": "u"}, {"PersonId": "b", "UPN": "u"}])
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            reference([{"PersonId": "a"}, {"UPN": "a"}])

    def test_missing_identity_rejected(self):
        with self.assertRaisesRegex(ValueError, "Missing"):
            reference([{"PersonId": None, "UPN": " ", "CreditsUsed": 1}])

    def test_totals_preserved_across_groups_and_blank_attributes(self):
        totals, attrs = reference([{"PersonId": "a", "Department": "D", "Custom": "X", "CreditsUsed": 60},
                                  {"PersonId": "b", "Department": "", "City": "C", "CreditsUsed": 50}])
        for attribute in ("Department", "Organisation", "City", "Custom"):
            self.assertEqual(sum(grouped(totals, attrs, attribute).values()), 110)
        self.assertEqual(grouped(totals, attrs, "Department"), {"D": 60, "(Not set)": 50})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", nargs="?", type=Path, default=fix.DEFAULT_PATH)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--in-memory-patched", action="store_true")
    args = parser.parse_args()
    try:
        original = fix.Package(args.path.read_bytes())
        PackageContracts.input_package = original
        PackageContracts.package = original
        if args.baseline:
            PackageContracts.baseline = fix.Package(args.baseline.read_bytes())
        if args.in_memory_patched:
            PackageContracts.package, _ = candidate(original)
            PackageContracts.baseline = PackageContracts.baseline or original
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        parser.exit(2, f"Cannot load/prepare package: {exc}\n")
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(f"Tests={result.testsRun}; failures={len(result.failures)}; errors={len(result.errors)}; "
          f"skipped={len(result.skipped)}. Failures may include individual structural subtests.")
    if result.failures:
        names = sorted({test.id().split(" (", 1)[0] for test, _ in result.failures})
        print("Failing contracts:\n  " + "\n  ".join(names))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
