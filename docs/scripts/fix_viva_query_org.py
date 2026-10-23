"""Guarded, standard-library-only patcher for the six Viva organisation queries.

Replacement M lives in viva_query_org/<query name>.m beside this script, encoded
as UTF-8 (optional BOM). Line endings are normalized to LF; trailing newlines
are retained. Org.m must contain exactly one __ORG_SOURCE_COLUMNS__ placeholder.

Without --output, a validated scratch archive atomically replaces --path.
--output must name a new, separate file. --dry-run performs all in-memory
validation without writing anything. An already patched input is left byte
identical (and copied byte identically when --output is supplied).

This edits no DataMashup: any such part is rejected. Only classic single-disk
ZIP archives are supported, not ZIP64, encrypted archives or signed central
directories. Unchanged local records, compressed payloads and metadata are
copied verbatim. Changed parts retain their header metadata, except CRC/sizes;
central-directory offsets and the end record necessarily track the new layout.
M is not executed or syntax-checked; Desktop refresh validation is separate.
"""

import argparse
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import uuid
import zipfile
import zlib


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit"
REPLACEMENT_ROOT = Path(__file__).resolve().parent
PARTS = ("DataModelSchema", "UnappliedChanges")
PLACEHOLDER = "__ORG_SOURCE_COLUMNS__"
PROFILES = {
    "direct": {
        "replacement_dir": "viva_query_org",
        "expression_names": (
            "VivaCreditMetrics", "VivaOrgFromMetrics", "VivaOrgAttributes", "OrgNormalised",
        ),
        "partition_names": ("Org", "CreditsWeekly"),
        # SHA256 of the original sources joined with LF, encoded as UTF-8, without
        # stripping whitespace. Captured directly from the original PBIT on 2026-09-10.
        "original_sha256": {
            "VivaCreditMetrics": "7c6e2b3203c40ddcf5f90c03d4375a25186be2adce2ed9afb70e6ce8026211d8",
            "VivaOrgFromMetrics": "5808d26f8fcf53a72e83f83c3331b00afb96a4f1edcc6521ca506194827d5162",
            "VivaOrgAttributes": "3aaa57682bd4a211c1bb9a70439cd166e614812fe05ed125d0b15694fbd59ca3",
            "OrgNormalised": "47ea38979414bb910a9389bed474b40cfe8c693b0ba4cd40c6523edec241f3d9",
            "Org": "b713d64139de5d7c27fbbbd8baff38a9646f2d79321a607273257896327a2f43",
            "CreditsWeekly": "16d92f31d66c0a93d60dd2adde9d45e3d9c9d51d8099985c45490a96ed83f878",
        },
        # Exact pre-fallback repair sources captured from the already patched
        # Viva Direct PBIT on 2026-09-10, plus the pre-performance repair
        # revision. No other historical revisions are accepted.
        "previous_sha256": {
            "VivaCreditMetrics": ("679d7b773d70f49d4b83e96c68b2b957b82c58cb7c9593588132c68b32f5653b",),
            "VivaOrgFromMetrics": (
                "2a275ab05362f73d5d90dfb8aff141dcfadc782524b6d259e15865c2b18faa36",
                "4597da3450a6f90fcfe193db09f5bac412929ea7a1c46d38663b9f2149615ddb",
            ),
            "VivaOrgAttributes": (
                "c83317c04ae758a63e7483ba9f4207ecd8f07702dab018ea7757b53b174a0d5d",
                "299310e3069105d68fabacf2d9e23d0ffba66b5b860a1546e45bbb2296b41a2f",
            ),
            "OrgNormalised": (
                "366b7832441c1162fa699f807b73e22b06f3298afb889fe83286594d5b63084a",
                "90cb52b38541fb2bb268d48e492af230aaf40deefb4e503fafca152126b56ee6",
                # Before PAX's Entra aliases (docs/scripts/fix_viva_direct_sources.py).
                "04e88e974a8778603ac3c93944e2cf4847c1b6b48cd668ca0c5c3421ed516214",
            ),
        },
    },
    "fabric": {
        "replacement_dir": "fabric_query_org",
        "expression_names": (
            "VivaCreditMetrics", "VivaOrgFromMetrics", "VivaOrgFromPeople", "OrgNormalised",
        ),
        "partition_names": ("Org", "CreditsWeekly"),
        "original_sha256": {
            "VivaCreditMetrics": "1a88205e981a2e1c749705870d11389eb5e55e7297c02b5ee4b22d171b738907",
            "VivaOrgFromMetrics": "c95ac1beb454849a74e97a3b7f301a17880780cfaff790c149cecfcfdc578e01",
            "VivaOrgFromPeople": "621d6adb17001815db07eec7f2edb80abc38c5797141b83d524e23e50db9f7eb",
            "OrgNormalised": "e1691ae5f93f4bcbd337bd7bbaaac99eb2d1d027d085e4190b1115ab009c8aa9",
            "Org": "b713d64139de5d7c27fbbbd8baff38a9646f2d79321a607273257896327a2f43",
            "CreditsWeekly": "16d92f31d66c0a93d60dd2adde9d45e3d9c9d51d8099985c45490a96ed83f878",
        },
        "previous_sha256": {
            "VivaOrgFromMetrics": ("2a275ab05362f73d5d90dfb8aff141dcfadc782524b6d259e15865c2b18faa36",),
            "OrgNormalised": ("36910cedfc5326e679481a30d07acc343812f4949dbf99ca88d8afe332f4e996",),
        },
    },
}
ACTIVE_PROFILE = None
REPLACEMENT_DIR = None
EXPRESSION_NAMES = ()
PARTITION_NAMES = ()
QUERY_NAMES = ()
ORIGINAL_SHA256 = {}


