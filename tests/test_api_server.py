import asyncio
import importlib
import json
import sys
import types
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "comfyui_model_analytics_testpkg"

# api_server uses package-relative imports in ComfyUI. Load it under a synthetic
# package name so its production import path is tested without importing ComfyUI.
package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(PROJECT_ROOT)]
sys.modules.setdefault(PACKAGE_NAME, package)
api_server = importlib.import_module(f"{PACKAGE_NAME}.api_server")
custom_node_analytics = importlib.import_module(f"{PACKAGE_NAME}.custom_node_analytics")


class FakeRequest:
    def __init__(self, headers=None, query=None):
        self.headers = headers or {}
        self.query = query or {}


class CustomNodeApiCacheTests(unittest.TestCase):
    def setUp(self):
        self.original_builder = custom_node_analytics.build_custom_node_inventory
        custom_node_analytics.build_custom_node_inventory = lambda: {
            "success": True,
            "revision": "session-42",
            "packages": [],
            "workflows": [],
        }

    def tearDown(self):
        custom_node_analytics.build_custom_node_inventory = self.original_builder


class SharedUsageApiTests(unittest.TestCase):
    def setUp(self):
        self.original_inventory_builder = custom_node_analytics.build_custom_node_inventory
        custom_node_analytics.build_custom_node_inventory = lambda: {
            "success": True,
            "revision": "session-42",
            "packages": [],
            "workflows": [],
        }

    def tearDown(self):
        custom_node_analytics.build_custom_node_inventory = self.original_inventory_builder

    def test_usage_endpoint_combines_model_and_custom_package_analytics(self):
        original_model_builder = api_server.build_usage_analytics
        original_package_builder = custom_node_analytics.build_custom_node_usage_analytics
        api_server.build_usage_analytics = lambda period: {
            "success": True,
            "period": period,
            "models": [{"model_id": "checkpoints/example.safetensors"}],
        }
        custom_node_analytics.build_custom_node_usage_analytics = lambda period: {
            "period": period,
            "custom_packages": [{
                "package_id": "root0:ExamplePack",
                "prompt_count": 1,
                "source_counts": {"frontend": 0, "api": 1, "unknown": 0},
            }],
            "source_counts": {"frontend": 0, "api": 1, "unknown": 0},
        }
        try:
            response = asyncio.run(api_server.get_usage(FakeRequest(query={"period": "7d"})))
        finally:
            api_server.build_usage_analytics = original_model_builder
            custom_node_analytics.build_custom_node_usage_analytics = original_package_builder

        self.assertEqual(response.status, 200)
        payload = json.loads(response.body)
        self.assertEqual(payload["period"], "7d")
        self.assertEqual(payload["models"][0]["model_id"], "checkpoints/example.safetensors")
        self.assertEqual(payload["custom_packages"][0]["package_id"], "root0:ExamplePack")
        self.assertTrue(payload["custom_node_usage_available"])

    def test_matching_etag_returns_not_modified_without_payload(self):
        response = asyncio.run(api_server.get_custom_nodes(
            FakeRequest({"If-None-Match": '"custom-node-analytics-session-42"'})
        ))
        self.assertEqual(response.status, 304)
        self.assertEqual(response.headers.get("ETag"), '"custom-node-analytics-session-42"')

    def test_changed_etag_returns_fresh_inventory_and_new_validator(self):
        response = asyncio.run(api_server.get_custom_nodes(FakeRequest()))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get("ETag"), '"custom-node-analytics-session-42"')
        self.assertIn(b'"revision"', response.body)
        self.assertIn(b'session-42', response.body)


if __name__ == "__main__":
    unittest.main()
