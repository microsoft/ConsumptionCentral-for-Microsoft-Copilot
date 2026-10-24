"""Load Status notebook: the dbo.load_log rows and failure reasons, matching the installer."""
import json
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path

INSTALLER = Path(__file__).resolve().parents[2]
NOTEBOOK = INSTALLER / "assets" / "notebooks" / "ConsumptionCentral_Load_Status.ipynb"
RUN_ID = "00000000-0000-0000-0000-000000000001"


def cells():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    return notebook, ["".join(c["source"]) for c in notebook["cells"] if c["cell_type"] == "code"]


def namespace():
    _, code = cells()
    scope = {}
    exec(code[0], scope)  # config
    exec(code[1], scope)  # pure helpers
    return scope


def status(s):
    return json.loads(s["STATUS_JSON"])


def run(name, state, start, error=None, kind="TridentNotebook", ms=1000):
    return {"activityName": name, "activityType": kind, "status": state, "activityRunStart": start,
            "activityRunEnd": start, "durationInMs": ms, "error": error or {}}


class LoadStatusTests(unittest.TestCase):
    def test_notebook_is_clean(self):
        notebook, code = cells()
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
        for source in code:
            compile(source, str(NOTEBOOK), "exec")
        s = namespace()
        self.assertEqual(s["PIPELINE_RUN_ID"], "")
        self.assertEqual(s["LOG_TABLE"], "dbo.load_log")
        self.assertIn("ConsumptionCentralInstaller.exe rerun-failed", code[2])

    def test_failures_are_explained_in_plain_words(self):
        s = namespace()
        reasons = status(s)["reasons"]
        cases = {
            "capacity": {"errorCode": "TooManyRequestsForCapacity", "message": "Spark capacity limit reached"},
            "signIn": {"errorCode": "2011", "message": "AADSTS7000215: Invalid client secret provided."},
            "timeout": {"errorCode": "2104", "message": "The notebook timed out after 2 hours"},
            "noData": {"errorCode": "2011", "message": "PATH_NOT_FOUND: Files/landing/studio"},
            "notSynced": {"errorCode": "2011", "message": "Table 'studio_tenant_daily' is not in database"},
        }
        for kind, error in cases.items():
            with self.subTest(kind=kind):
                self.assertEqual(s["classify"](error, reasons)[0], kind)
        self.assertEqual(s["classify"]({"errorCode": 430, "message": ""}, reasons)[0], "capacity")
        self.assertEqual(s["classify"]({"message": "\n  KeyError: 'x'\nmore"}, reasons), ("other", "It stopped with an error: KeyError: 'x'"))
        self.assertEqual(s["classify"](None, reasons), ("other", "It stopped without saying why."))

    def test_unsigned_cowork_dataflow_needs_sign_in_only_on_its_own_step(self):
        s = namespace()
        st = status(s)
        error = {"errorCode": "JobInstanceFailed", "message": "Job instance failed without detail error"}
        kind, text = s["classify"](error, st["reasons"], "Refresh_Cowork_Credits")
        self.assertEqual(kind, "signIn")
        self.assertTrue(text.startswith("Needs sign-in: the Cowork Dataflow's connections aren't signed in"))
        self.assertEqual(s["classify"](error, st["reasons"], "Run_Consumption_Viva")[0], "other")
        self.assertEqual(s["classify"](error, st["reasons"])[0], "other")
        t = "2026-06-01T10:00:00Z"
        last = s["last_attempts"]([run("Refresh_Cowork_Credits", "Failed", t, error, kind="RefreshDataflow")])
        row = s["rows"](last, st["labels"], st["reasons"], RUN_ID, datetime(2026, 6, 1, 12, 0))[0]
        self.assertEqual((row["source"], row["reason_kind"]), ("Cowork credits (Viva Insights Dataflow)", "signIn"))

    def test_last_attempt_counts_the_tries(self):
        s = namespace()
        last = s["last_attempts"]([
            run("Run_Consumption_Studio", "Succeeded", "2026-06-01T10:05:00Z"),
            run("Run_Consumption_Studio", "Failed", "2026-06-01T10:00:00Z", {"errorCode": "430"}),
            run("Run_Org_Data", "Succeeded", "2026-06-01T10:01:00Z"),
        ])
        self.assertEqual(last["Run_Consumption_Studio"]["status"], "Succeeded")
        self.assertEqual(last["Run_Consumption_Studio"]["attempts"], 2)
        self.assertEqual(last["Run_Org_Data"]["attempts"], 1)

    def test_failed_loads_leave_out_conditions_and_this_step(self):
        s = namespace()
        t = "2026-06-01T10:00:00Z"
        last = s["last_attempts"]([
            run("Run_Upload_Router", "Succeeded", t),
            run("Run_Consumption_Azure_AI", "Failed", t, {"message": "403 Forbidden"}),
            run("Run_Consumption_GitHub", "Cancelled", t),
            run("Conditionally_Refresh_Cowork_Credits", "Failed", t, kind="IfCondition"),
            run("Refresh_Consumption_Model", "TimedOut", t),
            run("Record_Load_Status", "Failed", t),
        ])
        self.assertEqual(s["failed_loads"](last),
                         ["Run_Consumption_Azure_AI", "Run_Consumption_GitHub", "Refresh_Consumption_Model"])

    def test_rows_hold_plain_reasons_and_skip_the_bookkeeping_steps(self):
        s = namespace()
        st = status(s)
        logged = datetime(2026, 6, 1, 12, 0)
        last = s["last_attempts"]([
            run("Run_Consumption_Studio", "Failed", "2026-06-01T10:00:00.1234567Z", {"errorCode": "TooManyRequestsForCapacity", "message": "busy"}, ms=2500),
            run("Run_Org_Data", "Succeeded", "2026-06-01T10:01:00Z"),
            run("Run_Some_NewThing", "Skipped", "2026-06-01T10:02:00Z", ms=None),
            run("Conditionally_Refresh_Cowork_Credits", "Succeeded", "2026-06-01T10:02:00Z", kind="IfCondition"),
            run("Record_Load_Status", "InProgress", "2026-06-01T10:03:00Z"),
        ])
        out = {r["activity"]: r for r in s["rows"](last, st["labels"], st["reasons"], RUN_ID, logged)}
        self.assertEqual(set(out), {"Run_Consumption_Studio", "Run_Org_Data", "Run_Some_NewThing"})
        studio = out["Run_Consumption_Studio"]
        self.assertEqual((studio["source"], studio["status"], studio["reason_kind"]), ("Copilot Studio credits", "Failed", "capacity"))
        self.assertEqual(studio["error_code"], "TooManyRequestsForCapacity")
        self.assertEqual(studio["duration_seconds"], 2.5)
        self.assertEqual(studio["started_at"], datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc))
        self.assertEqual((studio["run_id"], studio["logged_at"]), (RUN_ID, logged))
        org = out["Run_Org_Data"]
        self.assertEqual((org["source"], org["reason"], org["error_code"], org["error_message"]), ("Org data", None, None, None))
        new = out["Run_Some_NewThing"]
        self.assertEqual((new["source"], new["duration_seconds"]), ("Some New Thing", None))

    def test_status_table_rows_turn_a_success_into_a_warning(self):
        s = namespace()
        rules = status(s)["warnings"]
        w = s["warning"]
        probes = [{"item": "source_a", "status": "forbidden"}, {"item": "source_b", "status": "ok"},
                  {"item": "source_c", "status": "forbidden"}]
        self.assertEqual(w(probes, rules), ("forbidden", "It ran, but wasn't allowed to read source_a, source_c."))
        self.assertEqual(w([{"item": "a", "status": "unlicensed"}, {"item": "b", "status": "ok"}], rules)[0], "unlicensed")
        self.assertEqual(w([{"item": "a", "status": "error"}], rules)[0], "other")
        envs = [{"item": "Default", "status": "empty"}, {"item": "Sales", "status": "Empty"}]
        self.assertEqual(w(envs, rules), ("empty", "It ran, but found nothing to load in Default, Sales."))
        # Empty is only a warning when nothing loaded; an empty probe beside a full one is fine.
        self.assertIsNone(w([{"item": "Default", "status": "empty"}, {"item": "Sales", "status": "ok"}], rules))
        self.assertIsNone(w([{"item": "a", "status": "ok"}, {"item": "b", "status": "skipped"}], rules))
        self.assertIsNone(w([], rules))
        # Forbidden wins over empty.
        self.assertEqual(w([{"item": "a", "status": "empty"}, {"item": "b", "status": "forbidden"}], rules)[0], "forbidden")

    def test_no_load_writes_a_status_table_yet(self):
        # The Viva load reports through its own JSON summary, which the installer reads.
        self.assertEqual(status(namespace())["statusTables"], [])

    def test_warning_rows_are_recorded_as_warning_not_succeeded(self):
        s = namespace()
        st = status(s)
        t = "2026-06-01T10:00:00Z"
        last = s["last_attempts"]([
            run("Run_Consumption_Azure_AI", "Succeeded", t),
            run("Run_Consumption_Studio", "Succeeded", t),
            run("Run_Org_Data", "Succeeded", t),
            run("Run_Consumption_GitHub", "Failed", t, {"message": "boom"}),
        ])
        warnings = {
            "Run_Consumption_Azure_AI": ("forbidden", "It ran, but wasn't allowed to read source_a."),
            "Run_Consumption_Studio": ("empty", "It ran, but found nothing to load in Default."),
            "Run_Consumption_GitHub": ("unlicensed", "ignored: it failed"),
        }
        out = {r["activity"]: r for r in s["rows"](last, st["labels"], st["reasons"], RUN_ID, datetime(2026, 6, 1), warnings)}
        azure = out["Run_Consumption_Azure_AI"]
        self.assertEqual((azure["status"], azure["reason_kind"]), ("Warning", "forbidden"))
        self.assertIn("source_a", azure["reason"])
        self.assertEqual((out["Run_Consumption_Studio"]["status"], out["Run_Consumption_Studio"]["reason_kind"]), ("Warning", "empty"))
        self.assertEqual((out["Run_Org_Data"]["status"], out["Run_Org_Data"]["reason"]), ("Succeeded", None))
        self.assertEqual((out["Run_Consumption_GitHub"]["status"], out["Run_Consumption_GitHub"]["reason_kind"]), ("Failed", "other"))
        # A warning isn't a failure, so it doesn't fail the run.
        self.assertEqual(s["failed_loads"](last), ["Run_Consumption_GitHub"])

    def test_record_hands_the_warnings_to_the_installer(self):
        _, code = cells()
        self.assertIn("notebookutils.notebook.exit(SUMMARY)", code[2])
        self.assertIn("load_warnings={SUMMARY}", code[2])

    def test_window_covers_the_run(self):
        s = namespace()
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        after, before = s["window"]("2026-06-01T09:30:00.1234567Z", now)
        self.assertEqual(after, datetime(2026, 6, 1, 8, 30, tzinfo=timezone.utc))
        self.assertEqual(before, datetime(2026, 6, 1, 13, 0, tzinfo=timezone.utc))
        self.assertEqual(s["window"]("", now)[0], datetime(2026, 5, 30, 11, 0, tzinfo=timezone.utc))
        self.assertIsNone(s["parse_time"]("not a time"))

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_labels_and_reasons_match_the_installer(self):
        script = "import('./src/loads.js').then(m => process.stdout.write(m.statusConfigJson()))"
        out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=INSTALLER, capture_output=True,
                             text=True, check=True, encoding="utf-8").stdout
        self.assertEqual(status(namespace()), json.loads(out))


if __name__ == "__main__":
    unittest.main()