def activate_profile(name):
    global ACTIVE_PROFILE, REPLACEMENT_DIR, EXPRESSION_NAMES, PARTITION_NAMES, QUERY_NAMES, ORIGINAL_SHA256
    require(name in PROFILES, f"Unknown patch profile: {name}")
    profile = PROFILES[name]
    ACTIVE_PROFILE = name
    REPLACEMENT_DIR = REPLACEMENT_ROOT / profile["replacement_dir"]
    EXPRESSION_NAMES = tuple(profile["expression_names"])
    PARTITION_NAMES = tuple(profile["partition_names"])
    QUERY_NAMES = EXPRESSION_NAMES + PARTITION_NAMES
    ORIGINAL_SHA256 = dict(profile["original_sha256"])
    return profile


def detect_profile(schema):
    model = schema.get("model")
    require(isinstance(model, dict), "DataModelSchema: missing model")
    expression_names = {item.get("name") for item in model.get("expressions", []) if isinstance(item, dict)}
    table_names = {item.get("name") for item in model.get("tables", []) if isinstance(item, dict)}
    if {"VivaOrgAttributes", "VivaConnectorSource"} <= expression_names and {"Org", "CreditsWeekly"} <= table_names:
        return "direct"
    if {"VivaOrgFromPeople"} <= expression_names and {"Org", "CreditsWeekly"} <= table_names:
        return "fabric"
    raise PatchError(f"Unsupported package profile; expressions={sorted(expression_names)}")

class PatchError(ValueError):
    """An unsupported or inconsistent input, with no destination published."""


def require(condition, message):
    if not condition:
        raise PatchError(message)


activate_profile("direct")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key!r}")
        result[key] = value
    return result


def reject_constant(value):
    raise PatchError(f"Non-JSON numeric constant: {value}")


def parse_json(text, label):
    try:
        return json.loads(
            text, object_pairs_hook=unique_object, parse_constant=reject_constant,
        )
    except (ValueError, TypeError) as exc:
        raise PatchError(f"{label}: invalid JSON: {exc}") from exc


def decode_part(raw, label):
    require(len(raw) % 2 == 0, f"{label}: expected UTF-16LE bytes")
    bom = raw.startswith(b"\xff\xfe")
    payload = raw[2:] if bom else raw
    try:
        text = payload.decode("utf-16le")
    except UnicodeError as exc:
        raise PatchError(f"{label}: not UTF-16LE") from exc
    value = parse_json(text, label)
    require(isinstance(value, dict), f"{label}: expected JSON object")
    return value, bom


def encode_part(value, bom):
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (b"\xff\xfe" if bom else b"") + text.encode("utf-16le")


def named_objects(value, label):
    require(isinstance(value, list), f"{label}: expected list")
    result = {}
    folded = set()
    for item in value:
        require(isinstance(item, dict), f"{label}: expected object")
        name = item.get("name")
        require(isinstance(name, str) and bool(name), f"{label}: missing name")
        require(name.casefold() not in folded, f"{label}: duplicate name {name!r}")
        folded.add(name.casefold())
        result[name] = item
    return result


