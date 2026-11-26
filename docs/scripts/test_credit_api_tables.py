import copy
import unittest

from fix_credit_api_tables import TABLES, build
from fix_limit_and_token_measures import TEMPLATES
from fix_pbit_defaults import layout_for
from fix_viva_query_org import Package, PatchError


class CreditTables(unittest.TestCase):
    def test_views_are_optional_synchronized_and_leave_existing_model_untouched(self):
        for path in TEMPLATES:
            with self.subTest(path=path.parent.name):
                original = Package(path.read_bytes())
                candidate, _ = build(path.read_bytes())
                repaired = Package(candidate)
                schema = layout_for(repaired.contents["DataModelSchema"], "schema")[0]
                pending = layout_for(repaired.contents["UnappliedChanges"], "pending")[0]
                before = layout_for(original.contents["DataModelSchema"], "schema")[0]
                masked = copy.deepcopy(schema)
                masked["model"]["tables"] = [t for t in masked["model"]["tables"] if t["name"] not in TABLES]
                before["model"]["tables"] = [t for t in before["model"]["tables"] if t["name"] not in TABLES]
                self.assertEqual(before, masked)
                for name in TABLES:
                    table = next(t for t in schema["model"]["tables"] if t["name"] == name)
                    query = next(q for q in pending["queries"] if q["name"] == name)
                    self.assertEqual(table["partitions"][0]["source"]["expression"], query["text"])
                    self.assertIn("Source = if", "\n".join(query["text"]))
                self.assertEqual(build(candidate), (candidate, []))
                for part in original.contents:
                    if part not in ("DataModelSchema", "UnappliedChanges"):
                        self.assertEqual(original.contents[part], repaired.contents[part])

    def test_unexpected_credit_table_edit_is_rejected(self):
        candidate, _ = build(TEMPLATES[0].read_bytes())
        package = Package(candidate)
        schema, encode = layout_for(package.contents["DataModelSchema"], "schema")
        next(t for t in schema["model"]["tables"] if t["name"] in TABLES)["description"] = "unexpected"
        changed = package.rebuild({"DataModelSchema": encode(schema)})
        with self.assertRaises(PatchError):
            build(changed)


if __name__ == "__main__":
    unittest.main()
