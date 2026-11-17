import importlib
import json
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
tracker = importlib.import_module("tracker")


class UsageTrackingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.history_file = Path(self.temp_dir.name) / "model_history.json"
        tracker._history_path = lambda: str(self.history_file)
        tracker._history_cache = {}
        tracker._history_loaded = False
        tracker._history_loaded_mtime = None
        tracker._usage_event_index = {}

    def tearDown(self):
        self.temp_dir.cleanup()

    def prompt(self, *model_paths):
        return {str(index): {"inputs": {"model": path}} for index, path in enumerate(model_paths, start=1)}

    def test_source_identifiers_are_classified_without_guessing(self):
        self.assertEqual(tracker.classify_usage_source("comfyui-frontend")[0], "frontend")
        self.assertEqual(tracker.classify_usage_source("api"), ("api", "api"))
        self.assertEqual(tracker.classify_usage_source("comfyui-api"), ("api", "comfyui-api"))
        self.assertEqual(tracker.classify_usage_source(None), ("unknown", None))
        self.assertEqual(tracker.classify_usage_source("comfy-cli"), ("unknown", None))
        self.assertEqual(tracker.classify_usage_source("comfyui-mcp"), ("unknown", None))
        self.assertEqual(tracker.classify_usage_source("future-client"), ("unknown", None))
        self.assertEqual(tracker.USAGE_SOURCE_IDS, ("frontend", "api", "unknown"))

    def test_started_prompt_for_custom_nodes_is_recorded_even_without_model_strings(self):
        custom_analytics = importlib.import_module("custom_node_analytics")
        prompt = {
            "1": {"class_type": "example.custom", "inputs": {}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        with patch.object(custom_analytics, "record_prompt_packages") as record_packages:
            tracker.record_prompt_usage("prompt-with-only-nodes", prompt, "api", {}, ["2"])
        record_packages.assert_called_once_with(
            "prompt-with-only-nodes", prompt, "api", outputs_to_execute=["2"]
        )
        self.assertFalse(self.history_file.exists())

    def test_legacy_source_categories_are_migrated_to_unknown(self):
        self.history_file.write_text(json.dumps({
            "schema_version": 2,
            "models": {},
            "usage_events": [
                {"prompt_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "timestamp": "2026-11-15T10:00:00+00:00", "source": "cli", "source_raw": "comfy-cli", "models": ["checkpoints/cli.safetensors"]},
                {"prompt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "timestamp": "2026-11-15T10:00:00+00:00", "source": "mcp", "source_raw": "comfyui-mcp", "models": ["checkpoints/mcp.safetensors"]},
                {"prompt_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "timestamp": "2026-11-15T10:00:00+00:00", "source": "other", "source_raw": "future-client", "models": ["checkpoints/other.safetensors"]},
            ],
        }), encoding="utf-8")
        result = tracker.build_usage_analytics("all")
        self.assertEqual(set(result["source_counts"]), {"frontend", "api", "unknown"})
        self.assertEqual(result["source_counts"]["unknown"]["executions"], 3)
        self.assertEqual(result["source_counts"]["unknown"]["model_uses"], 3)
        self.assertEqual({item["last_source"] for item in result["models"]}, {"unknown"})
        # The database is normalized in place, but model history is retained.
        persisted = json.loads(self.history_file.read_text(encoding="utf-8"))
        self.assertEqual({event["source"] for event in persisted["usage_events"]}, {"unknown"})
        self.assertTrue(all(event.get("source_raw") is None for event in persisted["usage_events"]))

    def test_api_is_recorded_only_when_an_api_marker_is_explicit(self):
        prompt = self.prompt("checkpoints/api.safetensors")
        tracker.record_prompt_usage("dddddddd-dddd-4ddd-8ddd-dddddddddddd", prompt, None)
        tracker.record_prompt_usage("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", prompt, "api")
        result = tracker.build_usage_analytics("all")
        self.assertEqual(set(result["source_counts"]), {"frontend", "api", "unknown"})
        self.assertEqual(result["source_counts"]["api"]["executions"], 1)
        self.assertEqual(result["source_counts"]["unknown"]["executions"], 1)

    def test_prompt_model_pairs_are_deduplicated_by_prompt_id(self):
        prompt_id = "11111111-1111-4111-8111-111111111111"
        prompt = self.prompt("checkpoints/base.safetensors", "checkpoints/base.safetensors", "loras/detail.safetensors")
        tracker.record_prompt_usage(prompt_id, prompt, "comfyui-frontend")
        tracker.record_prompt_usage(prompt_id, prompt, "comfyui-frontend")

        result = tracker.build_usage_analytics("all")
        self.assertEqual(result["total_executions"], 1)
        self.assertEqual(result["total_model_uses"], 2)
        self.assertEqual(result["source_counts"]["frontend"]["executions"], 1)
        self.assertEqual(result["source_counts"]["frontend"]["model_uses"], 2)
        self.assertEqual({item["model_id"] for item in result["models"]}, {
            "checkpoints/base.safetensors", "loras/detail.safetensors"
        })

    def test_unknown_event_can_be_enriched_only_for_same_prompt_id(self):
        prompt_id = "22222222-2222-4222-8222-222222222222"
        prompt = self.prompt("checkpoints/base.safetensors")
        tracker.record_prompt_usage(prompt_id, prompt, None)
        tracker.record_prompt_usage(prompt_id, prompt, "comfy-cli")
        result = tracker.build_usage_analytics("all")
        self.assertEqual(result["total_executions"], 1)
        self.assertEqual(result["source_counts"]["unknown"]["executions"], 1)
        self.assertEqual(result["source_counts"]["unknown"]["model_uses"], 1)

    def test_period_filter_excludes_events_outside_window(self):
        old_id = "33333333-3333-4333-8333-333333333333"
        recent_id = "44444444-4444-4444-8444-444444444444"
        prompt = self.prompt("checkpoints/base.safetensors")
        tracker.record_prompt_usage(old_id, prompt, "comfy-cli")
        tracker.record_prompt_usage(recent_id, prompt, "comfy-cli")
        database = tracker._load_history()
        for event in database["usage_events"]:
            if event["prompt_id"] == old_id:
                event["timestamp"] = "2020-01-01T00:00:00+00:00"
        tracker._save_history()
        self.assertEqual(tracker.build_usage_analytics("24h")["total_executions"], 1)
        self.assertEqual(tracker.build_usage_analytics("all")["total_executions"], 2)

    def test_custom_day_period_matches_dashboard_recency_value(self):
        old_id = "77777777-7777-4777-8777-777777777777"
        recent_id = "88888888-8888-4888-8888-888888888888"
        prompt = self.prompt("checkpoints/base.safetensors")
        tracker.record_prompt_usage(old_id, prompt, "comfy-cli")
        tracker.record_prompt_usage(recent_id, prompt, "comfy-cli")
        database = tracker._load_history()
        for event in database["usage_events"]:
            if event["prompt_id"] == old_id:
                event["timestamp"] = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        tracker._save_history()
        self.assertEqual(tracker.build_usage_analytics("7d")["total_executions"], 1)
        self.assertEqual(tracker.build_usage_analytics("14d")["total_executions"], 2)
        self.assertEqual(tracker.build_usage_analytics("14.5d")["period"], "14.5d")

    def test_legacy_history_is_preserved_as_timestamp_less_unknown(self):
        self.history_file.write_text(json.dumps({
            "checkpoints/legacy.safetensors": {
                "use_count": 5,
                "queue_count": 3,
                "last_used": "2026-11-15T10:00:00+00:00",
            }
        }), encoding="utf-8")
        result = tracker.build_usage_analytics("all")
        self.assertEqual(result["legacy_unknown_uses"], 3)
        self.assertEqual(result["source_counts"]["unknown"]["model_uses"], 3)
        self.assertEqual(result["source_counts"]["unknown"]["executions"], 0)
        self.assertEqual(result["models"][0]["last_used"], "2026-11-15T10:00:00+00:00")
        self.assertEqual(result["models"][0]["last_source"], "unknown")
        self.assertFalse(result["legacy_unknown_has_timestamps"])

    def test_persisted_duplicate_prompt_events_are_merged(self):
        self.history_file.write_text(json.dumps({
            "schema_version": 2,
            "models": {},
            "usage_events": [
                {"prompt_id": "66666666-6666-4666-8666-666666666666", "timestamp": "2026-11-15T10:00:00+00:00", "source": "frontend", "models": ["checkpoints/a.safetensors"]},
                {"prompt_id": "66666666-6666-4666-8666-666666666666", "timestamp": "2026-11-15T10:00:00+00:00", "source": "unknown", "models": ["checkpoints/a.safetensors", "loras/b.safetensors"]},
            ],
        }), encoding="utf-8")
        result = tracker.build_usage_analytics("all")
        self.assertEqual(result["total_executions"], 1)
        self.assertEqual(result["total_model_uses"], 2)
        self.assertEqual(result["source_counts"]["frontend"]["executions"], 1)

    def test_prompt_queue_hook_records_only_when_worker_starts_prompt(self):
        class FakeQueue:
            def __init__(self):
                self.pending = []
                self.next_task_id = 0

            def put(self, item):
                self.pending.append(item)

            def get(self, timeout=None):
                if not self.pending:
                    return None
                item = self.pending.pop(0)
                task_id = self.next_task_id
                self.next_task_id += 1
                return item, task_id

        queue = FakeQueue()
        fake_server = types.ModuleType("server")
        fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=queue))
        previous = sys.modules.get("server")
        sys.modules["server"] = fake_server
        try:
            self.assertTrue(tracker._install_prompt_queue_hook())
            queued_item = (1, "55555555-5555-4555-8555-555555555555", self.prompt("checkpoints/base.safetensors"), {
                "comfy_usage_source": "comfyui-mcp"
            }, ["1"], {})
            queue.put(queued_item)
            # Merely submitted prompts are not counted until a worker dequeues them.
            self.assertEqual(tracker.build_usage_analytics("all")["total_executions"], 0)
            started = queue.get()
            self.assertEqual(started[0][1], queued_item[1])
            result = tracker.build_usage_analytics("all")
            self.assertEqual(result["source_counts"]["unknown"]["executions"], 1)
            self.assertEqual(result["source_counts"]["unknown"]["model_uses"], 1)
            # Empty queue / timeout returns None and must not create an event.
            self.assertIsNone(queue.get(timeout=0))
            self.assertEqual(tracker.build_usage_analytics("all")["total_executions"], 1)
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous


    def test_prompt_queue_hook_forwards_validated_output_targets(self):
        class FakeQueue:
            def get(self, timeout=None):
                return ((1, "targeted-prompt", {"1": {"class_type": "example.custom", "inputs": {}}}, {
                    "comfy_usage_source": "api"
                }, ["1"], {}), 0)

        queue = FakeQueue()
        fake_server = types.ModuleType("server")
        fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=queue))
        previous = sys.modules.get("server")
        sys.modules["server"] = fake_server
        try:
            self.assertTrue(tracker._install_prompt_queue_hook())
            with patch.object(tracker, "record_prompt_usage") as record_prompt:
                queue.get()
            record_prompt.assert_called_once_with(
                "targeted-prompt",
                {"1": {"class_type": "example.custom", "inputs": {}}},
                "api",
                {"comfy_usage_source": "api"},
                outputs_to_execute=["1"],
            )
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous

    def test_external_prompt_without_marker_is_counted_as_api(self):
        prompt = self.prompt("checkpoints/api.safetensors")
        # Plain curl POST to /prompt: no header marker, no workflow metadata.
        tracker.record_prompt_usage("99999999-9999-4999-8999-999999999991", prompt, None, {})
        # Web interface: no marker needed, workflow attached as extra_pnginfo.
        tracker.record_prompt_usage("99999999-9999-4999-8999-999999999992", prompt, None, {"extra_pnginfo": {"workflow": {}}})
        # Explicit but unrecognized marker stays Unknown.
        tracker.record_prompt_usage("99999999-9999-4999-8999-999999999993", prompt, "comfy-cli", {})
        result = tracker.build_usage_analytics("all")
        self.assertEqual(result["source_counts"]["api"]["executions"], 1)
        self.assertEqual(result["source_counts"]["frontend"]["executions"], 1)
        self.assertEqual(result["source_counts"]["unknown"]["executions"], 1)

    def test_queue_hook_marks_plain_api_call_as_api(self):
        class FakeQueue:
            def __init__(self):
                self.pending = []

            def get(self, timeout=None):
                return (self.pending.pop(0), 0) if self.pending else None

        queue = FakeQueue()
        fake_server = types.ModuleType("server")
        fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=queue))
        previous = sys.modules.get("server")
        sys.modules["server"] = fake_server
        try:
            self.assertTrue(tracker._install_prompt_queue_hook())
            queue.pending.append((1, "99999999-9999-4999-8999-999999999994", self.prompt("checkpoints/z.safetensors"), {}, [], {}))
            queue.get()
            result = tracker.build_usage_analytics("all")
            self.assertEqual(result["source_counts"]["api"]["executions"], 1)
            self.assertEqual(result["models"][0]["source_counts"]["api"], 1)
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous

    def test_first_submitted_prompt_installs_missing_queue_hook(self):
        class FakeQueue:
            def __init__(self):
                self.pending = []

            def get(self, timeout=None):
                return (self.pending.pop(0), 0) if self.pending else None

        fake_server = types.ModuleType("server")
        instance = types.SimpleNamespace()  # no prompt_queue yet (early startup)
        fake_server.PromptServer = types.SimpleNamespace(instance=instance)
        previous = sys.modules.get("server")
        sys.modules["server"] = fake_server
        try:
            self.assertFalse(tracker._install_prompt_queue_hook(quiet=True))
            instance.prompt_queue = FakeQueue()
            tracker._on_prompt({"prompt": self.prompt("checkpoints/z.safetensors")})
            instance.prompt_queue.pending.append((1, "99999999-9999-4999-8999-999999999995", self.prompt("checkpoints/z.safetensors"), {}, [], {}))
            instance.prompt_queue.get()
            self.assertEqual(tracker.build_usage_analytics("all")["source_counts"]["api"]["executions"], 1)
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous

if __name__ == "__main__":
    unittest.main()
