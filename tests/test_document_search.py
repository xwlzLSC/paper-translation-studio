"""Regression for searchable CJK compatibility glyphs in translated PDFs."""
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock
import unittest

import document_search
import engine
import server


class DocumentSearchTests(unittest.TestCase):
    def test_pdf_matches_compatibility_glyphs_with_coordinates_for_each_hit(self):
        fitz = server.pdf_module()
        archive = next(engine.discover_pdf2zh().glob("offline_assets_*.zip"))
        font = fitz.Font(fontfile=str(engine._asset(archive, "fonts/SourceHanSerifCN-Regular.ttf")))
        with TemporaryDirectory(prefix="paper-search-") as directory:
            path = Path(directory) / "translated.pdf"
            with fitz.open() as doc:
                page = doc.new_page()
                writer = fitz.TextWriter(page.rect)
                writer.append((60, 80), "比 较\ufa38", font=font, fontsize=14)
                writer.append((60, 115), "比较\ufa38", font=font, fontsize=14)
                writer.write_text(page)
                self.assertIn("\ufa38", page.get_text())
                self.assertEqual(page.search_for("比较器"), [])
                doc.save(path)

            lock = RLock()
            text = document_search.SearchIndex().pdf_text(fitz, lock, path)
            results = document_search.search_text("比较器", ("translated",), {"translated": text}, 1, {1})
            boxes = document_search.match_boxes(fitz, lock, path, 1, "比较器")
            self.assertEqual(results["total"], 2)
            self.assertEqual([hit["match_index"] for hit in results["hits"]], [0, 1])
            self.assertEqual(boxes["match_ids"], [0, 1])
            self.assertLess(boxes["boxes"][0][1], boxes["boxes"][1][1])


if __name__ == "__main__":
    unittest.main()
