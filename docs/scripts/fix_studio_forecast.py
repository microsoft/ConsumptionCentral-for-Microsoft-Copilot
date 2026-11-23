"""Guarded patcher for the Studio history-fit forecast measures.

This script patches only DataModelSchema inside a .pbit and leaves every
other ZIP entry byte-identical. It is designed for the three active
Consumption Central templates, but it works against any current copy whose
Studio report bindings still match the shipped layout.

Why this exists:
- "Fitted from history" is currently hard-coded to 0% monthly growth.
- The forecast prose repeats that false limitation.
- The forecast base rate divides by active days only, which inflates sparse
  windows by ignoring quiet dates.

What changes:
- fit a capped monthly growth rate from dated Studio tenant history once
  roughly a month of data exists;
- treat missing calendar dates inside the observed span as zero usage;
- fall back honestly to a flat projection when history is still too short;
- keep manual growth scenarios unchanged.

Use --output to publish a separate candidate file. Without --output, a
validated scratch archive atomically replaces --path. --dry-run validates
without writing. --self-test runs synthetic regression cases only.
"""

import argparse
import copy
import io
import json
import math
import os
from pathlib import Path
import struct
import sys
import uuid
import zipfile
import zlib


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit"
RESOURCE_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = RESOURCE_DIR / "studio_forecast_manifest.json"
CASES_PATH = RESOURCE_DIR / "studio_forecast_cases.json"
PARTS = ("DataModelSchema",)
FIT_MIN_SPAN_DAYS = 28
FIT_MIN_OBSERVED_DAYS = 7
FIT_MONTHLY_FLOOR = -0.30
FIT_MONTHLY_CAP = 0.30


class PatchError(ValueError):
    """An unsupported or inconsistent input, with no destination published."""


def require(condition, message):
    if not condition:
        raise PatchError(message)


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
            text,
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except (TypeError, ValueError) as exc:
        raise PatchError(f"{label}: invalid JSON: {exc}") from exc


def decode_text(raw, label):
    if raw[:2] == b"\xff\xfe":
        try:
            return raw.decode("utf-16")
        except UnicodeError as exc:
            raise PatchError(f"{label}: invalid UTF-16") from exc
    if raw[:3] == b"\xef\xbb\xbf":
        try:
            return raw.decode("utf-8-sig")
        except UnicodeError as exc:
            raise PatchError(f"{label}: invalid UTF-8 BOM text") from exc
    if len(raw) > 1 and raw[1] == 0:
        try:
            return raw.decode("utf-16-le")
        except UnicodeError as exc:
            raise PatchError(f"{label}: invalid UTF-16LE") from exc
    try:
        return raw.decode("utf-8")
    except UnicodeError as exc:
        raise PatchError(f"{label}: invalid UTF-8") from exc


def decode_part(raw, label):
    text = decode_text(raw, label)
    value = parse_json(text, label)
    require(isinstance(value, dict), f"{label}: expected JSON object")
    return value, raw.startswith(b"\xff\xfe")


def encode_part(value, bom):
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (b"\xff\xfe" if bom else b"") + text.encode("utf-16le")


def source_text(value):
    if isinstance(value, list):
        return "\n".join(value)
    return value or ""


def text_block(text):
    lines = text.strip("\n").splitlines()
    return [""] + lines + [""] if len(lines) > 1 else (lines[0] if lines else "")


def load_json(path):
    try:
        return parse_json(path.read_text(encoding="utf-8"), str(path))
    except OSError as exc:
        raise PatchError(f"Cannot read {path}: {exc}") from exc


def ensure_report_bindings(package, manifest):
    bindings = manifest.get("requiredVisualBindings")
    require(isinstance(bindings, dict) and bool(bindings), "Manifest has no requiredVisualBindings")
    for part, needles in bindings.items():
        require(part in package.contents, f"Missing report part required for Studio page: {part}")
        text = decode_text(package.contents[part], part)
        require(isinstance(needles, list) and bool(needles), f"Manifest has empty binding list for {part}")
        for needle in needles:
            require(needle in text, f"{part}: expected binding/text missing: {needle}")


