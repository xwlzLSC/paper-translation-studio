"""Regression checks for consistency hints and legacy failed-page records."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import audit
import server


class AuditAndRetryTests(unittest.TestCase):
    def test_audit_pair_formula_and_citation_detection(self):
        # 1. Formula placeholder missing
        orig = "The thermal noise variance {v0} scales with {v1} [12]."
        trans_no_v1 = "热噪声方差 {v0} 随电容变化 [12]。"
        issues = audit.audit_pair(orig, trans_no_v1)
        self.assertTrue(any(i["type"] == "formula" and "{v1}" in i["message"] for i in issues))

        # 2. Citation missing
        trans_no_cite = "热噪声方差 {v0} 随电容 {v1} 变化。"
        issues2 = audit.audit_pair(orig, trans_no_cite)
        self.assertTrue(any(i["type"] == "citation" and "[12]" in i["message"] for i in issues2))

        # 3. Number missing / mismatched
        orig_num = "The power consumption is 14.8% and 3.14 mW as in Fig. 2."
        trans_wrong_num = "如图 2 所示功耗为 18.4% 和 3.14 mW。"
        issues3 = audit.audit_pair(orig_num, trans_wrong_num)
        self.assertTrue(any(i["type"] == "number" and "14.8%" in i["message"] for i in issues3))

        # 4. Perfectly consistent pair
        good_orig = "The voltage is 1.2 V with noise {v0} [1]."
        good_trans = "电压为 1.2 V，具有噪声 {v0} [1]。"
        issues_good = audit.audit_pair(good_orig, good_trans)
        self.assertEqual(issues_good, [])

    def test_audit_document_segments(self):
        segments = {
            "1": {
                "pairs": [
                    ["Noise is {v0} [1].", "噪声为 {v0} [1]。"],
                    ["Gain is 3.5 dB [2].", "增益为 4.5 dB。"],  # Missing citation [2] and number 3.5
                ]
            }
        }
        report = audit.audit_document_segments(segments)
        self.assertGreaterEqual(report["total_issues"], 2)
        self.assertIn("1", report["details"])

    def test_audit_distinguishes_unit_mismatches_from_equivalent_values(self):
        self.assertEqual(audit.audit_pair("The supply is 0.5 V [2 - 4].", "电源为 500 毫伏【2、3、4】。"), [])
        issues = audit.audit_pair("The supply is 0.5 V with a change of −1.20%.", "电源为 0.5 mV，变化为 1.2%。")
        self.assertEqual({issue["type"] for issue in issues}, {"unit", "number"})

    def test_legacy_partial_result_does_not_requeue_usable_pages(self):
        with TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            app = server.Workbench(data_dir)
            job_folder = data_dir / "testjob123456789012345678901234"
            job_folder.mkdir(parents=True)
            job = {
                "id": "testjob123456789012345678901234",
                "name": "sample.pdf",
                "pages": 3,
                "state": "failed",
                "has_result": True,
                "page_range": "1-3",
            }
            # Page 1 has valid pairs, Page 2 has empty translation, Page 3 is missing
            segments = {
                "1": {"mode": "layout", "pairs": [["Intro", "引言"]]},
                "2": {"mode": "layout", "pairs": [["Formula {v0}", ""]]},
            }
            (job_folder / "segments.json").write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
            (job_folder / "job.json").write_text(json.dumps(job), encoding="utf-8")
            app.jobs[job["id"]] = job

            failed = app.find_failed_pages(job)
            self.assertEqual(failed, [2, 3])
            job["state"] = "completed"
            self.assertEqual(app.find_failed_pages(job), [2])


if __name__ == "__main__":
    unittest.main()
