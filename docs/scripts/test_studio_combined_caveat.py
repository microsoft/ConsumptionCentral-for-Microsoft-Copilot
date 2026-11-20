"""Regression checks for the Studio caveat and signed-template preservation."""

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_studio_combined_caveat as fix  # noqa: E402


class CombinedCaveat(unittest.TestCase):
    def test_every_active_template_ships_the_neutral_caveat(self):
        for path in fix.TEMPLATES:
            with self.subTest(template=path.name):
                raw = path.read_bytes()
                self.assertEqual(fix.build(raw), (raw, []))
                model = fix.layout_for(fix.Package(raw).contents[fix.SCHEMA], fix.SCHEMA)[0]
                measure = fix.measure(model["model"], "Settings", "Combined Caveat")
                self.assertEqual(measure["expression"], fix.EXPRESSION)
                self.assertEqual(measure["description"], fix.DESCRIPTION)

    def test_both_legacy_variants_are_repaired_without_changing_other_fields_or_raw_parts(self):
        for path in fix.TEMPLATES:
            package = fix.Package(path.read_bytes())
            for old in (fix.OLD_IF, fix.OLD_SWITCH):
                with self.subTest(template=path.name, variant="IF" if old == fix.OLD_IF else "SWITCH"):
                    model, encode = fix.layout_for(package.contents[fix.SCHEMA], fix.SCHEMA)
                    record = fix.measure(model["model"], "Settings", "Combined Caveat")
                    record["expression"] = old.split("\n")
                    record["description"] = fix.OLD_DESCRIPTION.split("\n")
                    raw = package.rebuild({fix.SCHEMA: encode(model)})
                    corrected, edits = fix.build(raw)
                    self.assertTrue(edits)
                    self.assertEqual(fix.build(corrected), (corrected, []))
                    before, after = fix.Package(raw), fix.Package(corrected)
                    for name in before.locals:
                        if name != fix.SCHEMA:
                            self.assertEqual(before.locals[name], after.locals[name], name)
                    updated = fix.layout_for(after.contents[fix.SCHEMA], fix.SCHEMA)[0]
                    expected = copy.deepcopy(model)
                    expected_measure = fix.measure(expected["model"], "Settings", "Combined Caveat")
                    expected_measure["expression"] = fix.EXPRESSION
                    expected_measure["description"] = fix.DESCRIPTION
                    self.assertEqual(updated, expected)

    def test_unknown_expression_or_description_is_not_overwritten(self):
        package = fix.Package(fix.TEMPLATES[0].read_bytes())
        for field in ("expression", "description"):
            with self.subTest(field=field):
                model, encode = fix.layout_for(package.contents[fix.SCHEMA], fix.SCHEMA)
                fix.measure(model["model"], "Settings", "Combined Caveat")[field] = '"Unexpected edit"'
                with self.assertRaisesRegex(ValueError, "has changed"):
                    fix.build(package.rebuild({fix.SCHEMA: encode(model)}))

    def test_no_gap_or_data_presence_branch_can_claim_attribution_or_completeness(self):
        # A single DAX string literal is independent of positive/zero/negative/blank totals.
        self.assertEqual(fix.EXPRESSION, f'"{fix.CAVEAT}"')
        self.assertNotIn('"', fix.CAVEAT, "the DAX literal needs no escaping")
        self.assertIn("does not identify unattributed usage or establish completeness", fix.CAVEAT)
        self.assertIn("coverage, dates and billing definitions", fix.CAVEAT)
        self.assertNotIn("nothing is missing", fix.CAVEAT)
        self.assertNotIn("No Copilot Studio data loaded", fix.CAVEAT)


if __name__ == "__main__":
    unittest.main()
