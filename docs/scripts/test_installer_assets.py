"""Contract tests for installer-assets.json, the one list of what the installer deploys.

The installer and its exe build read every path from the manifest, and they edit each notebook the
way the Analytics Hub installer does (installer/src/transform/notebook.js at 1af87db): set the
`NAME = ...` lines that `assignmentPattern` finds, and replace text that occurs exactly once. These
tests keep the manifest, the notebooks and the Fabric template in step, so a renamed setting, table
or column fails here instead of halfway through an install.

Run: python docs/scripts/test_installer_assets.py
Standard library only. Reads the templates and notebooks; writes nothing.
"""
import ast
import json
import re
import sys
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_pbit_defaults import decode  # noqa: E402

MANIFEST = ROOT / "installer-assets.json"
NOTEBOOK_DIR = ROOT / "2. Fabric" / "notebooks"

TOP_LEVEL = {"$comment", "version", "templates", "notebooks", "app"}
NOTEBOOK_FIELDS = {"key", "name", "path", "credentials", "values", "expressions", "patches", "secret",
                   "reads", "writes", "landing", "loadSummary", "run", "exclusiveGroup"}
LIST_FIELDS = ("values", "expressions", "patches", "reads", "writes")
RUN_MODES = {"pipeline", "once", "interactive"}
SECRET_KINDS = {"clientSecret", "githubPat"}
CREDENTIALS = ("TENANT_ID", "CLIENT_ID", "CLIENT_SECRET")

# The installer's own code edits these notebooks by key, whatever the manifest says. Mirrors the
# Analytics Hub installer at 1af87db (installer/src/steps/fabric.js: notebookSettings, PAYG_FIND,
# AZURE_AI_SECRET_FIND; installer/src/catalog.js for the keys it shares).
PAYG_FIND = "PAYG_SUBSCRIPTION_IDS = []"
AZURE_AI_SECRET_FIND = "secret = notebookutils.credentials.getSecret(KEY_VAULT_URL, CLIENT_SECRET_NAME)"
REQUIRED = {
    "azureAi": {"name": "Ingest_Azure_AI", "credentials": False,
                "values": {"SUBSCRIPTION_ID", "TENANT_ID", "CLIENT_ID", "KEY_VAULT_URL", "CLIENT_SECRET_NAME"},
                "patches": {PAYG_FIND, AZURE_AI_SECRET_FIND}},
    "studioConsumption": {"name": "Ingest_Studio", "credentials": True},
    "vivaConsumption": {"name": "Ingest_Viva_Consumption", "credentials": False},
    "orgGraph": {"name": "Ingest_Org_Graph", "credentials": True},
}

# A pipeline run passes no parameters, so these shipped defaults are what an unattended run does.
PIPELINE_DEFAULTS = {
    "Ingest_Azure_AI": {"PAYG_SUBSCRIPTION_IDS": "[]"},
    "Ingest_Studio": {"READ_API_FILES": "False"},
    "Ingest_Viva_Consumption": {"ALLOW_EMPTY_LANDING": "True", "ARCHIVE_AFTER_LOAD": "False"},
    "Ingest_Org_Graph": {"ALLOW_EMPTY_SNAPSHOT": "False", "WRITE_MODE": "'overwrite'"},
}

# The schema constant Ingest_Azure_AI writes each of its tables with.
AZURE_SCHEMAS = {
    "azure_ai_spend": "SPEND_SCHEMA",
    "azure_ai_tokens": "TOKENS_SCHEMA",
    "copilot_payg_spend": "PAYG_SCHEMA",
    "azure_deployment_health": "HEALTH_SCHEMA",
    "azure_solution_spend": "SOLUTION_SCHEMA",
    "azure_billing_reconciliation": "RECON_SCHEMA",
}

GET_TABLE_CALL = re.compile(r'\bGetTable\s*\(\s*"([^"]+)"\s*\)')
GET_TABLE_LIST = re.compile(r"\bList\.Transform\(\s*([A-Za-z_]\w*)\s*,\s*GetTable\s*\)")


def load_manifest():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def cell_text(cell):
    source = cell.get("source", "")
    return "".join(source) if isinstance(source, list) else source


def code_cells(path):
    notebook = json.loads((ROOT / path).read_text(encoding="utf-8"))
    return [cell_text(c) for c in notebook["cells"] if c["cell_type"] == "code"]