def source_text(value, label):
    if isinstance(value, str):
        return value
    require(
        isinstance(value, list) and bool(value)
        and all(isinstance(line, str) and "\n" not in line and "\r" not in line
                for line in value),
        f"{label}: expected string or list of source lines",
    )
    return "\n".join(value)


def query_index(schema, unapplied):
    model = schema.get("model")
    require(isinstance(model, dict), "DataModelSchema: missing model")
    expressions = named_objects(model.get("expressions"), "model.expressions")
    tables = named_objects(model.get("tables"), "model.tables")
    queries = named_objects(unapplied.get("queries"), "UnappliedChanges.queries")
    holders = {}
    folded = set()

    def add(name, holder):
        require(name.casefold() not in folded, f"Duplicate model query: {name}")
        source_text(holder.get("expression"), f"Model query {name}")
        folded.add(name.casefold())
        holders[name] = holder

    for name, expression in expressions.items():
        require(expression.get("kind") == "m", f"{name}: expected M expression")
        add(name, expression)
    for name, table in tables.items():
        partitions = named_objects(table.get("partitions"), f"{name}.partitions")
        require(bool(partitions), f"{name}: no partitions")
        for partition in partitions.values():
            source = partition.get("source")
            require(isinstance(source, dict), f"{name}: missing partition source")
            require(source.get("type") in ("m", "calculated", "calculationGroup"),
                    f"{name}: unsupported partition source type")
        mashup = [p for p in partitions.values() if p["source"]["type"] == "m"]
        if mashup:
            require(len(partitions) == 1, f"{name}: expected single M partition")
            add(name, mashup[0]["source"])
    require(set(holders) == set(queries),
            "Model/UnappliedChanges query names differ: "
            f"{sorted(set(holders) ^ set(queries))}")
    for name, holder in holders.items():
        require(isinstance(queries[name].get("text"), list),
                f"{name}: UnappliedChanges.text must be a list")
        require(source_text(holder["expression"], name)
                == source_text(queries[name]["text"], name),
                f"{name}: schema/UnappliedChanges source mismatch")
    for name in EXPRESSION_NAMES:
        require(name in expressions, f"{name}: missing model expression")
    for name in PARTITION_NAMES:
        require(name in tables and name in holders and name not in expressions,
                f"{name}: missing single M table partition")
    for name in QUERY_NAMES:
        require(isinstance(holders[name]["expression"], list),
                f"{name}: expected original list-shaped M source")
    return holders, queries, tables


def m_string(value):
    escaped = []
    for char in value:
        code = ord(char)
        require(not 0xD800 <= code <= 0xDFFF, "Org sourceColumn: unpaired surrogate")
        if char == '"':
            escaped.append('""')
        elif char == "#":
            escaped.append("#(#)")
        elif code < 32 or code == 127:
            escaped.append(f"#({code:04x})")
        else:
            escaped.append(char)
    return '"' + "".join(escaped) + '"'


def load_replacements(tables):
    columns = named_objects(tables["Org"].get("columns"), "Org.columns")
    source_columns = []
    for name, column in columns.items():
        if column.get("type") == "calculated":
            continue
        require(column.get("type", "data") == "data",
                f"Org.{name}: unsupported column type")
        source = column.get("sourceColumn")
        require(isinstance(source, str) and bool(source),
                f"Org.{name}: missing sourceColumn")
        require("expression" not in column, f"Org.{name}: ambiguous calculated column")
        source_columns.append(source)
    require(bool(source_columns), "Org: no source columns")
    require(len(set(source_columns)) == len(source_columns),
            "Org: duplicate sourceColumn names")
    column_list = "{" + ", ".join(m_string(name) for name in source_columns) + "}"
    replacements = {}
    for name in QUERY_NAMES:
        path = REPLACEMENT_DIR / f"{name}.m"
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            raise PatchError(f"Cannot load replacement {path}: {exc}") from exc
        require(bool(text.strip()) and "\x00" not in text,
                f"{path}: empty source or NUL character")
        if name == "Org":
            require(text.count(PLACEHOLDER) == 1,
                    f"{path}: expected exactly one {PLACEHOLDER}")
            text = text.replace(PLACEHOLDER, column_list)
        require(PLACEHOLDER not in text, f"{path}: unresolved Org placeholder")
        replacements[name] = text
    return replacements


