"""Verify Viva Direct reads its data files through SourceFiles, and that its
SharePoint forms leave nothing reading local files.

docs/scripts/fix_viva_direct_sources.py is the source of truth. This replays
it against the shipped template and fails if it would still change something,
then checks what the installer relies on when it publishes the template with a
SharePoint folder:

    python docs/scripts/check_viva_direct_sources.py

1. The template carries the fix in both model parts: replaying it changes
   nothing.
2. SourceFiles is the only query that reads local files, and the only one
   that reads DataFolder. DataFiles and CoworkTaskInput read SourceFiles.
3. SharePointSiteUrl ships blank, and SharePointSiteUrl and SourceFiles come
   straight after DataFolder in Desktop's query order.
4. Each SharePoint form, swapped in the way the installer swaps it -
   SourceFiles replaced wholesale, DataFolder and SharePointSiteUrl set in
   place with their meta records kept - leaves no expression or partition
   reading local files, so the published model needs no gateway for them.
5. Both forms resolve the folder's address with the same steps, character for
   character, and are plain UTF-8 text without a byte order mark.

Static only: no M runs, and nothing reaches SharePoint.
"""
import codecs
import copy
import io
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_viva_direct_sources as spec  # noqa: E402

# Example values in the shape the installer records them: the site's address,
# and the folder's address as SharePoint gives it, percent-encoded.
SITE = "https://contoso.sharepoint.com/sites/ConsumptionCentral"
FOLDER = SITE + "/Shared%20Documents/Consumption%20Central"
RESOLVE_START = "    // Shared resolve steps: keep identical in both SharePoint forms.\n"
RESOLVE_END = "    // End of shared resolve steps.\n"
# The call each form lists the folder with.
READERS = {
    "SourceFiles.SharePoint.m": "SharePoint.Files",
    "SourceFiles.SharePoint.Contents.m": "SharePoint.Contents",
}

LEXEMES = re.compile(r'//[^\n]*|/\*.*?\*/|#"(?:[^"]|"")*"|"(?:[^"]|"")*"', re.S)
PLAIN_NAME = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
LOCAL_READ = re.compile(r"\b(?:File|Folder)\.[A-Z]\w*")


def code(text, strings=False):
    """M text with its comments blanked, and its strings and quoted names too unless strings is set.

    A quoted name that is also a plain one stands for it - #"File.Contents" is
    File.Contents - so it is kept as the plain name. Any other, such as
    #"Folder Path", is blanked with the strings.
    """
    def blank(match):
        token = match.group()
        if strings and token[0] in '"#':
            return token
        if token.startswith('#"') and PLAIN_NAME.fullmatch(token[2:-1]):
            return token[2:-1]
        return " "
    return LEXEMES.sub(blank, text)


def references(text, name):
    """Whether M code (not a comment or a string) names this query."""
    return re.search(rf"(?<![\w.]){re.escape(name)}(?![\w.])", code(text)) is not None


def m_sources(model):
    """Every M text the model evaluates: its expressions, then its tables' M partitions."""
    found = {}
    for expression in model["model"]["expressions"]:
        if expression.get("kind", "m") != "m":
            raise ValueError(f"{expression['name']}: a {expression['kind']} expression; review it by hand")
        found[expression["name"]] = spec.joined(expression["expression"])
    for table in model["model"]["tables"]:
        for partition in table.get("partitions", []):
            kind = partition["source"].get("type")
            if kind == "m":
                found[f"{table['name']} (partition)"] = spec.joined(partition["source"]["expression"])
            elif kind != "calculated":
                raise ValueError(f"{table['name']}: a {kind} partition; review it by hand")
    return found


def local_reads(model):
    """{query: File.* and Folder.* calls} for every M text that makes one."""
    found = {}
    for name, text in m_sources(model).items():
        calls = sorted(set(LOCAL_READ.findall(code(text))))
        if calls:
            found[name] = calls
    return found


def named(model, name):
    matches = [e for e in model["model"]["expressions"] if e["name"] == name]
    if len(matches) != 1:
        raise KeyError(f"{name}: {len(matches)} expressions with this name")
    return matches[0]


def m_string(value):
    return '"' + value.replace('"', '""') + '"'


def set_parameter(model, name, value):
    """The installer's parameters step: a new value, the meta record kept. A missing name throws."""
    expression = named(model, name)
    _, separator, meta = spec.joined(expression["expression"]).partition(" meta [")
    if not separator or "IsParameterQuery=true" not in meta:
        raise ValueError(f"{name} is not a parameter")
    expression["expression"] = m_string(value) + separator + meta