def assignment_pattern(name):
    """Python port of assignmentPattern in the Analytics Hub installer's transform/notebook.js."""
    return re.compile(
        rf"^({name}[ \t]*=[ \t]*)('(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|[^#\n]*?)"
        r"(?:([ \t]+)(#[^\n]*))?[ \t]*$", re.M)


def assignments(cells, name):
    pattern = assignment_pattern(name)
    return [match for cell in cells for match in pattern.finditer(cell)]


def quoted(cells, text):
    return any(f'"{text}"' in cell or f"'{text}'" in cell for cell in cells)


def schema_constants(cells):
    """`X_SCHEMA = ("Name type, ...")` constants, as column-name lists."""
    found = {}
    for cell in cells:
        for node in ast.walk(ast.parse(cell)):
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name) and node.targets[0].id.endswith("_SCHEMA")
                    and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
                parts = [part.split() for part in node.value.value.split(",") if part.strip()]
                if any(len(part) != 2 for part in parts):
                    raise AssertionError(f"{node.targets[0].id}: expected 'Name type' pairs")
                found[node.targets[0].id] = [part[0] for part in parts]
    return found


def alnum_key(name):
    return re.sub(r"[^A-Za-z0-9]", "", name).lower()


def removed_key(name, chars):
    return "".join(ch for ch in name if ch not in chars).lower()


def m_text(expression):
    return "\n".join(expression) if isinstance(expression, list) else (expression or "")


def strip_m_comments(text):
    """Drops // and /* */ comments, leaving string literals (which may hold "//") alone."""
    out, i, n = [], 0, len(text)
    while i < n:
        if text[i] == '"':
            j = i + 1
            while j < n:
                if text[j] == '"' and (j + 1 >= n or text[j + 1] != '"'):
                    break
                j += 2 if text[j] == '"' else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            i = text.find("\n", i) if "\n" in text[i:] else n
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def template_model(path):
    with zipfile.ZipFile(ROOT / path) as package:
        return json.loads(decode(package.read("DataModelSchema")))["model"]


def template_parameters(model):
    return {e["name"] for e in model.get("expressions", [])
            if re.search(r"\bIsParameterQuery\s*=\s*true\b", m_text(e.get("expression")), re.I)}


def m_bodies(model):
    """Every M body in a model, keyed "expression <name>" or "table <name>", comments removed."""
    bodies = {f"expression {e['name']}": m_text(e.get("expression")) for e in model.get("expressions", [])}
    for table in model.get("tables", []):
        parts = [m_text(p["source"]["expression"]) for p in table.get("partitions", [])
                 if "expression" in p.get("source", {})]
        if parts:
            bodies[f"table {table['name']}"] = "\n".join(parts)
    return {name: strip_m_comments(body) for name, body in bodies.items()}


def m_strings(text):
    return [s.replace('""', '"') for s in re.findall(r'"((?:[^"]|"")*)"', text)]


def m_list(body, name):
    """The quoted items of a flat `name = {...}` list literal, or None if there is none."""
    match = re.search(rf"\b{re.escape(name)}\s*=\s*\{{([^{{}}]*)\}}", body)
    return m_strings(match.group(1)) if match else None


def call_arguments(body, start):
    """Top-level arguments of the call whose "(" ends at `start`, as source text."""
    depth, args, current, i = 0, [], [], start
    while i < len(body):
        ch = body[i]
        if ch == '"':
            end = i + 1
            while end < len(body) and not (body[end] == '"' and body[end + 1:end + 2] != '"'):
                end += 2 if body[end] == '"' else 1
            current.append(body[i:end + 1])
            i = end + 1
            continue
        if ch in "({[":
            depth += 1
        elif ch in ")}]":
            if depth == 0:
                args.append("".join(current).strip())
                return args
            depth -= 1
        elif ch == "," and depth == 0:
            args.append("".join(current).strip())
            current, i = [], i + 1
            continue
        current.append(ch)
        i += 1
    raise AssertionError("unterminated call")


