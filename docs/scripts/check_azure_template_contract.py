"""Check shipped Azure input contracts without refreshing or changing a PBIT."""
import json
import re
import zipfile
from pathlib import Path

from check_pbit_defaults import decode


ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = {
    "AzureAiSpend": {
        "UsageDate", "ServiceName", "Meter", "ResourceName", "ResourceGroup",
        "Cost", "UsageQuantity", "DepartmentTag", "Currency",
    },
    "AzureAiTokens": {
        "Date", "ResourceName", "ResourceGroup", "Deployment", "Metric", "Value",
    },
}


def text(expression):
    return "\n".join(expression) if isinstance(expression, list) else expression


def m_tokens(query):
    """Tokenize enough M for static contracts, excluding comments, not string contents."""
    pattern = re.compile(r'\s+|//[^\r\n]*|/\*|"(?:[^"]|"")*"|[A-Za-z_][\w.]*|\d+|=>|<>|\S')
    tokens = []
    pos = 0
    while pos < len(query):
        match = pattern.match(query, pos)
        token = match.group()
        pos = match.end()
        if token == "/*":
            depth = 1
            while depth:
                end = re.search(r'/\*|\*/', query[pos:])
                assert end, "Unterminated M comment"
                depth += 1 if end.group() == "/*" else -1
                pos += end.end()
        elif not token.isspace() and not token.startswith("//"):
            tokens.append(token)
    return tuple(tokens)


def contains(tokens, snippet):
    wanted = m_tokens(snippet)
    return any(tokens[i:i + len(wanted)] == wanted
               for i in range(len(tokens) - len(wanted) + 1))


def group_after(tokens, prefix):
    """Return a balanced group following a known binding/call prefix."""
    wanted = m_tokens(prefix)
    closing = {"(": ")", "{": "}", "[": "]"}
    for i in range(len(tokens) - len(wanted) + 1):
        if tokens[i:i + len(wanted)] != wanted:
            continue
        start = i + len(wanted)
        stack = [closing[wanted[-1]]]
        for j in range(start, len(tokens)):
            token = tokens[j]
            if token in closing:
                stack.append(closing[token])
            elif token in closing.values():
                assert stack and stack.pop() == token, "Unbalanced M group"
                if not stack:
                    return tokens[start:j]
    return ()


def list_items(tokens):
    start = depth = 0
    for i, token in enumerate(tokens):
        if token in ("(", "{", "["):
            depth += 1
        elif token in (")", "}", "]"):
            depth -= 1
        elif token == "," and depth == 0:
            yield tokens[start:i]
            start = i + 1
    if tokens[start:]:
        yield tokens[start:]


