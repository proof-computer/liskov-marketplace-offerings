"""Offline checks for the uptime-prober artifact upload contract."""

import json
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/uptime-prober.yml"
# The PROOF publisher's GitHub source binding names this exact path
# (docs/raw/2026-11-15-q-zlzw-uptime-prober-publisher-binding-readback.md).
BOUND_MANIFEST = "uptime-prober/.liskov/uptime-prober.policy.json"


class UptimeProberWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.job = yaml.safe_load(WORKFLOW.read_text())["jobs"]["artifact"]
        self.inputs = self.job["with"]

    def test_uses_released_v2_artifact_workflow(self):
        self.assertEqual(
            self.job["uses"],
            "proof-computer/liskov-github-actions/.github/workflows/acurast-app.yml@v2",
        )

    def test_upload_targets_proof_organization_application(self):
        self.assertEqual(self.inputs["app-id"], "uptime-prober")
        self.assertEqual(
            self.inputs["organization-id"], "cbe250124d99fda88d377c63a78e2a23"
        )

    def test_uses_liskov_upload_default_without_secrets(self):
        self.assertNotIn("ipfs-endpoint", self.inputs)
        self.assertNotIn("secrets", self.job)

    def test_attests_from_the_bound_v5_source_document(self):
        self.assertEqual(self.inputs["authored-manifest-path"], BOUND_MANIFEST)
        self.assertIs(self.inputs["attest"], True)
        manifest = json.loads((ROOT / BOUND_MANIFEST).read_text())
        self.assertEqual(manifest["schemaVersion"], 5)
        self.assertEqual(manifest["release"], {"mode": "source"})


if __name__ == "__main__":
    unittest.main()