class Manifest(unittest.TestCase):
    """The manifest's own shape, and that it lists exactly what ships."""

    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.notebooks = cls.manifest["notebooks"]

    def test_top_level(self):
        self.assertEqual(set(self.manifest), TOP_LEVEL)
        self.assertEqual(self.manifest["version"], 1)
        self.assertIsInstance(self.manifest["$comment"], str)

    def test_comment_points_at_a_real_section(self):
        doc, anchor = re.search(r"([\w./-]+\.md)#([\w-]+)", self.manifest["$comment"]).groups()
        headings = re.findall(r"^#{1,6}\s+(.*?)\s*$", (ROOT / doc).read_text(encoding="utf-8"), re.M)
        slugs = {re.sub(r"[ \t]", "-", re.sub(r"[^\w\s-]", "", h.lower()).strip()) for h in headings}
        self.assertIn(anchor, slugs, f"{doc} has no heading for #{anchor}")

    def test_every_path_exists(self):
        paths = [t["path"] for t in self.manifest["templates"].values()]
        paths += [n["path"] for n in self.notebooks] + [self.manifest["app"]["path"]]
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).exists(), f"{path} does not exist")
        self.assertTrue((ROOT / self.manifest["app"]["path"]).is_dir())
        self.assertEqual(set(self.manifest["app"]), {"path"})

    def test_templates_are_the_shipped_pbits(self):
        shipped = {p.relative_to(ROOT).as_posix() for p in ROOT.glob("*/*.pbit") if p.parent.name != "archive"}
        listed = {t["path"] for t in self.manifest["templates"].values()}
        self.assertEqual(listed, shipped, "add or remove the template in installer-assets.json")
        for key, template in self.manifest["templates"].items():
            with self.subTest(template=key):
                self.assertEqual(set(template), {"path", "parameters"})
                self.assertTrue(template["parameters"])
                self.assertEqual(len(template["parameters"]), len(set(template["parameters"])))

    def test_notebooks_are_exactly_the_folder(self):
        on_disk = sorted(p.relative_to(ROOT).as_posix() for p in NOTEBOOK_DIR.glob("*.ipynb"))
        listed = sorted(n["path"] for n in self.notebooks)
        self.assertEqual(listed, on_disk, "every notebook in 2. Fabric/notebooks needs a manifest entry")

    def test_notebook_fields(self):
        keys = [n["key"] for n in self.notebooks]
        self.assertEqual(len(keys), len(set(keys)), "keys must be unique")
        for nb in self.notebooks:
            with self.subTest(notebook=nb.get("key")):
                self.assertEqual(set(nb), NOTEBOOK_FIELDS)
                self.assertRegex(nb["key"], r"^[a-z][A-Za-z0-9]*$")
                self.assertEqual(nb["name"], Path(nb["path"]).stem)
                self.assertIsInstance(nb["credentials"], bool)
                for field in LIST_FIELDS:
                    items = nb[field]
                    self.assertIsInstance(items, list, field)
                    self.assertTrue(all(isinstance(i, str) and i for i in items), field)
                    self.assertEqual(len(items), len(set(items)), f"{field} repeats an entry")
                self.assertTrue(nb["writes"], "every notebook writes at least one table")
                self.assertFalse(set(nb["values"]) & set(nb["expressions"]))
                if nb["credentials"]:
                    self.assertFalse(set(CREDENTIALS) & set(nb["values"] + nb["expressions"]),
                                     "credentials are set by the credentials step, not as values")
                self.assertIn(nb["run"], RUN_MODES)
                if nb["landing"] is not None:
                    self.assertRegex(nb["landing"], r"^Files/landing/[^/]+$")
                if nb["loadSummary"] is not None:
                    self.assertRegex(nb["loadSummary"], r"^Files/.+\.json$")
                self.assertTrue(nb["exclusiveGroup"] is None or isinstance(nb["exclusiveGroup"], str))
                secret = nb["secret"]
                if secret is not None:
                    self.assertEqual(set(secret), {"kind", "name"})
                    self.assertIn(secret["kind"], SECRET_KINDS)
                    self.assertTrue(secret["name"] is None or isinstance(secret["name"], str))

    def test_installer_keys_and_hooks(self):
        by_key = {n["key"]: n for n in self.notebooks}
        for key, want in REQUIRED.items():
            with self.subTest(key=key):
                self.assertIn(key, by_key)
                nb = by_key[key]
                self.assertEqual(nb["name"], want["name"])
                self.assertIs(nb["credentials"], want["credentials"])
                self.assertLessEqual(want.get("values", set()), set(nb["values"]))
                self.assertLessEqual(want.get("patches", set()), set(nb["patches"]))

    def test_run_order(self):
        """A notebook runs after every notebook that writes a table it reads."""
        for i, nb in enumerate(self.notebooks):
            for table in nb["reads"]:
                for j, other in enumerate(self.notebooks):
                    if table in other["writes"]:
                        with self.subTest(reader=nb["key"], writer=other["key"]):
                            self.assertLess(j, i, f"{other['key']} writes {table}, so list it first")

    def test_shared_tables_are_exclusive(self):
        """Two notebooks may write one table only as alternatives: same group, deploy one."""
        writers = {}
        for nb in self.notebooks:
            for table in nb["writes"]:
                writers.setdefault(table, []).append(nb)
        for table, nbs in writers.items():
            if len(nbs) > 1:
                with self.subTest(table=table):
                    groups = {nb["exclusiveGroup"] for nb in nbs}
                    self.assertEqual(len(groups), 1, f"{table} has writers in different groups")
                    self.assertIsNotNone(groups.pop(), f"{table} has several writers but no exclusiveGroup")
        groups = {}
        for nb in self.notebooks:
            if nb["exclusiveGroup"] is not None:
                groups.setdefault(nb["exclusiveGroup"], []).append(nb)
        for group, nbs in groups.items():
            with self.subTest(group=group):
                self.assertGreater(len(nbs), 1, "a group of one excludes nothing")
                self.assertEqual(len({frozenset(nb["writes"]) for nb in nbs}), 1,
                                 "alternatives must write the same tables")