def find_named(items, label):
    require(isinstance(items, list), f"{label}: expected list")
    result = {}
    folded = set()
    for item in items:
        require(isinstance(item, dict), f"{label}: expected object")
        name = item.get("name")
        require(isinstance(name, str) and bool(name), f"{label}: missing name")
        require(name.casefold() not in folded, f"{label}: duplicate name {name!r}")
        folded.add(name.casefold())
        result[name] = item
    return result


def set_field(target, key, value):
    if key in target and target[key] == value:
        return False
    target[key] = value
    return True


def measure_spec(
    name,
    description,
    expression,
    *,
    format_string=None,
    display_folder=None,
    lineage_tag=None,
):
    spec = {
        "name": name,
        "description": description,
        "expression": expression,
    }
    if format_string is not None:
        spec["formatString"] = format_string
    if display_folder is not None:
        spec["displayFolder"] = display_folder
    if lineage_tag is not None:
        spec["lineageTag"] = lineage_tag
    return spec


UPDATED_MEASURES = {
    "Projected Credits (30d)": measure_spec(
        "Projected Credits (30d)",
        "First forecast month at the same fitted or selected growth rate used by the projection chart.",
        "[Daily Run Rate] * 30 * ( 1 + [Studio Growth Applied %] )",
        format_string="#,0",
        display_folder="Studio\\Forecast",
    ),
    "Projected Credits (Horizon)": measure_spec(
        "Projected Credits (Horizon)",
        "Sum of forecast months over the selected planning horizon, using the same growth rate as the projection chart.",
        text_block(
            """
            VAR _months = [Horizon Months Value]
            VAR _growth = [Studio Growth Applied %]
            VAR _base = [Daily Run Rate] * 30
            RETURN
                IF(
                    _months >= 1 && NOT ISBLANK( _base ),
                    SUMX( GENERATESERIES( 1, _months, 1 ), _base * POWER( 1 + _growth, [Value] ) )
                )
            """
        ),
        format_string="#,0",
        display_folder="Studio\\Forecast",
    ),
    "Daily Run Rate": measure_spec(
        "Daily Run Rate",
        [
            "Average Studio credits per calendar day across the observed history",
            "window in scope. Missing dates count as zero usage, so this is the",
            "projection baseline rather than an active-day average.",
        ],
        "DIVIDE( [Studio Consumed Credits (Tenant)], [Studio History Span Days] )",
        format_string="#,0",
        display_folder="Studio\\Forecast",
    ),
    "Studio Forecast Confidence": measure_spec(
        "Studio Forecast Confidence",
        [
            "How dependable the Studio projection is. A fitted rate needs about",
            "a month of dated history; shorter or very sparse windows fall back",
            "to a flat daily average and stay low confidence.",
        ],
        text_block(
            """
            VAR _observed = [Studio Days Observed]
            VAR _span = [Studio History Span Days]
            VAR _coverage = [Studio History Coverage %]
            VAR _fit = [Studio Fitted Monthly Growth %]
            RETURN
                SWITCH(
                    TRUE(),
                    ISBLANK( _observed ) || _observed = 0, "No data",
                    ISBLANK( _span ) || _span < 14 || _observed < 4, "Indicative only",
                    ISBLANK( _fit ), "Low",
                    _span >= 84 && _coverage >= 0.40, "High",
                    _span >= 42 && _coverage >= 0.25, "Medium",
                    "Low"
                )
            """
        ),
        display_folder="Studio\\Forecast",
    ),
    "Studio Forecast Note": measure_spec(
        "Studio Forecast Note",
        [
            "Plain statement of what the projection rests on, including whether",
            "the fitted trend came from history or whether the page fell back to",
            "a flat daily average.",
        ],
        text_block(
            """
            VAR _observed = [Studio Days Observed]
            VAR _span = [Studio History Span Days]
            VAR _fit = [Studio Fitted Monthly Growth %]
            VAR _chosen = SELECTEDVALUE( 'Growth Scenario'[Scenario], "Fitted from history" )
            VAR _basis =
                IF(
                    _chosen = "Fitted from history",
                    IF(
                        ISBLANK( _fit ),
                        " A fit needs at least 28 calendar days and 7 days with positive consumption. This selection has insufficient usable history, so the daily average is projected flat.",
                        " Fitted from " & FORMAT( _span, "#,0" ) & " calendar days of history (" &
                            FORMAT( _observed, "#,0" ) & " recorded days). Missing dates are treated as zero usage. Fitted growth is capped between -30% and +30% a month."
                    ),
                    " Growth is the scenario you chose, not the fitted rate."
                )
            RETURN
                SWITCH(
                    [Studio Forecast Confidence],
                    "No data", "No Studio data loaded.",
                    "Indicative only", "Only " & FORMAT( COALESCE( _span, 0 ), "#,0" ) &
                        " calendar days of Studio history are in scope." & _basis,
                    "Low", FORMAT( COALESCE( _span, 0 ), "#,0" ) &
                        " calendar days of Studio history are in scope." & _basis,
                    "Medium", FORMAT( _span, "#,0" ) & " calendar days of Studio history are in scope." & _basis,
                    FORMAT( _span, "#,0" ) & " calendar days of Studio history are in scope." & _basis
                )
            """
        ),
        display_folder="Studio\\Forecast",
    ),
    "Studio Forecast Summary": measure_spec(
        "Studio Forecast Summary",
        [
            "Written summary of the Studio outlook, filter-aware. Leads with the",
            "twelve month number and states whether growth was fitted from",
            "history or supplied manually.",
        ],
        text_block(
            """
            VAR _rate = [Daily Run Rate]
            VAR _cost30 = [Projected Cost (30d)]
            VAR _yearCost = [Studio Year Cost]
            VAR _growth = [Studio Growth Applied %]
            VAR _fitted = [Studio Fitted Monthly Growth %]
            VAR _span = [Studio History Span Days]
            VAR _daysLeft = [Studio Entitlement Days Remaining]
            VAR _conf = LOWER( [Studio Forecast Confidence] )
            VAR _chosen = SELECTEDVALUE( 'Growth Scenario'[Scenario], "Fitted from history" )
            VAR _growthBit =
                IF(
                    _chosen = "Fitted from history",
                    IF(
                        ISBLANK( _fitted ),
                        " There is insufficient usable history for a fit, so the forecast stays flat from the observed daily average.",
                        IF(
                            ABS( _growth ) < 0.001,
                            " History fits essentially flat month on month.",
                            " The history-based rate is " & FORMAT( _growth, "0.0%" ) &
                                " a month across " & FORMAT( _span, "#,0" ) &
                                " calendar days, bounded to -30%/+30% for planning."
                        )
                    ),
                    " Using your selected growth rate of " & FORMAT( _growth, "0.0%" ) & " a month."
                )
            VAR _tail =
                IF(
                    ISBLANK( _daysLeft ),
                    "",
                    " Prepaid capacity lasts about " & FORMAT( _daysLeft, "#,0" ) & " more days at this rate."
                )
            RETURN
                IF(
                    ISBLANK( _rate ) || _rate = 0,
                    "No Studio consumption in the current selection.",
                    "Studio is averaging about " & FORMAT( _rate, "#,0" ) &
                        " credits a day across the selected history, which projects to " &
                        FORMAT( _cost30, "$#,0" ) & " over 30 days and " &
                        FORMAT( _yearCost, "$#,0" ) & " over twelve months." &
                        _growthBit & _tail & " Confidence is " & _conf & "."
                )
            """
        ),
        display_folder="Studio\\Forecast",
    ),
    "Studio Growth Applied %": measure_spec(
        "Studio Growth Applied %",
        [
            "The monthly growth rate the Studio projection uses.",
            "",
            "On \"Fitted from history\" this fits a capped trend from the dated",
            "tenant history itself once roughly a month of coverage exists,",
            "treating missing dates as zero usage. Shorter windows fall back to",
            "flat. Every other scenario is still the explicit rate you chose.",
        ],
        text_block(
            """
            VAR _chosen = SELECTEDVALUE( 'Growth Scenario'[Scenario], "Fitted from history" )
            VAR _rate = SELECTEDVALUE( 'Growth Scenario'[Rate] )
            VAR _fitted = [Studio Fitted Monthly Growth %]
            RETURN
                IF( _chosen = "Fitted from history", COALESCE( _fitted, 0 ), _rate )
            """
        ),
        format_string="0.0%",
        display_folder="Studio\\Forecast",
    ),
}


