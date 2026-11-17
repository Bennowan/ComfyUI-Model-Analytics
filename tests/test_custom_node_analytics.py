import asyncio
import importlib
import json
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
analytics = importlib.import_module("custom_node_analytics")
scanner = importlib.import_module("scanner")


class FakeFolderPaths:
    def __init__(self, custom_nodes, user_dir):
        self.custom_nodes = str(custom_nodes)
        self.user_dir = str(user_dir)

    def get_folder_paths(self, category):
        if category == "custom_nodes":
            return [self.custom_nodes]
        return []

    def get_user_directory(self):
        return self.user_dir


class DynamicPrompt:
    def __init__(self, class_type):
        self.class_type = class_type

    def get_node(self, node_id):
        return {"class_type": self.class_type}


class CustomNodeAnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.custom_nodes_dir = self.root / "custom_nodes"
        self.package_dir = self.custom_nodes_dir / "ExamplePack"
        self.package_dir.mkdir(parents=True)
        (self.package_dir / "__init__.py").write_text("", encoding="utf-8")
        (self.package_dir / "nodes.py").write_text("# test node module\n", encoding="utf-8")
        self.disabled_dir = self.custom_nodes_dir / "OldPack.disabled"
        self.disabled_dir.mkdir()
        (self.disabled_dir / "__init__.py").write_text("", encoding="utf-8")
        self.user_dir = self.root / "user"
        self.user_dir.mkdir()
        self.history_file = self.root / "custom_node_history.json"
        self.model_history = self.root / "model_history.json"
        self.model_history.write_text('{"models":{"keep.safetensors":{"use_count":3}}}', encoding="utf-8")

        self.previous_paths = analytics.folder_paths
        self.previous_scanner_paths = scanner.folder_paths
        self.previous_db_path = analytics._database_path
        self.previous_nodes_module = sys.modules.get("nodes")
        self.previous_fake_module = sys.modules.get("fake_custom_nodes")
        self.previous_timer = analytics._flush_timer

        self.fake_paths = FakeFolderPaths(self.custom_nodes_dir, self.user_dir)
        analytics.folder_paths = self.fake_paths
        scanner.folder_paths = self.fake_paths
        analytics._database_path = lambda: str(self.history_file)
        analytics._database = {}
        analytics._loaded = False
        analytics._loaded_mtime = None
        analytics._dirty = False
        analytics._flush_timer = None
        analytics._execution_registry_cache = None
        analytics._execution_registry_signature = None
        analytics._prompt_event_index = {}
        analytics._inventory_cache = None
        analytics._inventory_cache_signature = None
        analytics._inventory_cache_revision = 0

        fake_module = types.ModuleType("fake_custom_nodes")
        fake_module.__file__ = str(self.package_dir / "nodes.py")
        self.node_class = type("ExampleNode", (), {"__module__": "fake_custom_nodes"})
        sys.modules["fake_custom_nodes"] = fake_module
        fake_nodes = types.ModuleType("nodes")
        # The built-in class is deliberately outside custom_nodes and must not
        # enter the package analytics result.
        builtin_module = types.ModuleType("comfy_builtin_nodes")
        builtin_module.__file__ = str(self.root / "comfy" / "nodes.py")
        builtin_class = type("BuiltinNode", (), {"__module__": "comfy_builtin_nodes"})
        sys.modules["comfy_builtin_nodes"] = builtin_module
        fake_nodes.NODE_CLASS_MAPPINGS = {
            "example.custom": self.node_class,
            "LoadImage": builtin_class,
        }
        fake_nodes.NODE_DISPLAY_NAME_MAPPINGS = {"example.custom": "Example Custom Node"}
        fake_nodes.LOADED_MODULE_DIRS = {"ExamplePack": str(self.package_dir)}
        fake_nodes.EXTENSION_WEB_DIRS = {}
        sys.modules["nodes"] = fake_nodes

    def tearDown(self):
        analytics._flush_pending()
        if analytics._flush_timer is not None:
            analytics._flush_timer.cancel()
        analytics.folder_paths = self.previous_paths
        scanner.folder_paths = self.previous_scanner_paths
        analytics._database_path = self.previous_db_path
        analytics._execution_registry_cache = None
        analytics._execution_registry_signature = None
        analytics._inventory_cache = None
        analytics._inventory_cache_signature = None
        sys.modules.pop("shared_python_lib.nodes", None)
        analytics._flush_timer = None
        if self.previous_nodes_module is None:
            sys.modules.pop("nodes", None)
        else:
            sys.modules["nodes"] = self.previous_nodes_module
        if self.previous_fake_module is None:
            sys.modules.pop("fake_custom_nodes", None)
        else:
            sys.modules["fake_custom_nodes"] = self.previous_fake_module
        sys.modules.pop("comfy_builtin_nodes", None)
        self.temp_dir.cleanup()

    def test_settings_and_execution_history_are_stored_per_package(self):
        self.assertEqual(analytics.get_settings(), {"tracking_enabled": True, "scan_workflows": True})
        analytics.update_settings({"tracking_enabled": False, "scan_workflows": False})
        analytics.record_node_executed("root0:ExamplePack", "example.custom", "ExampleNode")
        self.assertTrue(self.history_file.exists())
        self.assertEqual(analytics._database["packages"], {})

        analytics.update_settings({"tracking_enabled": True})
        analytics.record_node_executed("root0:ExamplePack", "example.custom", "ExampleNode", "Example Custom Node")
        analytics._flush_pending()
        saved = json.loads(self.history_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["schema_version"], 4)
        self.assertEqual(saved["packages"]["root0:ExamplePack"]["execution_count"], 1)
        self.assertNotIn("nodes", saved)
        self.assertEqual(json.loads(self.model_history.read_text(encoding="utf-8"))["models"]["keep.safetensors"]["use_count"], 3)

    def test_started_prompt_tracks_only_packages_on_validated_output_graph(self):
        timestamp = "2026-11-17T12:00:00+00:00"
        prompt = {
            "1": {"class_type": "example.custom", "inputs": {}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
            # This package has a connected two-node chain, but that chain is
            # orphaned: it does not lead to any requested output target.
            "3": {"class_type": "orphan.custom", "inputs": {}},
            "4": {"class_type": "TextOutput", "inputs": {"text": ["3", 0]}},
        }
        registry = {
            "example.custom": "root0:ExamplePack",
            "orphan.custom": "root0:OrphanPack",
        }
        with patch.object(analytics, "_get_execution_registry_snapshot", return_value=registry):
            analytics.record_prompt_packages("prompt-api-1", prompt, "api", timestamp, ["2"])
            # Duplicate observation for one prompt must not inflate the package count.
            analytics.record_prompt_packages("prompt-api-1", prompt, "api", timestamp, ["2"])
        analytics._flush_pending()

        saved = json.loads(self.history_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["schema_version"], 4)
        self.assertEqual(len(saved["prompt_events"]), 1)
        self.assertEqual(saved["prompt_events"][0]["packages"], ["root0:ExamplePack"])
        self.assertEqual(saved["prompt_events"][0]["scope"], "active_output_graph")
        self.assertEqual(saved["prompt_events"][0]["source"], "api")
        self.assertEqual(saved["packages"], {})

        result = analytics.build_custom_node_usage_analytics("all")
        package = next(item for item in result["custom_packages"] if item["package_id"] == "root0:ExamplePack")
        self.assertEqual(package["prompt_count"], 1)
        self.assertEqual(package["source_counts"], {"frontend": 0, "api": 1, "unknown": 0})
        self.assertFalse(package["has_execution"])
        self.assertFalse(any(item["package_id"] == "root0:OrphanPack" for item in result["custom_packages"]))

    def test_custom_node_prompt_usage_respects_recency_window(self):
        prompt = {
            "1": {"class_type": "example.custom", "inputs": {}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        analytics.record_prompt_packages(
            "prompt-old", prompt, "frontend", "2026-01-01T10:00:00+00:00", ["2"],
        )
        all_time = analytics.build_custom_node_usage_analytics("all")
        recent = analytics.build_custom_node_usage_analytics("7d")
        all_package = next(item for item in all_time["custom_packages"] if item["package_id"] == "root0:ExamplePack")
        self.assertEqual(all_package["prompt_count"], 1)
        self.assertFalse(any(item["package_id"] == "root0:ExamplePack" for item in recent["custom_packages"]))

    def test_prompt_without_validated_output_targets_is_not_attributed(self):
        analytics.record_prompt_packages(
            "prompt-no-targets", {"1": {"class_type": "example.custom", "inputs": {}}}, "api"
        )
        result = analytics.build_custom_node_usage_analytics("all")
        self.assertFalse(any(item["package_id"] == "root0:ExamplePack" and item["prompt_count"] for item in result["custom_packages"]))

    def test_schema_v3_prompt_presence_is_preserved_but_not_counted_as_verified_usage(self):
        self.history_file.write_text(json.dumps({
            "schema_version": 3,
            "settings": {"tracking_enabled": True, "scan_workflows": True},
            "packages": {
                "root0:ExamplePack": {
                    "execution_count": 7,
                    "first_executed": "2026-11-10T10:00:00+00:00",
                    "last_executed": "2026-11-16T10:00:00+00:00",
                },
            },
            "prompt_events": [{
                "prompt_id": "legacy-prompt", "timestamp": "2026-11-16T10:00:00+00:00",
                "source": "api", "packages": ["root0:ExamplePack"],
            }],
        }), encoding="utf-8")
        result = analytics.build_custom_node_usage_analytics("all")
        self.assertEqual(result["prompt_events"], 0)
        self.assertEqual(result["source_counts"], {"frontend": 0, "api": 0, "unknown": 0})
        database = analytics._load_database()
        self.assertEqual(database["prompt_events"][0]["scope"], "unverified_legacy")
        self.assertEqual(database["packages"]["root0:ExamplePack"]["execution_count"], 7)
        analytics._flush_pending()
        persisted = json.loads(self.history_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["schema_version"], 4)
        self.assertEqual(persisted["prompt_events"][0]["scope"], "unverified_legacy")
        self.assertEqual(persisted["packages"]["root0:ExamplePack"]["execution_count"], 7)

    def test_verified_prompt_event_cannot_be_polluted_by_legacy_presence(self):
        normalized = analytics._normalize_prompt_events([
            {
                "prompt_id": "same-prompt", "timestamp": "2026-11-17T12:00:00+00:00",
                "source": "api", "packages": ["root0:VerifiedPack"], "scope": "active_output_graph",
            },
            {
                "prompt_id": "same-prompt", "timestamp": "2026-11-17T12:00:00+00:00",
                "source": "api", "packages": ["root0:OrphanPack"],
            },
        ])
        self.assertEqual(len(normalized), 1)
        self.assertEqual(normalized[0]["scope"], "active_output_graph")
        self.assertEqual(normalized[0]["packages"], ["root0:VerifiedPack"])

    def test_schema_v1_node_history_migrates_to_package_aggregates(self):
        legacy = {
            "schema_version": 1,
            "settings": {"tracking_enabled": True, "scan_workflows": True},
            "tracking_started_at": "2026-01-01T00:00:00+00:00",
            "nodes": {
                "pkg::node-a": {"package_id": "root0:ExamplePack", "node_id": "node-a", "execution_count": 4, "first_executed": "2026-01-01T01:00:00+00:00", "last_executed": "2026-01-02T01:00:00+00:00"},
                "pkg::node-b": {"package_id": "root0:ExamplePack", "node_id": "node-b", "execution_count": 2, "first_executed": "2026-01-01T02:00:00+00:00", "last_executed": "2026-01-03T01:00:00+00:00"},
            },
        }
        migrated = analytics._normalize_database(legacy)
        self.assertEqual(migrated["schema_version"], 4)
        self.assertEqual(migrated["packages"]["root0:ExamplePack"]["execution_count"], 6)
        self.assertEqual(migrated["packages"]["root0:ExamplePack"]["last_executed"], "2026-01-03T01:00:00+00:00")
        self.assertNotIn("nodes", migrated)

    def test_workflow_parser_supports_graph_api_and_nested_nodes(self):
        graph = {"nodes": [{"id": 1, "type": "example.custom"}, {"id": 2, "type": "LoadImage"}]}
        api_prompt = {"prompt": {"4": {"class_type": "example.custom"}, "5": {"class_type": "KSampler"}}}
        nested = {"subgraph": {"nodes": [{"type": "example.custom"}]}}
        bare_api_prompt = {"6": {"class_type": "example.custom", "inputs": {}}}
        self.assertEqual(
            analytics._workflow_class_ids([graph, api_prompt, nested, bare_api_prompt]),
            {"example.custom", "LoadImage", "KSampler"},
        )

    def test_inventory_returns_packages_and_workflows_not_individual_nodes(self):
        workflows_dir = self.user_dir / "default" / "workflows"
        workflows_dir.mkdir(parents=True)
        (workflows_dir / "contains-custom-node.json").write_text(json.dumps({
            "nodes": [{"id": 1, "type": "example.custom"}, {"id": 2, "type": "LoadImage"}],
        }), encoding="utf-8")
        (workflows_dir / "builtin-only.json").write_text(json.dumps({
            "nodes": [{"id": 1, "type": "LoadImage"}],
        }), encoding="utf-8")

        result = analytics.build_custom_node_inventory()
        self.assertTrue(result["success"])
        self.assertEqual(result["summary"]["package_count"], 2)
        self.assertNotIn("nodes", result)
        active = next(item for item in result["packages"] if item["name"] == "ExamplePack")
        disabled = next(item for item in result["packages"] if item["name"] == "OldPack")
        self.assertEqual(active["registered_node_count"], 1)
        self.assertEqual(active["extension_type"], "node_package")
        self.assertTrue(active["has_node_classes"])
        self.assertEqual(active["execution_count"], 0)
        self.assertEqual(active["workflow_count"], 1)
        self.assertEqual(active["status"], "registered")
        self.assertTrue(disabled["disabled"])
        self.assertEqual(disabled["status"], "disabled")
        self.assertTrue(result["workflow_scan"]["available"])
        self.assertEqual(result["workflows"], [{
            "name": "contains-custom-node.json",
            "package_count": 1,
            "node_type_count": 1,
            "package_names": ["ExamplePack"],
            "package_names_text": "ExamplePack",
        }])

    def test_relative_module_owner_keeps_dotted_package_names(self):
        dotted_package = self.custom_nodes_dir / "Example.Pack"
        dotted_package.mkdir()
        (dotted_package / "__init__.py").write_text("", encoding="utf-8")
        fake_nodes = sys.modules["nodes"]
        fake_nodes.LOADED_MODULE_DIRS["Example.Pack"] = str(dotted_package)
        dotted_node = type("DottedPackageNode", (), {})
        dotted_node.RELATIVE_PYTHON_MODULE = "custom_nodes.Example.Pack"
        resolved = analytics._resolve_package(dotted_node, analytics._discover_packages()[0], fake_nodes.LOADED_MODULE_DIRS)
        self.assertEqual(resolved["name"], "Example.Pack")

    def test_registry_owner_metadata_resolves_reexported_node_classes(self):
        shared_dir = self.root / "shared_python_lib"
        shared_dir.mkdir()
        shared_module = types.ModuleType("shared_python_lib.nodes")
        shared_module.__file__ = str(shared_dir / "nodes.py")
        sys.modules["shared_python_lib.nodes"] = shared_module
        reexported_class = type("ReexportedNode", (), {"__module__": "shared_python_lib.nodes"})
        reexported_class.RELATIVE_PYTHON_MODULE = "custom_nodes.ExamplePack"

        fake_nodes = sys.modules["nodes"]
        fake_nodes.NODE_CLASS_MAPPINGS["example.reexported"] = reexported_class
        mapping = analytics._registered_custom_nodes(analytics._discover_packages()[0], fake_nodes)

        self.assertEqual(mapping["example.reexported"], "root0:ExamplePack")

    def test_registry_classifies_ui_only_and_combined_packages(self):
        ui_package_dir = self.custom_nodes_dir / "ModelAnalytics"
        ui_package_dir.mkdir()
        (ui_package_dir / "__init__.py").write_text("WEB_DIRECTORY = './web'\n", encoding="utf-8")
        web_dir = ui_package_dir / "web"
        web_dir.mkdir()

        fake_nodes = sys.modules["nodes"]
        # Newer ComfyUI builds can key this map by the project name from
        # pyproject.toml instead of the Python import-module name.
        fake_nodes.LOADED_MODULE_DIRS.pop("ModelAnalytics", None)
        fake_nodes.EXTENSION_WEB_DIRS = {
            "ComfyUI Model Analytics": str(web_dir),
            "ExamplePack": str(self.package_dir / "web"),
        }

        result = analytics.build_custom_node_inventory()
        ui_only = next(item for item in result["packages"] if item["name"] == "ModelAnalytics")
        combined = next(item for item in result["packages"] if item["name"] == "ExamplePack")

        self.assertEqual(ui_only["extension_type"], "ui_only")
        self.assertFalse(ui_only["has_node_classes"])
        self.assertTrue(ui_only["ui_extension_registered"])
        self.assertEqual(combined["extension_type"], "both")

    def test_inventory_snapshot_is_cached_until_workflow_files_change(self):
        workflows_dir = self.user_dir / "default" / "workflows"
        workflows_dir.mkdir(parents=True)
        workflow_path = workflows_dir / "cached.json"
        workflow_path.write_text(json.dumps({"nodes": [{"type": "example.custom"}]}), encoding="utf-8")

        original_scan = analytics._scan_workflow_references
        calls = []

        def counting_scan(*args, **kwargs):
            calls.append(True)
            return original_scan(*args, **kwargs)

        analytics._scan_workflow_references = counting_scan
        try:
            first = analytics.build_custom_node_inventory()
            second = analytics.build_custom_node_inventory()
            self.assertIs(first, second)
            self.assertEqual(len(calls), 1)

            (workflows_dir / "added.json").write_text(
                json.dumps({"nodes": [{"type": "example.custom"}]}), encoding="utf-8"
            )
            third = analytics.build_custom_node_inventory()
            self.assertIsNot(first, third)
            self.assertEqual(len(calls), 2)
            self.assertEqual(third["summary"]["total_workflows_scanned"], 2)
        finally:
            analytics._scan_workflow_references = original_scan

    def test_execution_updates_cached_package_counters_without_rescanning(self):
        workflows_dir = self.user_dir / "default" / "workflows"
        workflows_dir.mkdir(parents=True)
        (workflows_dir / "cached.json").write_text(
            json.dumps({"nodes": [{"type": "example.custom"}]}), encoding="utf-8"
        )
        original_scan = analytics._scan_workflow_references
        calls = []

        def counting_scan(*args, **kwargs):
            calls.append(True)
            return original_scan(*args, **kwargs)

        analytics._scan_workflow_references = counting_scan
        try:
            first = analytics.build_custom_node_inventory()
            old_revision = first["revision"]
            analytics.record_package_executed("root0:ExamplePack")
            second = analytics.build_custom_node_inventory()
            active = next(item for item in second["packages"] if item["name"] == "ExamplePack")
            self.assertIs(first, second)
            self.assertEqual(len(calls), 1)
            self.assertEqual(active["execution_count"], 1)
            self.assertNotEqual(second["revision"], old_revision)
        finally:
            analytics._scan_workflow_references = original_scan

    def test_workflow_scan_reports_unavailable_when_no_directory_can_be_resolved(self):
        mapping, workflow_rows, info = analytics._scan_workflow_references({"example.custom": "root0:ExamplePack"})
        self.assertEqual(mapping, {})
        self.assertEqual(workflow_rows, [])
        self.assertTrue(info["enabled"])
        self.assertFalse(info["available"])
        self.assertEqual(info["workflow_count"], 0)

    def test_execution_hook_requires_function_invocation_success_and_cache_miss(self):
        success_token = object()
        pending_token = object()
        failure_token = object()

        class ExecutionResult:
            SUCCESS = success_token
            PENDING = pending_token
            FAILURE = failure_token

        class FakeOutputCache:
            def __init__(self, cached_value=None):
                self.cached_value = cached_value
                self.lookups = []

            async def get(self, node_id):
                self.lookups.append(node_id)
                return self.cached_value

        class FakeCaches:
            def __init__(self, cached_value=None):
                self.outputs = FakeOutputCache(cached_value)

        execution_module = types.ModuleType("execution")
        execution_module.ExecutionResult = ExecutionResult
        calls = []
        async_calls = {}

        async def original_get_output_data(*args, **kwargs):
            callback = kwargs.get("pre_execute_cb")
            if callable(callback):
                callback(0)
            return None

        async def original_execute(*args, **kwargs):
            node_id = args[3]
            calls.append(node_id)
            # This models a lazy-input branch: execute() returns SUCCESS, but
            # ComfyUI never invokes pre_execute_cb because FUNCTION did not run.
            if node_id == "13":
                return (success_token, None, None)
            if node_id == "14":
                async_calls[node_id] = async_calls.get(node_id, 0) + 1
                if async_calls[node_id] == 1:
                    await execution_module.get_output_data(pre_execute_cb=lambda _index: None)
                    return (pending_token, None, None)
                # ComfyUI completes a pending asynchronous node on a later
                # executor pass without invoking its FUNCTION a second time.
                return (success_token, None, None)
            await execution_module.get_output_data(pre_execute_cb=lambda _index: None)
            return (args[4], None, None)

        execution_module.get_output_data = original_get_output_data
        execution_module.execute = original_execute
        previous_execution = sys.modules.get("execution")
        sys.modules["execution"] = execution_module
        try:
            self.assertTrue(analytics.install_execution_hook())
            dynamic_prompt = DynamicPrompt("example.custom")
            cache_miss = FakeCaches()
            cache_hit = FakeCaches(cached_value={"outputs": ["cached"]})
            failure_cache_miss = FakeCaches()
            lazy_blocked_cache_miss = FakeCaches()
            async_first_pass = FakeCaches()
            async_completion = FakeCaches()

            asyncio.run(execution_module.execute(None, dynamic_prompt, cache_miss, "10", success_token, set(), "prompt-1"))
            asyncio.run(execution_module.execute(None, dynamic_prompt, cache_hit, "11", success_token, set(), "prompt-2"))
            asyncio.run(execution_module.execute(None, dynamic_prompt, failure_cache_miss, "12", failure_token, set(), "prompt-3"))
            asyncio.run(execution_module.execute(None, dynamic_prompt, lazy_blocked_cache_miss, "13", success_token, set(), "prompt-4"))
            asyncio.run(execution_module.execute(None, dynamic_prompt, async_first_pass, "14", success_token, set(), "prompt-5"))
            asyncio.run(execution_module.execute(None, dynamic_prompt, async_completion, "14", success_token, set(), "prompt-5"))

            analytics._flush_pending()
            stored = json.loads(self.history_file.read_text(encoding="utf-8"))
            row = stored["packages"]["root0:ExamplePack"]
            self.assertEqual(row["execution_count"], 2)
            self.assertNotIn("nodes", stored)
            self.assertEqual(calls, ["10", "11", "12", "13", "14", "14"])
            self.assertEqual(cache_miss.outputs.lookups, ["10"])
            self.assertEqual(cache_hit.outputs.lookups, ["11"])
            self.assertEqual(failure_cache_miss.outputs.lookups, ["12"])
            self.assertEqual(lazy_blocked_cache_miss.outputs.lookups, ["13"])
            self.assertEqual(analytics._pending_execution_calls, {})
        finally:
            if previous_execution is None:
                sys.modules.pop("execution", None)
            else:
                sys.modules["execution"] = previous_execution

    def test_registry_resolution_uses_a_single_package_snapshot(self):
        original_discover = analytics._discover_packages
        calls = []

        def counting_discover():
            calls.append(True)
            return original_discover()

        analytics._discover_packages = counting_discover
        try:
            prompt = DynamicPrompt("example.custom")
            self.assertEqual(analytics._resolve_execution_node("1", prompt), "root0:ExamplePack")
            self.assertEqual(analytics._resolve_execution_node("2", prompt), "root0:ExamplePack")
            self.assertEqual(len(calls), 1)
        finally:
            analytics._discover_packages = original_discover

    def test_prompt_registry_cache_refreshes_when_comfyui_registers_nodes_later(self):
        fake_nodes = sys.modules["nodes"]
        original_mappings = fake_nodes.NODE_CLASS_MAPPINGS
        analytics._execution_registry_cache = None
        analytics._execution_registry_signature = None
        try:
            fake_nodes.NODE_CLASS_MAPPINGS = {}
            self.assertEqual(analytics._get_execution_registry_snapshot(), {})

            # Simulate ComfyUI completing custom-node registration after the
            # analytics extension was imported and after the first prompt
            # registry snapshot was requested.
            fake_nodes.NODE_CLASS_MAPPINGS = dict(original_mappings)
            snapshot = analytics._get_execution_registry_snapshot()
            self.assertEqual(snapshot.get("example.custom"), "root0:ExamplePack")
        finally:
            fake_nodes.NODE_CLASS_MAPPINGS = original_mappings

    def test_invalid_settings_payload_is_rejected(self):
        with self.assertRaises(ValueError):
            analytics.update_settings({"tracking_enabled": "yes"})
        with self.assertRaises(ValueError):
            analytics.update_settings([])


if __name__ == "__main__":
    unittest.main()