def input_bindings(query):
    """Recognize the two shipped reader idioms, not arbitrary M dataflow."""
    tokens = m_tokens(query)
    helper = group_after(tokens, "Normalize = (")
    normalized = (
        "(Source as table, Specs as list, Required as list) as table =>",
        'Key = (s as text) as text => Text.Lower(Text.Select(s, {"a".."z", "A".."Z", "0".."9"}))',
        "Columns = List.Buffer(Table.ColumnNames(Source))",
        "Pick = (spec as list) as nullable text => let",
        "Candidates = List.Transform({spec{0}} & spec{1}, (alias) =>",
        "if List.Contains(Columns, alias) then {alias}",
        "else List.Select(Columns, each Key(_) = Key(alias))",
        "Best = List.First(List.Select(Candidates, each not List.IsEmpty(_)), {}) in",
        "else List.First(Best, null), Bindings =",
        "Bindings = List.Buffer(List.Transform(Specs, each Pick(_)))",
        "Names = List.Transform(Specs, each _{0})",
        "Table.FromColumns(List.Transform(Bindings, (c) =>",
        "else Table.Column(Source, c)), Names)",
    )
    string = r'"(?:[^"]|"")*"'
    strings = rf'{string}(?: , {string})*'
    names = set()
    if helper[-2:] == ("in", "Result") and all(contains(helper, part) for part in normalized):
        specs = group_after(tokens, "Named = Normalize(Raw, {")
        for item in list_items(specs):
            match = re.fullmatch(
                rf'\{{ "(\w+)" , (?:\{{ (?:{strings} )?\}}|[A-Za-z_]\w*) \}}',
                " ".join(item))
            if match:
                names.add(match[1])
        return names

    legacy = (
        'Key = (n as text) as text => Text.Lower(Text.Remove(n, {" ", "_", "-"}))',
        "Find = (aliases as list) as nullable text => "
        "List.First(List.Select(Cols, each List.Contains(aliases, Key(_))), null)",
    )
    source = next((source for source in ("Raw", "Headers")
                   if contains(tokens, f"Cols = Table.ColumnNames({source})")
                   and contains(tokens, f"Named = Table.RenameColumns({source}, Ren, MissingField.Ignore)")), None)
    if source and all(contains(tokens, part) for part in legacy):
        renames = group_after(tokens, "Ren = List.RemoveNulls({")
        for item in list_items(renames):
            match = re.fullmatch(
                rf'if Find \( \{{ (?P<aliases>{strings}) \}} \) <> null then '
                r'\{ Find \( \{ (?P=aliases) \} \) , "(?P<name>\w+)" \} else null',
                " ".join(item))
            if match and f'"{match["name"].lower()}"' in m_tokens(match["aliases"]):
                names.add(match["name"])
    return names


def check():
    for folder, label in (
        ("1. Local CSV", "Local CSV"),
        ("2. Fabric", "Fabric"),
        ("3. Viva Direct", "Viva Direct"),
    ):
        path = ROOT / folder / f"Consumption Central - {label}.pbit"
        with zipfile.ZipFile(path) as package:
            assert package.testzip() is None, f"Invalid ZIP: {path}"
            model = json.loads(decode(package.read("DataModelSchema")))["model"]
        tables = {table["name"]: table for table in model["tables"]}
        expressions = {item["name"]: text(item["expression"])
                       for item in model.get("expressions", [])}
        for name, columns in CONTRACTS.items():
            table = tables[name]
            actual_columns = {column["name"] for column in table["columns"]}
            assert columns <= actual_columns, (label, name, columns - actual_columns)
            partition = table["partitions"][0]["source"]
            assert partition["type"] == "m", (label, name, partition["type"])
            query = text(partition["expression"])
            bindings = input_bindings(query)
            assert columns <= bindings, (label, name, columns - bindings, "missing input binding")
            if label == "Fabric":
                source = "azure_ai_spend" if name == "AzureAiSpend" else "azure_ai_tokens"
                assert re.search(r'GetTable\(\s*"' + source + r'"\s*\)', query)
                assert "FabricSource" in expressions["GetTable"]
                assert "Sql.Database(FabricSQLEndpoint, LakehouseName)" in expressions["FabricSource"]
                assert '"dbo"' in expressions["GetTable"]
            else:
                filename = "azureaispenddaily" if name == "AzureAiSpend" else "azureaitokensdaily"
                assert "GetDataFile(" in query and f'"{filename}"' in query
                files = m_tokens(expressions["DataFiles"])
                if "SourceFiles" in expressions:
                    # Viva Direct lists its files once, in SourceFiles, which reads DataFolder.
                    assert "SourceFiles" in files, (label, "DataFiles does not read SourceFiles")
                    files = m_tokens(expressions["SourceFiles"])
                assert "DataFolder" in files, (label, "the data files do not come from DataFolder")
        assert "AzureAiDeployments" not in tables, "Update the documented inventory support"
        print(f"{label}: canonical Azure spend/metrics reader contracts match")
    print("Static contract check only; no M execution, Azure calls or Service refresh.")


if __name__ == "__main__":
    check()
