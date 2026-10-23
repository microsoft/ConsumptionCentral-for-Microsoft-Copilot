"""Upload Router notebook: header detection, refusals and the signatures the installer writes."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

INSTALLER = Path(__file__).resolve().parents[2]
NOTEBOOK = INSTALLER / "assets" / "notebooks" / "ConsumptionCentral_Upload_Router.ipynb"

# Header rows as each export has them (made-up columns only, no tenant data).
HEADERS = {
    "studioTenant": "Billing plan id,Environment id,Capacity type,Prepaid consumed quantity,Usage date",
    "studioAgent": "Agent id,Agent name,Billed credit,Non billed credit,Channel",
    "studioUser": "User id,User email,Credits used,Billable credit used",
    "studioAgentDaily": "Usage date,Agent id,Agent name,Billed credit,Non billed credit,Channel,Environment id",
    "studioUserDaily": "Usage Date,User Id,Environment Id,Agent Id,Billed credit,Non-billed credit,Unit",
    "studioEntitlement": "Snapshot date,Environment id,Environment allocated,Tenant prepaid consumed,Tenant PAYG consumed",
    "vivaCredits": "PersonId,ServiceId,ServiceName,SpendingPolicyId,MetricDate,Total Copilot Credits used,Organization",
    "vivaPolicy": "SpendingPolicyId,Name,PlanLimit,UserLimit,IncludedServices",
    "coworkTasks": "PersonId,MetricDate,TotalCoworkTasks,Organization",
    "coworkPeople": "PeopleHistoricalId,Organization,FunctionType,IsCopilotLicensed",
    "githubUsage": "date,username,product,sku,model,quantity,unit_type,applied_cost_per_quantity,gross_amount,"
                   "discount_amount,net_amount,organization,repository,cost_center_name",
    "githubMap": "username,upn,display_name,plan",
    "orgFile": "UserPrincipalName,Department,JobTitle,Country",
}
REFUSED = {"coworkTasks", "coworkPeople"}


def cells():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    return notebook, ["".join(c["source"]) for c in notebook["cells"] if c["cell_type"] == "code"]


def namespace():
    _, code = cells()
    scope = {}
    exec(code[0], scope)  # config
    exec(code[1], scope)  # pure helpers
    return scope


class UploadRouterTests(unittest.TestCase):
    def test_notebook_is_clean(self):
        notebook, code = cells()
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
        for source in code:
            compile(source, str(NOTEBOOK), "exec")
        self.assertEqual(namespace()["ENABLED_SOURCES"], "")

    def test_every_export_is_recognised(self):
        s = namespace()
        sigs = json.loads(s["SIGNATURES_JSON"])
        self.assertEqual({sig["kind"] for sig in sigs}, set(HEADERS))
        accepted = [dict(sig, policy="replaceKind") for sig in sigs]
        for sig in sigs:
            self.assertEqual(sig.get("policy") == "refuse", sig["kind"] in REFUSED, sig["kind"])
        for kind, line in HEADERS.items():
            with self.subTest(kind=kind):
                found, reason = s["detect"](s["parse_header"](line + "\r\n1,2,3\r\n"), accepted)
                self.assertIsNotNone(found, reason)
                self.assertEqual(found["kind"], kind)

    def test_cowork_task_exports_are_refused_with_what_to_do(self):
        s = namespace()
        sigs = json.loads(s["SIGNATURES_JSON"])
        for kind in REFUSED:
            with self.subTest(kind=kind):
                found, reason = s["detect"](s["parse_header"](HEADERS[kind]), sigs)
                self.assertIsNone(found)
                self.assertIn("PeopleMetaData.csv", reason)
                self.assertIn("consumption-central-installer upload", reason)
        # Skip is checked first, so a skipped source says so rather than how to upload it.
        skipped = s["detect"](s["parse_header"](HEADERS["coworkTasks"]), sigs, s["enabled_set"]("coworkCredits"))
        self.assertIn("set to Skip", skipped[1])

    def test_refusals(self):
        s = namespace()
        sigs = json.loads(s["SIGNATURES_JSON"])
        self.assertEqual(s["detect"]([], sigs), (None, "the file has no header row"))
        self.assertIn("matches no export Consumption Central reads", s["detect"](["Name", "Colour"], sigs)[1])
        tie = HEADERS["vivaPolicy"] + ",ServiceId,ServiceName,MetricDate,TotalCopilotCreditsUsed"
        self.assertIn("more than one export", s["detect"](s["parse_header"](tie), sigs)[1])
        skipped = s["detect"](s["parse_header"](HEADERS["githubMap"]), sigs, s["enabled_set"]("studioCredits"))
        self.assertIn("set to Skip", skipped[1])
        self.assertIsNone(s["enabled_set"](""))

    def test_header_parsing(self):
        s = namespace()
        self.assertEqual(s["parse_header"]('\ufeff"Agent Id","a, ""b""",c\n1'), ["Agent Id", 'a, "b"', "c"])
        self.assertEqual(s["parse_header"]("a;b;c\n"), ["a", "b", "c"])
        self.assertEqual(s["parse_header"](""), [])
        self.assertEqual(s["norm"]("Total Copilot Credits used"), "totalcopilotcreditsused")

    def test_targets(self):
        s = namespace()
        sigs = {sig["kind"]: sig for sig in json.loads(s["SIGNATURES_JSON"])}
        self.assertEqual(s["target_path"](sigs["vivaPolicy"], "20260601T000000Z_001"),
                         "Files/landing/viva/SpendingPolicyMetadata_20260601T000000Z_001.csv")
        self.assertEqual(s["target_path"](sigs["orgFile"], "X"), "Files/landing/org/OrgData_X.csv")
        self.assertEqual(s["kind_prefix"](sigs["githubUsage"]), "GitHubUsage")
        self.assertEqual(s["kind_prefix"](sigs["githubMap"]), "GitHubUserMap")
        self.assertEqual(s["file_key"]("a", 1, "2"), "a|1|2")
        self.assertEqual(s["DROP_DIR"], "Files/consumption_central_uploads")
        self.assertEqual(s["LOG_TABLE"], "dbo.consumption_central_upload_log")
        self.assertTrue(s["SHAREPOINT_DIR"].startswith(s["DROP_DIR"] + "/"))

    def test_kind_prefixes_never_overlap(self):
        # replaceKind retires older files by prefix, so no kind's prefix may start another's in the same folder.
        s = namespace()
        stamped = [sig for sig in json.loads(s["SIGNATURES_JSON"]) if "{stamp}" in sig["name"]]
        prefixes = {(sig["dir"], s["kind_prefix"](sig)) for sig in stamped}
        for folder, prefix in prefixes:
            for other_folder, other in prefixes:
                if folder == other_folder and prefix != other:
                    self.assertFalse(other.startswith(prefix), (prefix, other))

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_signatures_match_the_installer(self):
        script = "import('./src/uploads.js').then(m => process.stdout.write(m.routerSignaturesJson()))"
        out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=INSTALLER, capture_output=True,
                             text=True, check=True, encoding="utf-8").stdout
        self.assertEqual(json.loads(namespace()["SIGNATURES_JSON"]), json.loads(out))


if __name__ == "__main__":
    unittest.main()
