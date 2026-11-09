import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import providers


def answer(*items):
    return {"translations": [{"id": i, "text": text} for i, text in items]}


class ProviderTests(unittest.TestCase):
    def test_offline_keeps_formula_when_first_translation_changes_it(self):
        source = "The measured noise is {v0}."
        with (
            patch("providers.offline_translation.available", return_value=True),
            patch("providers.offline_translation.translate_texts",
                  side_effect=[["实测噪声为。"], ["实测噪声为"]]) as infer,
        ):
            provider = providers.make_provider({"provider": "offline"})
            self.assertEqual(provider.translate([source], "zh"), ["实测噪声为 {v0}."])
            self.assertEqual(infer.call_args.args, (["The measured noise is "],))

    def test_cli_reuses_chatgpt_login_and_reads_utf8_from_stdin(self):
        # Fake the CLI executable but run the real subprocess/stdin path.
        script = r'''
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
assert not os.environ.get("OPENAI_API_KEY")
if args == ["login", "status"]:
    print("Logged in using ChatGPT")
else:
    assert args[-1] == "-" and "--ephemeral" in args
    assert args[args.index("--sandbox") + 1] == "read-only"
    request = sys.stdin.buffer.read().decode("utf-8").split("Source data (JSON):\n", 1)[1]
    assert json.loads(request)["blocks"][0]["text"] == "noise {v0}"
    result = {"translations": [{"id": 0, "text": "噪声 {v0}"}]}
    Path(args[args.index("--output-last-message") + 1]).write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )
'''
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "fake_codex.py"
            fake.write_text(script, encoding="utf-8")
            with (
                patch.object(providers, "_command", return_value=[sys.executable, str(fake)]),
                patch.dict("os.environ", {"OPENAI_API_KEY": "must-not-reach-child"}),
            ):
                provider = providers.make_provider({"provider": "codex"})
                self.assertEqual(provider.translate(["noise {v0}"], "简体中文"), ["噪声 {v0}"])

    def test_antigravity_reads_structured_stream_result(self):
        ndjson = "\n".join((
            json.dumps({"event": "init", "init": {}}),
            json.dumps({"event": "result", "result": {"status": "SUCCESS", "structured_output": answer((0, "结果"))}}),
        ))
        with (
            patch.object(providers, "_command", return_value=["agy"]),
            patch.object(providers, "_validate_agy_settings"),
            patch.object(providers, "_process", return_value=(0, ndjson, "")) as run,
        ):
            provider = providers.make_provider({"provider": "antigravity"})
            self.assertEqual(provider.translate(["Result"], "Chinese"), ["结果"])
            self.assertIn("--disable-slash-commands", run.call_args.args[0])
            event = json.loads(run.call_args.kwargs["data"])
            self.assertEqual(event["event"], "user")
            self.assertIn("Result", event["message"]["content"])

    def test_api_puts_out_of_order_results_back_in_document_order(self):
        response = {"choices": [{"message": {"content": json.dumps(answer((1, "乙"), (0, "甲 {v0}")))}}]}
        with patch("urllib.request.build_opener") as build:
            opener = build.return_value
            opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(response).encode("utf-8")
            provider = providers.make_provider({
                "provider": "gemini", "model": "example", "api_key": "fake-test-key",
            })
            self.assertEqual(provider.translate(["Alpha {v0}", "Beta"], "Chinese"), ["甲 {v0}", "乙"])
            request = opener.open.call_args.args[0]
            self.assertEqual(request.full_url, providers.GEMINI_BASE_URL + "/chat/completions")
            self.assertEqual(request.get_header("Authorization"), "Bearer fake-test-key")
            self.assertEqual(json.loads(json.loads(request.data)["messages"][1]["content"])["blocks"][1]["id"], 1)

    def test_result_that_changes_placeholder_is_rejected(self):
        with self.assertRaisesRegex(providers.ProviderError, "占位符"):
            providers._validate(answer((0, "损坏 {v1}")), ["original {v0}"])

    def test_api_rejects_cleartext_remote_endpoint_and_accepts_localhost_without_key(self):
        remote = providers.check_provider({
            "provider": "api", "base_url": "http://example.test", "model": "demo",
        })
        local = providers.check_provider({
            "provider": "api", "base_url": "http://127.0.0.1:9001/v1", "model": "demo",
        })
        self.assertFalse(remote["ok"])
        self.assertTrue(local["ok"])

    def test_magpie_fetch_models_and_reasoning_think_stripping(self):
        fake_models = {
            "object": "list",
            "data": [
                {"id": "auto/gemini-3.8-flash", "magpie_label": "Gemini 3.8 Flash · routing", "owned_by": "gemini"},
                {"id": "deepseek/deepseek-v4-pro", "display_name": "DeepSeek V4 Pro", "owned_by": "deepseek"},
            ],
        }
        with patch("urllib.request.build_opener") as build:
            opener = build.return_value
            opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_models).encode("utf-8")
            result = providers.fetch_models({"provider": "magpie"})
            self.assertTrue(result["ok"])
            self.assertEqual(len(result["models"]), 2)
            self.assertEqual(result["models"][0]["id"], "auto/gemini-3.8-flash")
        raw_with_think = "<think>\nanalyzing terminology...\n</think>\n```json\n" + json.dumps(answer((0, "降噪 {v0}"))) + "\n```"
        self.assertEqual(providers._validate(raw_with_think, ["noise {v0}"]), ["降噪 {v0}"])

    def test_deepseek_harness_stable_prefix_and_append_only_session_lanes(self):
        captured_requests = []

        def fake_open(req, timeout=150):
            body = json.loads(req.data.decode("utf-8"))
            captured_requests.append(body)
            user_blocks = json.loads(body["messages"][-1]["content"])["blocks"]
            ans = answer(*[(b["id"], f"译文_{b['text']}") for b in user_blocks])
            resp = {
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(ans, ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 1200, "prompt_cache_hit_tokens": 1024, "completion_tokens": 80},
            }
            mock_resp = unittest.mock.MagicMock()
            mock_resp.__enter__.return_value.read.return_value = json.dumps(resp).encode("utf-8")
            return mock_resp

        with patch("urllib.request.build_opener") as build:
            build.return_value.open.side_effect = fake_open
            provider = providers.make_provider({
                "provider": "deepseek",
                "model": "deepseek-chat",
                "api_key": "fake-ds-key",
                "glossary": "zeta = 泽塔\nalpha = 阿尔法",
            })
            provider.prepare_context("Sample abstract on thermal noise.", target="zh", auto_glossary=False)
            out1 = provider.translate(["First block {v0}"], "zh")
            out2 = provider.translate(["Second block {v1}"], "zh")
            self.assertEqual(out1, ["译文_First block {v0}"])
            self.assertEqual(out2, ["译文_Second block {v1}"])
            self.assertEqual(len(captured_requests), 2)
            # System prompt must be 100% byte-identical across turns and contain sorted glossary + doc context
            sys1 = captured_requests[0]["messages"][0]["content"]
            sys2 = captured_requests[1]["messages"][0]["content"]
            self.assertEqual(sys1, sys2)
            self.assertIn("- alpha => 阿尔法\n- zeta => 泽塔", sys1)
            self.assertIn("Sample abstract on thermal noise.", sys1)
            # Turn 2 must append Turn 1 user & verbatim assistant messages before Turn 2 user message
            self.assertEqual(len(captured_requests[0]["messages"]), 2)
            self.assertEqual(len(captured_requests[1]["messages"]), 4)
            self.assertEqual(captured_requests[1]["messages"][1]["role"], "user")
            self.assertEqual(captured_requests[1]["messages"][2]["role"], "assistant")
            # Usage telemetry must report 85.3% cache hit rate (2048 / 2400)
            summary = provider.get_usage_summary()
            self.assertEqual(summary["requests"], 2)
            self.assertEqual(summary["cached_tokens"], 2048)
            self.assertAlmostEqual(summary["cache_hit_rate"], 85.3, places=1)


if __name__ == "__main__":
    unittest.main()