NEW_MEASURES = {
    "Studio History Span Days": measure_spec(
        "Studio History Span Days",
        [
            "Calendar days between the first and last Studio usage date in",
            "scope. Missing dates count toward the span so the fit sees quiet",
            "days as zero usage, not as absent evidence.",
        ],
        text_block(
            """
            VAR _fromDate = [Studio Period Start]
            VAR _history =
                CALCULATETABLE(
                    VALUES( 'Credit Consumption (Tenant)'[Usage_Date] ),
                    REMOVEFILTERS( 'Credit Consumption (Tenant)'[Usage_Date] ),
                    'Credit Consumption (Tenant)'[Usage_Date] >= _fromDate
                )
            VAR _minDate = MINX( _history, 'Credit Consumption (Tenant)'[Usage_Date] )
            VAR _maxDate = MAXX( _history, 'Credit Consumption (Tenant)'[Usage_Date] )
            RETURN
                IF(
                    ISBLANK( _minDate ) || ISBLANK( _maxDate ),
                    BLANK(),
                    1 + INT( _maxDate - _minDate )
                )
            """
        ),
        format_string="#,0",
        display_folder="Studio\\Forecast\\Model",
        lineage_tag="8a3c7f9d-6c3f-4a22-b101-54b1a7d6e001",
    ),
    "Studio History Coverage %": measure_spec(
        "Studio History Coverage %",
        [
            "Share of calendar days in the current Studio history window that",
            "recorded any usage. Low coverage means the fit is being asked to",
            "explain a sparse pattern and confidence should stay low.",
        ],
        "DIVIDE( [Studio Days Observed], [Studio History Span Days] )",
        format_string="0.0%",
        display_folder="Studio\\Forecast\\Model",
        lineage_tag="8a3c7f9d-6c3f-4a22-b101-54b1a7d6e002",
    ),
    "Studio Fitted Monthly Growth %": measure_spec(
        "Studio Fitted Monthly Growth %",
        [
            "Monthly growth fitted from the dated Studio tenant history itself.",
            "Uses regression on a 7-day rolling average over the calendar-day",
            "series, so missing dates count as zero usage while weekday-only",
            "patterns do not fake a trend,",
            "and clamps the result to +/-30% a month to",
            "stop a short ramp from exploding a twelve-month extrapolation.",
        ],
        text_block(
            """
            VAR _span = [Studio History Span Days]
            VAR _observed = [Studio Days Observed]
            VAR _fromDate = [Studio Period Start]
            VAR _minDate =
                CALCULATE(
                    MIN( 'Credit Consumption (Tenant)'[Usage_Date] ),
                    REMOVEFILTERS( 'Credit Consumption (Tenant)'[Usage_Date] ),
                    'Credit Consumption (Tenant)'[Usage_Date] >= _fromDate
                )
            VAR _maxDate =
                CALCULATE(
                    MAX( 'Credit Consumption (Tenant)'[Usage_Date] ),
                    REMOVEFILTERS( 'Credit Consumption (Tenant)'[Usage_Date] ),
                    'Credit Consumption (Tenant)'[Usage_Date] >= _fromDate
                )
            RETURN
                IF(
                    _span >= 28
                        && _observed >= 7
                        && NOT ISBLANK( _minDate )
                        && NOT ISBLANK( _maxDate ),
                    VAR _daily =
                        ADDCOLUMNS(
                            CALENDAR( _minDate, _maxDate ),
                            "@x", INT( [Date] - _minDate ),
                            "@credits",
                                VAR _day = [Date]
                                RETURN
                                    COALESCE(
                                        CALCULATE(
                                            [Studio Consumed Credits (Tenant)],
                                            TREATAS( { _day }, 'Credit Consumption (Tenant)'[Usage_Date] )
                                        ),
                                        0
                                    )
                        )
                    VAR _avg7 =
                        FILTER(
                            _daily,
                            [@x] >= 6
                        )
                    VAR _series =
                        ADDCOLUMNS(
                            ADDCOLUMNS(
                                _avg7,
                                "@avg7",
                                    VAR _x = [@x]
                                    RETURN
                                        AVERAGEX(
                                            FILTER( _daily, [@x] >= _x - 6 && [@x] <= _x ),
                                            [@credits]
                                        )
                            ),
                            "@logAvg7", LN( 1 + MAX( 0, [@avg7] ) )
                        )
                    VAR _n = COUNTROWS( _series )
                    VAR _sx = SUMX( _series, [@x] )
                    VAR _sy = SUMX( _series, [@logAvg7] )
                    VAR _sxy = SUMX( _series, [@x] * [@logAvg7] )
                    VAR _sxx = SUMX( _series, [@x] * [@x] )
                    VAR _dailySlope = DIVIDE( _n * _sxy - _sx * _sy, _n * _sxx - _sx * _sx )
                    VAR _boundedSlope = MIN( MAX( 30 * _dailySlope, LN( 0.70 ) ), LN( 1.30 ) )
                    RETURN
                        IF(
                            _n >= 14
                                && COUNTROWS( FILTER( _daily, [@credits] > 0 ) ) >= 7
                                && NOT ISBLANK( _dailySlope ),
                            EXP( _boundedSlope ) - 1
                        )
                )
            """
        ),
        format_string="0.0%",
        display_folder="Studio\\Forecast\\Model",
        lineage_tag="8a3c7f9d-6c3f-4a22-b101-54b1a7d6e003",
    ),
}