def check_anchor(name, text, replacements, label):
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    previous = PROFILES[ACTIVE_PROFILE].get("previous_sha256", {}).get(name, ())
    require(text == replacements[name] or digest == ORIGINAL_SHA256[name] or digest in previous,
            f"{label}: unsupported source for {name}; SHA256={digest}; "
            "expected the captured original, an explicitly captured prior repair, or the exact replacement")


def read_caches(queries, replacements):
    caches = {}
    for name, query in queries.items():
        if "lastLoadedAsTableFormulaText" not in query:
            continue
        raw = query["lastLoadedAsTableFormulaText"]
        require(isinstance(raw, str), f"{name}: cached formula must be a JSON string")
        cache = parse_json(raw, f"{name}.lastLoadedAsTableFormulaText")
        require(isinstance(cache, dict), f"{name}: cached formula must be an object")
        root = cache.get("RootFormulaText")
        require(isinstance(root, str), f"{name}: invalid cached RootFormulaText")
        if "IncludesReferencedQueries" in cache:
            require(isinstance(cache["IncludesReferencedQueries"], bool),
                    f"{name}: invalid IncludesReferencedQueries")
        refs = cache.get("ReferencedQueriesFormulaText", {})
        require(isinstance(refs, dict),
                f"{name}: ReferencedQueriesFormulaText must map names to strings")
        for ref, text in refs.items():
            require(ref in queries and isinstance(text, str),
                    f"{name}: unsupported cached reference {ref!r}")
            if ref in replacements:
                check_anchor(ref, text, replacements, f"{name} cached reference")
        if name in replacements:
            check_anchor(name, root, replacements, f"{name} cached root")
        caches[name] = cache
    return caches


def patch_documents(schema, unapplied, replacements):
    # Complete the preflight before changing even the in-memory documents.
    holders, queries, _ = query_index(schema, unapplied)
    original_names = (tuple(holders), tuple(queries))
    for name in QUERY_NAMES:
        check_anchor(name, source_text(holders[name]["expression"], name),
                     replacements, "Model/UnappliedChanges")
    caches = read_caches(queries, replacements)
    changed = set()
    for name in QUERY_NAMES:
        text = replacements[name]
        if source_text(holders[name]["expression"], name) != text:
            holders[name]["expression"] = text.split("\n")
            queries[name]["text"] = text.split("\n")
            changed.add(name)
    for name, cache in caches.items():
        touched = False
        if name in replacements and cache["RootFormulaText"] != replacements[name]:
            cache["RootFormulaText"] = replacements[name]
            changed.add(name)
            touched = True
        for ref, text in cache.get("ReferencedQueriesFormulaText", {}).items():
            if ref in replacements and text != replacements[ref]:
                cache["ReferencedQueriesFormulaText"][ref] = replacements[ref]
                changed.add(ref)
                touched = True
        if touched:
            queries[name]["lastLoadedAsTableFormulaText"] = json.dumps(
                cache, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
            )
    final_holders, final_queries, _ = query_index(schema, unapplied)
    require((tuple(final_holders), tuple(final_queries)) == original_names,
            "Patching must not add, remove or reorder queries")
    return tuple(name for name in QUERY_NAMES if name in changed)


def check_extra(extra, label):
    position = 0
    while position < len(extra):
        require(position + 4 <= len(extra), f"{label}: malformed ZIP extra field")
        kind, length = struct.unpack_from("<HH", extra, position)
        require(kind != 1, f"{label}: ZIP64 is unsupported")
        position += 4 + length
        require(position <= len(extra), f"{label}: truncated ZIP extra field")


