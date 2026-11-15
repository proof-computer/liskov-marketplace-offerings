"""Offline checks for the uptime-prober artifact upload contract."""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/uptime-prober.yml"


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


if __name__ == "__main__":
    unittest.main()