class NotebookHooks(unittest.TestCase):
    """What the installer edits in each notebook is there, once, in the form it expects."""

    @classmethod
    def setUpClass(cls):
        cls.notebooks = [(nb, code_cells(nb["path"])) for nb in load_manifest()["notebooks"]]

    def test_assignments_occur_once(self):
        for nb, cells in self.notebooks:
            names = list(nb["values"]) + list(nb["expressions"])
            if nb["credentials"]:
                names += list(CREDENTIALS)
            for name in names:
                with self.subTest(notebook=nb["name"], name=name):
                    found = assignments(cells, name)
                    self.assertEqual(len(found), 1, f'expected one top-level "{name} = ..." line')

    def test_string_settings_are_strings(self):
        """The installer writes these as Python strings, so the shipped value must be one too."""
        for nb, cells in self.notebooks:
            names = list(nb["values"]) + (["TENANT_ID", "CLIENT_ID"] if nb["credentials"] else [])
            for name in names:
                with self.subTest(notebook=nb["name"], name=name):
                    value = assignments(cells, name)[0].group(2)
                    self.assertRegex(value, r"^['\"]", f"{name} is not a string literal")

    def test_patches_occur_once(self):
        for nb, cells in self.notebooks:
            for find in nb["patches"]:
                with self.subTest(notebook=nb["name"], find=find):
                    self.assertEqual(sum(cell.count(find) for cell in cells), 1)

    def test_declared_names_are_in_the_notebook(self):
        for nb, cells in self.notebooks:
            texts = nb["writes"] + nb["reads"] + [nb["landing"], nb["loadSummary"]]
            if nb["secret"] and nb["secret"]["name"]:
                texts.append(nb["secret"]["name"])
            for text in filter(None, texts):
                with self.subTest(notebook=nb["name"], text=text):
                    self.assertTrue(quoted(cells, text), f"{text!r} is not a literal in {nb['name']}")

    def test_secret_matches_how_the_notebook_authenticates(self):
        for nb, cells in self.notebooks:
            secret = nb["secret"]
            with self.subTest(notebook=nb["name"]):
                if nb["credentials"]:
                    self.assertEqual(secret, {"kind": "clientSecret", "name": None},
                                     "the installer names the secret it writes into CLIENT_SECRET")
                elif secret and secret["kind"] == "clientSecret":
                    self.assertLessEqual({"KEY_VAULT_URL", "CLIENT_SECRET_NAME"}, set(nb["values"]))
                    value = assignments(cells, "CLIENT_SECRET_NAME")[0].group(2)
                    self.assertEqual(ast.literal_eval(value), secret["name"])
                elif secret and secret["kind"] == "githubPat":
                    self.assertIn("TOKEN", nb["expressions"])
                    value = assignments(cells, "TOKEN")[0].group(2)
                    self.assertIn("notebookutils.credentials.getSecret(", value)
                    self.assertIn(secret["name"], value)
                else:
                    self.assertIsNone(secret)
                    self.assertFalse({"KEY_VAULT_URL", "CLIENT_SECRET_NAME", "TOKEN"}
                                     & set(nb["values"] + nb["expressions"]))

    def test_pipeline_defaults_are_safe(self):
        by_name = {nb["name"]: (nb, cells) for nb, cells in self.notebooks}
        for name, defaults in PIPELINE_DEFAULTS.items():
            nb, cells = by_name[name]
            self.assertEqual(nb["run"], "pipeline")
            for setting, value in defaults.items():
                with self.subTest(notebook=name, setting=setting):
                    found = assignments(cells, setting)
                    self.assertEqual(len(found), 1)
                    self.assertEqual(found[0].group(2).strip(), value)