def validate_measure_shape(measure):
    require(isinstance(measure, dict), "Measure spec must be an object")
    require(isinstance(measure.get("name"), str) and bool(measure["name"]), "Measure spec missing name")
    description = measure.get("description")
    expression = measure.get("expression")
    require(isinstance(description, (str, list)), f"{measure['name']}: invalid description shape")
    require(isinstance(expression, (str, list)), f"{measure['name']}: invalid expression shape")


from fix_studio_resource_wording import repaired as resource_wording

for _name in ("Studio Forecast Note", "Studio Forecast Summary"):
    UPDATED_MEASURES[_name]["expression"] = resource_wording(
        "Credit Consumption (Tenant)", _name, source_text(UPDATED_MEASURES[_name]["expression"]))

for _measure in list(UPDATED_MEASURES.values()) + list(NEW_MEASURES.values()):
    validate_measure_shape(_measure)


def apply_measure_fields(target, spec):
    changed = False
    for key in ("description", "expression", "formatString", "displayFolder", "lineageTag"):
        if key in spec:
            changed |= set_field(target, key, copy.deepcopy(spec[key]))
    return changed


def new_measure(spec):
    result = {"name": spec["name"]}
    for key in ("description", "expression", "formatString", "displayFolder", "lineageTag"):
        if key in spec:
            result[key] = copy.deepcopy(spec[key])
    return result


