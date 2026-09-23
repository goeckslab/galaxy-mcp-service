import importlib.util
import json
import os
from pathlib import Path
import stat
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release", REPO / "deploy/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
IMAGE = "galaxy-mcp-service:release-test"
PREVIOUS = "sha256:" + "a" * 64
PREVIOUS_BROKER = "sha256:" + "b" * 64
CONFIG = "MCP_HOST='mcp.example.org'\nBROKER_HOST='auth.example.org'\nGALAXY_MCP_IMAGE='galaxy-mcp-service:release-old'\nBROKER_SECRET='fixture-only'\nGALAXY_INSTANCES_JSON='{\"main\":\"https://usegalaxy.org\"}'\n"


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        (REPO / "artifacts").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=REPO / "artifacts", prefix="release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "data").mkdir()
        self.config = self.root / "data/lightsail.env"
        self.config.write_text(CONFIG)
        self.config.chmod(0o600)
        self.updates = []
        self.fail_build = False
        self.failed_updates = 0
        self.fail_broker = False

    def command(self, args, **kwargs):
        if args[-3:] == ["ps", "-q", "mcp"]:
            return subprocess.CompletedProcess(args, 0, "current-id\n")
        if args[-3:] == ["ps", "-q", "broker"]:
            return subprocess.CompletedProcess(args, 0, "broker-id\n")
        if "{{.State.Health.Status}}" in args:
            return subprocess.CompletedProcess(args, 0, "healthy\n")
        if "{{.Image}}" in args:
            return subprocess.CompletedProcess(args, 0, (PREVIOUS_BROKER if args[-1] == "broker-id" else PREVIOUS) + "\n")
        if args[:2] == ["docker", "build"] and self.fail_build:
            raise subprocess.CalledProcessError(1, args)
        if "up" in args:
            self.updates.append((args, kwargs))
            self.assertIn(args[-1], ["mcp", "broker"])
            self.assertIn("--no-deps", args)
            self.assertIn("--wait", args)
            self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
            self.assertIn("BROKER_SECRET='fixture-only'", self.config.read_text())
            if len(self.updates) <= self.failed_updates or (self.fail_broker and args[-1] == "broker" and kwargs["env"]["GALAXY_MCP_IMAGE"] == IMAGE):
                raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, "")

    def perform(self, check_side_effect=None, with_broker=False, instances=None):
        with patch.object(release, "run", side_effect=self.command), \
             patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)), \
             patch.object(release, "public_check", side_effect=check_side_effect), \
             patch.dict(os.environ, {"GALAXY_MCP_IMAGE": "unrelated-image", "BROKER_SECRET": "unrelated-secret"}):
            release.release(self.root, IMAGE, with_broker=with_broker, instances=instances)

    def test_approved_sites_update_together_and_roll_back_with_configuration(self):
        sites = json.loads((REPO / "deploy/galaxy-instances.json").read_text())
        self.perform(with_broker=True, instances=sites)
        line = next(line for line in self.config.read_text().splitlines() if line.startswith("GALAXY_INSTANCES_JSON="))
        self.assertEqual(json.loads(shlex.split(line.split("=", 1)[1])[0]), sites)
        self.assertEqual([args[-1] for args, _ in self.updates], ["mcp", "broker"])
        self.config.write_text(CONFIG)
        self.updates.clear()
        self.fail_broker = True
        with self.assertRaisesRegex(RuntimeError, "previous configuration and image restored"):
            self.perform(with_broker=True, instances=sites)
        self.assertEqual(self.config.read_text(), CONFIG)
        self.assertEqual([args[-1] for args, _ in self.updates], ["mcp", "broker", "broker", "mcp"])

    def test_site_update_rejects_removal_remapping_and_unsafe_input_before_docker(self):
        for sites in [[], {}, {"eu": "https://usegalaxy.eu"}, {"main": "https://changed.example.org"},
                      {"main": "https://usegalaxy.org", "au": "http://usegalaxy.org.au"},
                      {"main": "https://usegalaxy.org", "au": "https://user:key@example.org"},
                      {"main": "https://usegalaxy.org", "au": "https://example.org?key=value"},
                      {"main": "https://usegalaxy.org", "bad alias": "https://example.org"},
                      {"main": "https://usegalaxy.org", 1: "https://example.org"}]:
            with patch.object(release, "run") as command, self.assertRaises(ValueError):
                release.release(self.root, IMAGE, with_broker=True, instances=sites)
            command.assert_not_called()
            self.assertEqual(self.config.read_text(), CONFIG)
        with self.assertRaisesRegex(ValueError, "--with-broker"):
            self.perform(instances={"main": "https://usegalaxy.org"})

    def test_bundle_release_orders_updates_and_restores_distinct_images_on_broker_failure(self):
        self.perform(with_broker=True)
        self.assertEqual([args[-1] for args, _ in self.updates], ["mcp", "broker"])
        self.updates.clear()
        self.config.write_text(CONFIG)
        self.fail_broker = True
        with self.assertRaisesRegex(RuntimeError, "previous configuration and image restored"):
            self.perform(with_broker=True)
        self.assertEqual([args[-1] for args, _ in self.updates], ["mcp", "broker", "broker", "mcp"])
        self.assertEqual([kwargs["env"]["GALAXY_MCP_IMAGE"] for _, kwargs in self.updates], [IMAGE, IMAGE, PREVIOUS_BROKER, PREVIOUS])
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_bundle_release_rolls_back_when_broker_public_check_fails(self):
        with self.assertRaisesRegex(RuntimeError, "previous configuration and image restored"):
            self.perform([None, None, RuntimeError("Broker discovery failed"), None, None], with_broker=True)
        self.assertEqual([args[-1] for args, _ in self.updates], ["mcp", "broker", "broker", "mcp"])
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_success_preserves_secrets_backup_and_mcp_only_scope(self):
        self.perform()
        self.assertEqual(len(self.updates), 1)
        env = self.updates[0][1]["env"]
        self.assertEqual(env["GALAXY_MCP_IMAGE"], IMAGE)
        self.assertNotIn("BROKER_SECRET", env)
        self.assertIn(IMAGE, self.config.read_text())
        backups = list((self.root / "data").glob("lightsail.env.pre-release-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), CONFIG)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)

    def test_failed_build_never_activates(self):
        self.fail_build = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.perform()
        self.assertEqual(self.updates, [])
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_failed_activation_restores_immutable_previous_image(self):
        self.failed_updates = 1
        with self.assertRaisesRegex(RuntimeError, "previous configuration and image restored"):
            self.perform()
        self.assertEqual(self.config.read_text(), CONFIG)
        self.assertEqual(self.updates[-1][1]["env"]["GALAXY_MCP_IMAGE"], PREVIOUS)

    def test_public_failure_rolls_back_and_rollback_failure_is_not_hidden(self):
        with self.assertRaisesRegex(RuntimeError, "previous configuration and image restored"):
            self.perform([None, RuntimeError("401 missing"), None])
        self.assertEqual(self.config.read_text(), CONFIG)
        self.updates.clear()
        self.failed_updates = 2
        with self.assertRaisesRegex(RuntimeError, "Update and rollback failed"):
            self.perform()
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_rejects_unsafe_inputs_before_touching_docker(self):
        with patch.object(release, "run") as command:
            for image in ["latest", "galaxy-mcp-service:release-x;echo secret", "--help"]:
                with self.assertRaises(ValueError):
                    release.release(self.root, image)
            self.config.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                release.release(self.root, IMAGE)
            command.assert_not_called()
        self.config.chmod(0o600)
        self.config.write_text(CONFIG + "GALAXY_MCP_IMAGE=duplicate\n")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            release.release(self.root, IMAGE)

    def test_public_checks_require_both_readiness_and_auth_denial(self):
        with patch.object(release, "run", side_effect=[subprocess.CompletedProcess([], 0, "200"), subprocess.CompletedProcess([], 0, "200")]) as command:
            with self.assertRaisesRegex(RuntimeError, "expected 401"):
                release.public_check("https://mcp.example.org")
            self.assertEqual(command.call_args[0][0][-1], "https://mcp.example.org/mcp")

    def test_existing_image_and_concurrent_release_are_rejected(self):
        with patch.object(release, "run", side_effect=self.command), \
             patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaisesRegex(ValueError, "already exists"):
                release.release(self.root, IMAGE)
        with (self.root / "data/release.lock").open("a") as lock:
            release.fcntl.flock(lock, release.fcntl.LOCK_EX | release.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                release.release(self.root, IMAGE)

    def test_interrupted_activation_also_rolls_back(self):
        with self.assertRaisesRegex(RuntimeError, "previous configuration and image restored"):
            self.perform([None, KeyboardInterrupt(), None])
        self.assertEqual(self.config.read_text(), CONFIG)


if __name__ == "__main__":
    unittest.main()
