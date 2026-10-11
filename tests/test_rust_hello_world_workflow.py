"""Offline checks for the unlisted Cargo example's source build contract."""

import json
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/rust-hello-world.yml"


class RustHelloWorldWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load(WORKFLOW.read_text())
        self.job = self.workflow["jobs"]["image"]
        self.inputs = self.job["with"]
        self.manifest = json.loads((ROOT / self.inputs["manifest-path"]).read_text())

    def test_manual_v2_build_uses_its_own_v5_source(self):
        self.assertEqual(self.workflow.get("on", self.workflow.get(True)), {"workflow_dispatch": None})
        self.assertEqual(self.job["uses"], "proof-computer/liskov-github-actions/.github/workflows/cargo-runtime-image.yml@v2")
        self.assertNotIn("policy.json", WORKFLOW.read_text())
        self.assertEqual(self.inputs["manifest-path"], "rust-hello-world/.liskov/rust-hello-world.v5.json")
        self.assertEqual(self.inputs["application-id"], "rust-hello-world-v5")
        self.assertEqual(self.manifest["applicationId"], self.inputs["application-id"])
        self.assertEqual(self.manifest["schema"], "proof.liskov.application-manifest")
        self.assertEqual(self.manifest["schemaVersion"], 5)
        self.assertEqual(self.manifest["release"], {"mode": "source"})

    def test_runtime_matches_installed_binary_and_promoted_base(self):
        self.assertEqual(self.inputs["working-directory"], "rust-hello-world")
        self.assertEqual(self.inputs["binary-name"], "rust-hello-world")
        self.assertEqual(self.inputs["install-path"], "/usr/local/bin/rust-hello-world")
        self.assertEqual(self.manifest["runtime"], {
            "kind": "native_image",
            "image": {"catalog": "liskov-runtime-images", "name": "debian-trixie-snapshot", "version": "0.1"},
            "entrypoint": {"executable": self.inputs["install-path"]},
        })
        self.assertEqual(self.inputs["base-image-url"], "https://github.com/proof-computer/liskov-runtime-images/releases/download/v0.1.0-rc.13/liskov-runtime-image-debian-trixie-snapshot-aarch64.tar.xz")
        self.assertEqual(self.inputs["base-image-sha256"], "ac69afc5c8737db519f653f42f150c814cfd2c1173bececa15fc32258a8e2f9a")
        self.assertEqual(self.inputs["base-attestation-source-digest"], "e061dfd03f430657b4e937d91cfc804b1670d0f5")
        self.assertEqual(self.inputs["base-attestation-repository"], "proof-computer/liskov-runtime-images")
        self.assertEqual(self.inputs["base-attestation-signer-workflow"], "proof-computer/liskov-runtime-images/.github/workflows/ci.yml")

    def test_once_job_preserves_example_placement_and_spend(self):
        template = json.loads((ROOT / "proof/uptime-prober.json").read_text())["policyTemplate"]
        self.assertEqual(self.manifest["execution"], {"mode": "once"})
        self.assertEqual(self.manifest["deployment"]["jobs"], 1)
        for field in ("schedule", "placement", "spend"):
            self.assertEqual(self.manifest["deployment"][field], template["deployment"][field])
        self.assertEqual(self.manifest["state"], {"mode": "off"})
        self.assertNotIn("access", self.manifest)
        self.assertNotIn("configuration", self.manifest)
        self.assertFalse((ROOT / "proof/rust-hello-world.json").exists())


if __name__ == "__main__":
    unittest.main()