class Package:
    """Retain raw records instead of round-tripping ZipInfo through a writer."""

    def __init__(self, raw, parts=PARTS):
        # Callers that patch other parts - fix_slicer_defaults.py rewrites report
        # visuals - supply their own allow-list. The default keeps this script's
        # model-only guarantee.
        self.parts = tuple(parts)
        self.raw = raw
        lower_bound = max(0, len(raw) - 65557)
        end = raw.rfind(b"PK\x05\x06", lower_bound)
        while end >= 0:
            if end + 22 <= len(raw):
                comment_length = struct.unpack_from("<H", raw, end + 20)[0]
                if end + 22 + comment_length == len(raw):
                    break
            end = raw.rfind(b"PK\x05\x06", lower_bound, end)
        require(end >= 0 and end + 22 <= len(raw), "ZIP: missing end record")
        fields = struct.unpack_from("<4s4H2LH", raw, end)
        _, disk, cd_disk, disk_count, count, cd_size, cd_offset, comment_len = fields
        require(end + 22 + comment_len == len(raw), "ZIP: trailing data or bad comment")
        require(disk == cd_disk == 0 and disk_count == count,
                "ZIP: multi-disk archives are unsupported")
        require(count != 0xFFFF and cd_size != 0xFFFFFFFF and cd_offset != 0xFFFFFFFF,
                "ZIP: ZIP64 is unsupported")
        require(cd_offset + cd_size == end, "ZIP: unsupported central directory layout")
        self.cd_offset = cd_offset
        self.end_record = raw[end:]
        self.central = {}
        self.infos = {}
        self.contents = {}
        self.locals = {}
        self.payloads = {}
        position = cd_offset
        # zipfile itself mistakes an EOCD signature inside an archive comment for
        # the real end record. Hide only the comment in its read-only input.
        read_view = raw[:end + 20] + b"\x00\x00"
        self.comment = raw[end + 22:]
        with zipfile.ZipFile(io.BytesIO(read_view)) as archive:
            infos = archive.infolist()
            require(len(infos) == count, "ZIP: inconsistent entry count")
            require(archive.start_dir == cd_offset, "ZIP: adjusted offsets unsupported")
            folded = set()
            for info in infos:
                name = info.filename
                require(name.casefold() not in folded, f"ZIP: duplicate part {name}")
                require("\x00" not in info.orig_filename, "ZIP: NUL in part name")
                folded.add(name.casefold())
                basename = name.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
                require(basename.casefold() != "datamashup",
                        f"Unexpected DataMashup part: {name}")
                require(not info.flag_bits & (1 | 0x40 | 0x2000),
                        f"{name}: encrypted ZIP entry is unsupported")
                require(info.volume == 0, f"{name}: multi-disk ZIP entry")
                require(position + 46 <= end and raw[position:position + 4] == b"PK\x01\x02",
                        f"{name}: malformed central directory")
                name_len, extra_len, entry_comment_len = struct.unpack_from(
                    "<HHH", raw, position + 28,
                )
                record_end = position + 46 + name_len + extra_len + entry_comment_len
                require(record_end <= end, f"{name}: truncated central directory")
                record = raw[position:record_end]
                offset = struct.unpack_from("<L", record, 42)[0]
                require(offset == info.header_offset and offset < cd_offset,
                        f"{name}: inconsistent local offset")
                check_extra(info.extra, name)
                self.central[name] = record
                self.infos[name] = info
                # Reading every entry checks decompression and CRC before any write.
                self.contents[name] = archive.read(info)
                position = record_end
        require(position == end, "ZIP: extra central directory records unsupported")
        require(all(name in self.infos for name in self.parts), "ZIP: missing required parts")
        ordered = sorted(self.infos, key=lambda name: self.infos[name].header_offset)
        require(bool(ordered), "ZIP: empty archive")
        offsets = [self.infos[name].header_offset for name in ordered] + [cd_offset]
        require(len(set(offsets)) == len(offsets), "ZIP: overlapping local headers")
        self.local_order = ordered
        self.prefix = raw[:offsets[0]]
        for index, name in enumerate(ordered):
            info = self.infos[name]
            start, stop = offsets[index:index + 2]
            local = raw[start:stop]
            require(len(local) >= 30 and local[:4] == b"PK\x03\x04",
                    f"{name}: missing local header")
            flags, compression = struct.unpack_from("<HH", local, 6)
            require(flags == info.flag_bits and compression == info.compress_type,
                    f"{name}: local/central header mismatch")
            name_len, extra_len = struct.unpack_from("<HH", local, 26)
            header_size = 30 + name_len + extra_len
            payload_end = header_size + info.compress_size
            require(payload_end <= len(local), f"{name}: overlapping/truncated payload")
            central_name_len = struct.unpack_from("<H", self.central[name], 28)[0]
            require(local[30:30 + name_len]
                    == self.central[name][46:46 + central_name_len],
                    f"{name}: local/central filename mismatch")
            check_extra(local[30 + name_len:header_size], f"{name} local")
            if not flags & 8:
                require(struct.unpack_from("<LLL", local, 14)
                        == (info.CRC, info.compress_size, info.file_size),
                        f"{name}: local/central CRC or size mismatch")
            if name in self.parts:
                require(flags & ~0x800 == 0,
                        f"{name}: unsupported flags/data descriptor on changed part")
                require(compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        f"{name}: unsupported compression")
            self.locals[name] = local
            self.payloads[name] = (header_size, payload_end)

    def rebuild(self, updates):
        require(set(updates) <= set(self.parts), "Attempt to change an unexpected ZIP part")
        if not updates:
            return self.raw
        local_chunks = [self.prefix]
        offset = len(self.prefix)
        offsets = {}
        sizes = {}
        for name in self.local_order:
            offsets[name] = offset
            local = self.locals[name]
            if name in updates:
                content = updates[name]
                if self.infos[name].compress_type == zipfile.ZIP_DEFLATED:
                    compressor = zlib.compressobj(level=6, wbits=-15)
                    compressed = compressor.compress(content) + compressor.flush()
                else:
                    compressed = content
                values = (zlib.crc32(content) & 0xFFFFFFFF, len(compressed), len(content))
                require(max(values[1:]) < 0xFFFFFFFF, f"{name}: ZIP64 would be needed")
                sizes[name] = values
                header_size, payload_end = self.payloads[name]
                header = bytearray(local[:header_size])
                struct.pack_into("<LLL", header, 14, *values)
                local = bytes(header) + compressed + local[payload_end:]
            local_chunks.append(local)
            offset += len(local)
        central_chunks = []
        for name, original in self.central.items():
            require(offsets[name] < 0xFFFFFFFF, "ZIP64 offset would be needed")
            record = bytearray(original)
            struct.pack_into("<L", record, 42, offsets[name])
            if name in sizes:
                struct.pack_into("<LLL", record, 16, *sizes[name])
            central_chunks.append(bytes(record))
        central = b"".join(central_chunks)
        require(offset < 0xFFFFFFFF and len(central) < 0xFFFFFFFF,
                "ZIP64 central directory would be needed")
        end = bytearray(self.end_record)
        struct.pack_into("<LL", end, 12, len(central), offset)
        return b"".join(local_chunks) + central + bytes(end)