class FabricTemplate(unittest.TestCase):
    """Everything the Fabric template reads from the Lakehouse is written by a listed notebook."""

    @classmethod
    def setUpClass(cls):
        manifest = load_manifest()
        cls.manifest = manifest
        cls.model = template_model(manifest["templates"]["fabric"]["path"])
        cls.bodies = m_bodies(cls.model)
        cls.writers = {}
        for nb in manifest["notebooks"]:
            for table in nb["writes"]:
                cls.writers.setdefault(table, []).append(nb)
        cls.cells = {nb["key"]: code_cells(nb["path"]) for nb in manifest["notebooks"]}

    def reads(self):
        tables = {}
        for name, body in self.bodies.items():
            for table in GET_TABLE_CALL.findall(body):
                tables.setdefault(table, set()).add(name)
            for variable in GET_TABLE_LIST.findall(body):
                items = m_list(body, variable)
                self.assertTrue(items, f"{name}: {variable} is not a list literal of table names")
                for table in items:
                    tables.setdefault(table, set()).add(name)
        return tables

    def body(self, name):
        self.assertIn(name, self.bodies, f"the Fabric template has no {name}")
        return self.bodies[name]

    def columns(self, table):
        """The explicit schema the writing notebook declares for `table`."""
        nb = self.writers[table][0]
        schemas = schema_constants(self.cells[nb["key"]])
        self.assertIn(AZURE_SCHEMAS[table], schemas, f"{nb['name']} no longer declares {AZURE_SCHEMAS[table]}")
        return schemas[AZURE_SCHEMAS[table]]

    def test_every_listed_parameter_exists(self):
        """A subset, not equal: a template may gain parameters the installer leaves at default."""
        for key, template in self.manifest["templates"].items():
            with self.subTest(template=key):
                have = template_parameters(template_model(template["path"]))
                self.assertLessEqual(set(template["parameters"]), have)

    def test_every_table_read_is_written(self):
        reads = self.reads()
        self.assertIn("viva_credits_weekly", reads)
        for table, readers in sorted(reads.items()):
            with self.subTest(table=table):
                self.assertIn(table, self.writers, f"read by {sorted(readers)} but no notebook writes it")

    def test_every_get_table_use_is_checked(self):
        """A read through a variable the test cannot resolve would escape the check above."""
        for name, body in self.bodies.items():
            if name == "expression GetTable":
                continue
            with self.subTest(body=name):
                uses = len(re.findall(r"\bGetTable\b", body))
                checked = len(GET_TABLE_CALL.findall(body)) + len(GET_TABLE_LIST.findall(body))
                self.assertEqual(uses, checked, "GetTable used other than GetTable(\"table\") or "
                                                "List.Transform(<list literal>, GetTable)")

    def test_azure_feeds_supply_every_documented_column(self):
        """The strict feeds error unless every name in Names binds to exactly one column."""
        feeds = {}
        for name, body in self.bodies.items():
            if '"AzureFeedSchema"' in body:
                (table,) = GET_TABLE_CALL.findall(body)
                feeds[table] = m_list(body, "Names")
        self.assertLessEqual({"azure_solution_spend", "azure_deployment_health",
                              "azure_billing_reconciliation"}, set(feeds))
        for table, names in feeds.items():
            columns = self.columns(table)
            for wanted in names:
                with self.subTest(table=table, column=wanted):
                    matches = [c for c in columns if c == wanted] or [
                        c for c in columns if removed_key(c, " _-.") == removed_key(wanted, " _-.")]
                    self.assertEqual(len(matches), 1, f"{wanted} must bind to exactly one column")

    def test_azure_spend_binds_required_columns(self):
        """Port of the AzureAiSpend Normalize binding: required columns bind, none twice."""
        body = self.body("table AzureAiSpend")
        start = re.search(r"\bNormalize\(\s*Raw\s*,", body)
        self.assertTrue(start, "AzureAiSpend no longer calls Normalize(Raw, ...)")
        _, specs_text, required_text = call_arguments(body, body.index("(", start.start()) + 1)
        specs = []
        for canonical, aliases in re.findall(r'\{\s*"(\w+)"\s*,\s*(\{[^{}]*\}|[A-Za-z_]\w*)\s*\}', specs_text):
            specs.append((canonical, m_strings(aliases) if aliases.startswith("{")
                          else (m_list(body, aliases) or [])))
        required = m_strings(required_text)
        self.assertIn("Cost", dict(specs))
        self.assertTrue(required)
        columns = self.columns("azure_ai_spend")
        bound = {}
        for canonical, aliases in specs:
            candidates = [[alias] if alias in columns else [c for c in columns if alnum_key(c) == alnum_key(alias)]
                          for alias in [canonical] + aliases]
            best = next((c for c in candidates if c), [])
            self.assertLessEqual(len(best), 1, f"{canonical} is ambiguous: {best}")
            bound[canonical] = best[0] if best else None
        for name in required:
            self.assertIsNotNone(bound.get(name), f"azure_ai_spend has no column for {name}")
        hits = [c for c in bound.values() if c]
        self.assertEqual(len(hits), len(set(hits)), "one column binds two canonical names")

    def test_azure_tokens_supply_every_wanted_column(self):
        body = self.body("table AzureAiTokens")
        renames = [(m_strings(aliases), target) for aliases, target
                   in re.findall(r'Find\((\{[^{}]*\})\)\s*,\s*"(\w+)"\s*\}', body)]
        want = m_list(body, "Want")
        self.assertTrue(renames and want)
        columns = set(self.columns("azure_ai_tokens"))
        for aliases, target in renames:
            hit = next((c for c in sorted(columns) if removed_key(c, " _-") in aliases), None)
            if hit:
                columns = (columns - {hit}) | {target}
        for name in want:
            with self.subTest(column=name):
                self.assertIn(name, columns)

    def test_cowork_tasks_supply_every_column(self):
        body = self.body("expression CoworkTaskInput")
        shape = re.search(r"type\s+table\s*\[(.*?)\]", body, re.S)
        self.assertTrue(shape)
        wanted = re.findall(r"(\w+)\s*=", shape.group(1))
        (writer,) = self.writers["cowork_tasks_weekly"]
        task = schema_constants(self.cells[writer["key"]])["TASK_SCHEMA"]
        have = {alnum_key(c) for c in task}
        for name in wanted:
            with self.subTest(column=name):
                self.assertIn(alnum_key(name), have)

    def test_commercial_terms_supply_every_term(self):
        terms = set()
        for body in self.bodies.values():
            terms |= set(re.findall(r'\bTermOrDefault\(\s*"(\w+)"', body))
        self.assertTrue(terms)
        (writer,) = self.writers["commercial_terms"]
        written = set()
        for cell in self.cells[writer["key"]]:
            for node in ast.walk(ast.parse(cell)):
                if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)
                        and any(isinstance(t, ast.Name) and t.id == "values" for t in node.targets)):
                    written |= {k.value for k in node.value.keys if isinstance(k, ast.Constant)}
        self.assertLessEqual(terms, written)

    def test_org_graph_carries_a_person_and_a_department(self):
        id_aliases = set(m_list(self.body("expression VivaOrgFromPeople"), "IdAliases") or [])
        self.assertTrue(id_aliases)
        dept = re.search(r'\{\s*"Department"\s*,\s*(\{[^{}]*\})\s*\}', self.body("expression OrgNormalised"))
        self.assertTrue(dept)
        (writer,) = self.writers["copilot_org_data"]
        text = "\n".join(self.cells[writer["key"]])
        columns = [m[1] for m in re.findall(r"(?:StructField|withColumn)\(\s*(['\"])(.+?)\1", text)]
        keys = {removed_key(c, " _-") for c in columns}
        self.assertTrue(keys & id_aliases, "no column the template can match people on")
        self.assertTrue(keys & set(m_strings(dept.group(1))), "no Department column")


if __name__ == "__main__":
    unittest.main(verbosity=2)