def replace_expression(model, name, text):
    """The installer's expressions step: the entry's M replaced wholesale. A missing name throws."""
    named(model, name)["expression"] = text


def resolve_steps(text, label):
    for marker in (RESOLVE_START, RESOLVE_END):
        if text.count(marker) != 1:
            raise ValueError(f"{label}: expected one {marker.strip()!r}")
    return text[text.index(RESOLVE_START):text.index(RESOLVE_END)]


def swapped(model, form):
    """The model as the installer publishes it with this SharePoint form."""
    result = copy.deepcopy(model)
    replace_expression(result, spec.SOURCE_FILES, spec.source(form))
    set_parameter(result, spec.DATA_FOLDER, FOLDER)
    set_parameter(result, spec.SITE_URL, SITE)
    return result


def shipped_problems(model):
    """Checks 2 and 3, on the template as shipped."""
    problems = []
    texts = m_sources(model)
    reads = local_reads(model)
    if reads != {spec.SOURCE_FILES: ["Folder.Files"]}:
        problems.append(f"only SourceFiles may read local files, with Folder.Files; found {reads}")
    readers = sorted(name for name, text in texts.items() if references(text, spec.DATA_FOLDER))
    if readers != [spec.SOURCE_FILES]:
        problems.append(f"only SourceFiles may read DataFolder; found {readers}")
    for name in ("DataFiles", "CoworkTaskInput"):
        if not references(texts[name], spec.SOURCE_FILES):
            problems.append(f"{name} does not read SourceFiles")
    if spec.joined(named(model, spec.SITE_URL)["expression"]) != spec.SITE_URL_M:
        problems.append(f"{spec.SITE_URL} does not ship blank")
    order = [a for a in model["model"]["annotations"] if a["name"] == spec.QUERY_ORDER]
    names = json.loads(order[0]["value"]) if len(order) == 1 else []
    at = names.index(spec.DATA_FOLDER) + 1 if spec.DATA_FOLDER in names else 0
    if names[at:at + len(spec.ADDED)] != list(spec.ADDED):
        problems.append(f"{spec.QUERY_ORDER} does not list {', '.join(spec.ADDED)} after {spec.DATA_FOLDER}")
    return problems


def form_problems(model):
    """Checks 4 and 5, on each SharePoint form."""
    problems = []
    for form in spec.SHAREPOINT_FORMS:
        raw = form.read_bytes()
        if raw.startswith(codecs.BOM_UTF8) or b"\r" in raw:
            problems.append(f"{form.name}: not plain LF text without a byte order mark")
        published = swapped(model, form)
        reads = local_reads(published)
        if reads:
            problems.append(f"{form.name}: still reads local files once swapped in: {reads}")
        text = spec.joined(named(published, spec.SOURCE_FILES)["expression"])
        if READERS[form.name] not in code(text):
            problems.append(f"{form.name}: does not list the folder with {READERS[form.name]}")
        for name in (spec.DATA_FOLDER, spec.SITE_URL):
            if not references(text, name):
                problems.append(f"{form.name}: does not read {name}")
    first, second = (resolve_steps(spec.source(form), form.name) for form in spec.SHAREPOINT_FORMS)
    if first != second:
        problems.append("the SharePoint forms resolve the folder's address differently")
    return problems


def main():
    template = spec.TEMPLATE
    print(f"\n{template.name}")
    problems = []
    try:
        raw = template.read_bytes()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            if "SecurityBindings" not in z.namelist():
                problems.append("SecurityBindings was dropped")
        _, changes = spec.build(raw)
        problems += [f"not applied - {change}" for change in changes]
        model = spec.layout_for(spec.Package(raw).contents[spec.SCHEMA], spec.SCHEMA)[0]
        shipped = shipped_problems(model)
        forms = form_problems(model)
    except (OSError, KeyError, TypeError, ValueError, zipfile.BadZipFile) as error:
        problems.append(str(error))
    else:
        problems += shipped + forms
        print(f"  SourceFiles feeds DataFiles and CoworkTaskInput: {'ok' if not shipped else 'FAIL'}")
        print(f"  {len(spec.SHAREPOINT_FORMS)} SharePoint forms, nothing reading local files once swapped in: "
              f"{'ok' if not forms else 'FAIL'}")
    print()
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print("Viva Direct reads its files through SourceFiles, and its SharePoint forms need no gateway")
    return 0


if __name__ == "__main__":
    sys.exit(main())