def validate_candidate(original, candidate_bytes, updates, replacements, expected):
    candidate = Package(candidate_bytes)
    require(list(original.infos) == list(candidate.infos), "Candidate changed ZIP parts/order")
    require(original.local_order == candidate.local_order, "Candidate changed local order")
    require(original.prefix == candidate.prefix and original.comment == candidate.comment,
            "Candidate changed archive prefix/comment")
    before_end, after_end = bytearray(original.end_record), bytearray(candidate.end_record)
    before_end[12:20] = after_end[12:20]
    require(before_end == after_end, "Candidate changed end-record metadata")
    for name in original.infos:
        before = bytearray(original.central[name])
        after = candidate.central[name]
        before[42:46] = after[42:46]
        if name in updates:
            before[16:28] = after[16:28]
            old_header_end, old_payload_end = original.payloads[name]
            new_header_end, new_payload_end = candidate.payloads[name]
            old_header = bytearray(original.locals[name][:old_header_end])
            new_header = candidate.locals[name][:new_header_end]
            old_header[14:26] = new_header[14:26]
            require(old_header == new_header, f"{name}: changed local metadata")
            require(original.locals[name][old_payload_end:]
                    == candidate.locals[name][new_payload_end:],
                    f"{name}: changed local trailer")
        else:
            require(original.locals[name] == candidate.locals[name],
                    f"{name}: changed raw local record/compressed bytes")
        require(before == after, f"{name}: changed central-directory metadata")
        require(candidate.contents[name] == updates.get(name, original.contents[name]),
                f"{name}: candidate content mismatch")
    schema, schema_bom = decode_part(candidate.contents[PARTS[0]], PARTS[0])
    unapplied, unapplied_bom = decode_part(candidate.contents[PARTS[1]], PARTS[1])
    require((schema, unapplied) == expected, "Candidate JSON does not match intended edits")
    for name, bom in zip(PARTS, (schema_bom, unapplied_bom)):
        require(bom == original.contents[name].startswith(b"\xff\xfe"),
                f"{name}: changed BOM convention")
    holders, queries, _ = query_index(schema, unapplied)
    caches = read_caches(queries, replacements)
    for name, text in replacements.items():
        require(source_text(holders[name]["expression"], name) == text,
                f"{name}: replacement missing in candidate")
    for name, cache in caches.items():
        if name in replacements:
            require(cache["RootFormulaText"] == replacements[name],
                    f"{name}: stale candidate cached root")
        for ref, text in cache.get("ReferencedQueriesFormulaText", {}).items():
            if ref in replacements:
                require(text == replacements[ref], f"{name}: stale candidate reference {ref}")