def patch_schema(schema):
    model = schema.get("model")
    require(isinstance(model, dict), "DataModelSchema: missing model")
    tables = find_named(model.get("tables"), "model.tables")
    require("Credit Consumption (Tenant)" in tables, "Missing table: Credit Consumption (Tenant)")
    measure_list = tables["Credit Consumption (Tenant)"].get("measures")
    require(isinstance(measure_list, list), "Credit Consumption (Tenant).measures: expected list")
    measures = find_named(measure_list, "Credit Consumption (Tenant).measures")

    changed = []
    added = []
    for name, spec in UPDATED_MEASURES.items():
        require(name in measures, f"Missing Studio measure: {name}")
        if apply_measure_fields(measures[name], spec):
            changed.append(name)
    for name, spec in NEW_MEASURES.items():
        if name in measures:
            if apply_measure_fields(measures[name], spec):
                changed.append(name)
        else:
            measure_list.append(new_measure(spec))
            measures[name] = measure_list[-1]
            added.append(name)

    final_names = [m.get("name") for m in measure_list]
    require(len(final_names) == len(set(final_names)), "Patch introduced duplicate measure names")
    return changed, added


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

    def __init__(self, raw):
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
        require(disk == cd_disk == 0 and disk_count == count, "ZIP: multi-disk archives are unsupported")
        require(count != 0xFFFF and cd_size != 0xFFFFFFFF and cd_offset != 0xFFFFFFFF, "ZIP: ZIP64 is unsupported")
        require(cd_offset + cd_size == end, "ZIP: unsupported central directory layout")
        self.cd_offset = cd_offset
        self.end_record = raw[end:]
        self.central = {}
        self.infos = {}
        self.contents = {}
        self.locals = {}
        self.payloads = {}
        position = cd_offset
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
                require(basename.casefold() != "datamashup", f"Unexpected DataMashup part: {name}")
                require(not info.flag_bits & (1 | 0x40 | 0x2000), f"{name}: encrypted ZIP entry is unsupported")
                require(info.volume == 0, f"{name}: multi-disk ZIP entry")
                require(position + 46 <= end and raw[position:position + 4] == b"PK\x01\x02", f"{name}: malformed central directory")
                name_len, extra_len, entry_comment_len = struct.unpack_from("<HHH", raw, position + 28)
                record_end = position + 46 + name_len + extra_len + entry_comment_len
                require(record_end <= end, f"{name}: truncated central directory")
                record = raw[position:record_end]
                offset = struct.unpack_from("<L", record, 42)[0]
                require(offset == info.header_offset and offset < cd_offset, f"{name}: inconsistent local offset")
                check_extra(info.extra, name)
                self.central[name] = record
                self.infos[name] = info
                self.contents[name] = archive.read(info)
                position = record_end
        require(position == end, "ZIP: extra central directory records unsupported")
        require(all(name in self.infos for name in PARTS), "ZIP: missing required parts")
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
            require(len(local) >= 30 and local[:4] == b"PK\x03\x04", f"{name}: missing local header")
            flags, compression = struct.unpack_from("<HH", local, 6)
            require(flags == info.flag_bits and compression == info.compress_type, f"{name}: local/central header mismatch")
            name_len, extra_len = struct.unpack_from("<HH", local, 26)
            header_size = 30 + name_len + extra_len
            payload_end = header_size + info.compress_size
            require(payload_end <= len(local), f"{name}: overlapping/truncated payload")
            central_name_len = struct.unpack_from("<H", self.central[name], 28)[0]
            require(local[30:30 + name_len] == self.central[name][46:46 + central_name_len], f"{name}: local/central filename mismatch")
            check_extra(local[30 + name_len:header_size], f"{name} local")
            if not flags & 8:
                require(struct.unpack_from("<LLL", local, 14) == (info.CRC, info.compress_size, info.file_size), f"{name}: local/central CRC or size mismatch")
            if name in PARTS:
                require(flags & ~0x800 == 0, f"{name}: unsupported flags/data descriptor on changed part")
                require(compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), f"{name}: unsupported compression")
            self.locals[name] = local
            self.payloads[name] = (header_size, payload_end)

    def rebuild(self, updates):
        require(set(updates) <= set(PARTS), "Attempt to change an unexpected ZIP part")
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
        require(offset < 0xFFFFFFFF and len(central) < 0xFFFFFFFF, "ZIP64 central directory would be needed")
        end = bytearray(self.end_record)
        struct.pack_into("<LL", end, 12, len(central), offset)
        return b"".join(local_chunks) + central + bytes(end)