def patch(path, output=None, dry_run=False, profile="auto"):
    path = Path(path).resolve()
    require(path.is_file(), f"Source does not exist: {path}")
    require(profile in ("auto",) + tuple(PROFILES), f"Unknown profile: {profile}")
    if output is not None:
        output = Path(output).resolve()
        require(output != path, "--output must differ from --path")
        require(not output.exists(), f"Refusing to overwrite existing output: {output}")
        require(output.parent.is_dir(), f"Output directory does not exist: {output.parent}")
    raw = path.read_bytes()
    original = Package(raw)
    schema, schema_bom = decode_part(original.contents[PARTS[0]], PARTS[0])
    detected = detect_profile(schema)
    if profile != "auto":
        require(profile == detected, f"{path.name}: expected {profile} profile, found {detected}")
    activate_profile(detected)
    unapplied, unapplied_bom = decode_part(original.contents[PARTS[1]], PARTS[1])
    _, _, tables = query_index(schema, unapplied)
    replacements = load_replacements(tables)
    before_schema, before_unapplied = copy.deepcopy(schema), copy.deepcopy(unapplied)
    changed = patch_documents(schema, unapplied, replacements)
    updates = {}
    for name, before, after, bom in (
        (PARTS[0], before_schema, schema, schema_bom),
        (PARTS[1], before_unapplied, unapplied, unapplied_bom),
    ):
        if before != after:
            updates[name] = encode_part(after, bom)
    candidate_bytes = original.rebuild(updates)
    expected = (schema, unapplied)
    validate_candidate(original, candidate_bytes, updates, replacements, expected)
    if dry_run:
        print("Dry run; no files written.")
    elif output is None and not updates:
        print("Already patched; source binary left byte-for-byte unchanged.")
    else:
        destination = output if output is not None else path
        scratch = ROOT / f".fix-{ACTIVE_PROFILE}-query-org-{uuid.uuid4().hex}.pbit"
        owned = False
        try:
            with scratch.open("xb") as stream:
                owned = True
                stream.write(candidate_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            written = scratch.read_bytes()
            require(written == candidate_bytes, "Scratch write verification failed")
            validate_candidate(original, written, updates, replacements, expected)
            require(path.read_bytes() == raw, "Source changed during patch; refusing to publish")
            if output is not None:
                # Publish without overwriting an output created after preflight.
                if os.name == "nt":
                    os.rename(scratch, destination)
                else:
                    os.link(scratch, destination)
                    scratch.unlink()
            else:
                os.replace(scratch, destination)
            owned = False
        finally:
            if owned:
                scratch.unlink()
        print(f"Validated {ACTIVE_PROFILE} {'candidate' if output else 'patch'} written: {destination}")
    print(f"Profile: {ACTIVE_PROFILE}")
    print("Changed queries: " + (", ".join(changed) if changed else "(none)"))
    return changed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--path", type=Path, default=DEFAULT_PATH, help="Source PBIT")
    parser.add_argument("--output", type=Path, help="New separate candidate PBIT; must not exist")
    parser.add_argument("--dry-run", action="store_true", help="Validate without writing files")
    parser.add_argument("--profile", choices=["auto"] + sorted(PROFILES), default="auto",
                        help="Expected package profile; auto-detect by default")
    args = parser.parse_args(argv)
    try:
        patch(args.path, args.output, args.dry_run, args.profile)
    except (OSError, ValueError, zipfile.BadZipFile,
            NotImplementedError, RuntimeError, struct.error, zlib.error) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