def validate_candidate(original, candidate_bytes, updates, expected_schema, manifest):
    candidate = Package(candidate_bytes)
    require(list(original.infos) == list(candidate.infos), "Candidate changed ZIP parts/order")
    require(original.local_order == candidate.local_order, "Candidate changed local order")
    require(original.prefix == candidate.prefix and original.comment == candidate.comment, "Candidate changed archive prefix/comment")
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
            require(original.locals[name][old_payload_end:] == candidate.locals[name][new_payload_end:], f"{name}: changed local trailer")
        else:
            require(original.locals[name] == candidate.locals[name], f"{name}: changed raw local record/compressed bytes")
        require(before == after, f"{name}: changed central-directory metadata")
        require(candidate.contents[name] == updates.get(name, original.contents[name]), f"{name}: candidate content mismatch")
    schema, bom = decode_part(candidate.contents["DataModelSchema"], "DataModelSchema")
    require(schema == expected_schema, "Candidate JSON does not match intended edits")
    require(bom == original.contents["DataModelSchema"].startswith(b"\xff\xfe"), "DataModelSchema: changed BOM convention")
    ensure_report_bindings(candidate, manifest)


def publish_candidate(path, raw, candidate_bytes, output):
    destination = output if output is not None else path
    scratch = ROOT / f".fix-studio-forecast-{uuid.uuid4().hex}.pbit"
    owned = False
    try:
        with scratch.open("xb") as stream:
            owned = True
            stream.write(candidate_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        written = scratch.read_bytes()
        require(written == candidate_bytes, "Scratch write verification failed")
        require(path.read_bytes() == raw, "Source changed during patch; refusing to publish")
        if output is not None:
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
    return destination


def patch(path, output=None, dry_run=False):
    manifest = load_json(MANIFEST_PATH)
    path = Path(path).resolve()
    require(path.is_file(), f"Source does not exist: {path}")
    if output is not None:
        output = Path(output).resolve()
        require(output != path, "--output must differ from --path")
        require(not output.exists(), f"Refusing to overwrite existing output: {output}")
        require(output.parent.is_dir(), f"Output directory does not exist: {output.parent}")
    raw = path.read_bytes()
    original = Package(raw)
    ensure_report_bindings(original, manifest)
    schema, schema_bom = decode_part(original.contents["DataModelSchema"], "DataModelSchema")
    before_schema = copy.deepcopy(schema)
    changed, added = patch_schema(schema)
    updates = {}
    if before_schema != schema:
        updates["DataModelSchema"] = encode_part(schema, schema_bom)
    candidate_bytes = original.rebuild(updates)
    validate_candidate(original, candidate_bytes, updates, schema, manifest)

    if dry_run:
        print("Dry run; no files written.")
    elif output is None and not updates:
        print("Already patched; source binary left byte-for-byte unchanged.")
    else:
        destination = publish_candidate(path, raw, candidate_bytes, output)
        validate_candidate(original, destination.read_bytes(), updates, schema, manifest)
        print(f"Validated {'candidate' if output else 'patch'} written: {destination}")

    changed_names = changed if changed else ["(none)"]
    added_names = added if added else ["(none)"]
    print("Changed measures: " + ", ".join(changed_names))
    print("Added measures: " + ", ".join(added_names))
    return changed, added


def synth_series(case):
    days = int(case["days"])
    require(days > 0, f"{case.get('name', '<case>')}: days must be positive")
    pattern = case["pattern"]
    start = float(case["startingCredits"])
    monthly_growth = float(case["monthlyGrowth"])
    activity = case.get("activeDays", "all")
    series = []
    for day in range(days):
        active = activity == "all" or (activity == "weekdays" and day % 7 < 5)
        if pattern == "constant":
            value = start
        elif pattern == "exponential":
            value = start * ((1 + monthly_growth) ** (day / 30.0))
        else:
            raise PatchError(f"{case['name']}: unsupported pattern {pattern!r}")
        series.append(value if active else 0.0)
    return series


def fit_growth(series):
    span = len(series)
    observed = sum(1 for value in series if value > 0)
    if span < FIT_MIN_SPAN_DAYS or observed < FIT_MIN_OBSERVED_DAYS:
        return None
    rolling = []
    for index in range(len(series)):
        window = series[max(0, index - 6):index + 1]
        rolling.append(sum(window) / len(window))
    xs = list(range(6, len(rolling)))
    if len(xs) < 14:
        return None
    logs = [math.log1p(max(rolling[index], 0.0)) for index in xs]
    n = len(xs)
    sx = sum(xs)
    sy = sum(logs)
    sxy = sum(x * y for x, y in zip(xs, logs))
    sxx = sum(x * x for x in xs)
    denom = n * sxx - sx * sx
    if denom == 0:
        return None
    slope = (n * sxy - sx * sy) / denom
    bounded_slope = min(
        max(30 * slope, math.log1p(FIT_MONTHLY_FLOOR)),
        math.log1p(FIT_MONTHLY_CAP),
    )
    return math.expm1(bounded_slope)


def active_day_rate(series):
    observed = [value for value in series if value > 0]
    return (sum(observed) / len(observed)) if observed else 0.0


def calendar_day_rate(series):
    return (sum(series) / len(series)) if series else 0.0


def run_self_test():
    data = load_json(CASES_PATH)
    cases = data.get("cases")
    require(isinstance(cases, list) and bool(cases), f"{CASES_PATH}: expected non-empty cases array")
    failures = []
    print("Studio forecast regression cases")
    for case in cases:
        name = case["name"]
        series = synth_series(case)
        fixed = fit_growth(series)
        baseline = 0.0
        observed = sum(1 for value in series if value > 0)
        span = len(series)
        fit_expected = bool(case["expectFit"])
        ok = True
        detail = ""
        if fit_expected:
            if fixed is None:
                ok = False
                detail = "expected a fitted rate but fell back flat"
            else:
                low = float(case["minGrowth"])
                high = float(case["maxGrowth"])
                if not (low <= fixed <= high):
                    ok = False
                    detail = f"fitted {fixed:.4f} outside [{low:.4f}, {high:.4f}]"
        elif fixed is not None:
            ok = False
            detail = f"expected flat fallback but fitted {fixed:.4f}"
        status = "PASS" if ok else "FAIL"
        fixed_text = "flat fallback" if fixed is None else f"{fixed:.1%}"
        print(
            f"- {status} {name}: baseline fitted {baseline:.1%}, fixed {fixed_text}, "
            f"span {span}d, active {observed}d, active-day {active_day_rate(series):.1f}, "
            f"calendar-day {calendar_day_rate(series):.1f}"
        )
        if detail:
            print(f"    {detail}")
        if not ok:
            failures.append(name)
    return 1 if failures else 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--path", type=Path, default=DEFAULT_PATH, help="Source PBIT")
    parser.add_argument("--output", type=Path, help="New separate candidate PBIT; must not exist")
    parser.add_argument("--dry-run", action="store_true", help="Validate without writing files")
    parser.add_argument("--self-test", action="store_true", help="Run synthetic regression cases only")
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            return run_self_test()
        patch(args.path, args.output, args.dry_run)
    except (OSError, ValueError, zipfile.BadZipFile,
            NotImplementedError, RuntimeError, struct.error, zlib.error) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
