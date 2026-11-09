"""Exercise the real HTTP, portable layout/OCR and export path offline."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import Thread
from time import monotonic, sleep
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import quote
from zipfile import ZipFile

import server


@contextmanager
def listen(handler, app=None):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as http:
        http.app = app
        thread = Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{http.server_port}"
        finally:
            http.shutdown()
            thread.join()


class FakeCompletions(BaseHTTPRequestHandler):
    """Return deterministic Chinese text while exercising the HTTP client."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer test-key":
            self.send_error(401)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        payload = json.loads(body["messages"][-1]["content"])
        translations = [
            {"id": block["id"], "text": "采样电容的噪声。" + " ".join(re.findall(r"\{v\d+\}", block["text"]))}
            for block in reversed(payload["blocks"])
        ]
        response = json.dumps({"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"translations": translations}, ensure_ascii=False)}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def fetch(url, *, payload=None, upload=None, post=False, method=None, filename="mixed-test.pdf"):
    body = upload if upload is not None else (json.dumps(payload).encode() if payload is not None else None)
    headers = {}
    if upload is not None:
        headers.update({"Content-Type": "application/octet-stream", "X-Filename": quote(filename, safe="")})
    elif payload is not None:
        headers["Content-Type"] = "application/json"
    if post or body is not None:
        headers["X-Local-Request"] = "1"
    method = method or ("POST" if post or body is not None else "GET")
    with urlopen(Request(url, body, headers, method=method), timeout=30) as response:
        content = response.read()
        return json.loads(content) if response.headers.get_content_type() == "application/json" else content


def fixture(directory):
    fitz = server.pdf_module()
    path = directory / "native.pdf"
    server.write_example(path)
    with fitz.open(path) as paper:
        scan = paper[1].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        page = paper.new_page(pno=1, width=540, height=695)
        page.insert_image(page.rect, pixmap=scan)
        assert not page.get_text()
        return paper.tobytes(garbage=3, deflate=True)


class RetryCompletions(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, payload):
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/v1/models":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != "Bearer test-key":
            self.send_error(401)
            return
        self.send_json({"data": [
            {"id": "test-model", "name": "Live catalog model", "output_modalities": ["text"]},
            {"id": "demo-image-output", "output_modalities": ["image"]},
        ]})

    def do_POST(self):
        if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer test-key":
            self.send_error(401)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        blocks = json.loads(body["messages"][-1]["content"])["blocks"]
        texts = [block["text"] for block in blocks]
        self.server.app["requests"].append(texts)
        second = any("settling error" in text.lower() for text in texts)
        if second and self.server.app["fail_page"]:
            self.send_error(503)
            return
        label = "建立误差复测。" if second else "采样电容的噪声。"
        translations = [{"id": block["id"], "text": label + "".join(re.findall(r"\{v\d+\}", block["text"]))}
                        for block in blocks]
        self.send_json({"choices": [{"message": {"content": json.dumps({"translations": translations})}}]})


class WorkbenchTests(unittest.TestCase):
    def test_retry_preserves_published_pdf_pages_and_edited_segments(self):
        api_state = {"requests": [], "fail_page": True}
        with TemporaryDirectory(prefix="paper-retry-") as tmp, listen(RetryCompletions, api_state) as api:
            root = Path(tmp)
            path = root / "source.pdf"
            server.write_example(path)
            fitz = server.pdf_module()
            with fitz.open(path) as paper:
                paper[1].insert_text((48, 500), "References", fontsize=14)
                paper[1].insert_text((48, 525), "Reference entry for filtered retries.", fontsize=11)
                source = paper.tobytes()
            workbench = server.Workbench(root / "data")
            try:
                with listen(server.Handler, workbench) as host:
                    settings = {"provider": "api", "base_url": api + "/v1", "api_key": "test-key", "model": "test-model"}
                    catalog = fetch(host + "/api/models", payload={**settings, "base_url": api + "/v1/chat/completions"})
                    self.assertEqual(catalog["models"], [{"id": "test-model", "label": "Live catalog model", "group": "自定义 · OpenAI 兼容 API"}])
                    denied = fetch(host + "/api/models", payload={**settings, "api_key": "wrong"})
                    self.assertFalse(denied["ok"])
                    self.assertEqual(denied["models"], [])

                    uploaded = fetch(host + "/api/upload", upload=source)["job"]
                    uri = f"{host}/api/jobs/{uploaded['id']}"

                    def await_result():
                        deadline = monotonic() + 90
                        while monotonic() < deadline:
                            job, = fetch(host + "/api/jobs")["jobs"]
                            if job["state"] not in server.ACTIVE:
                                return job
                            sleep(.15)
                        self.fail("Translation never left the queue")

                    fetch(uri + "/translate", payload={**settings, "ignore_content": ["references"]})
                    partial = await_result()
                    self.assertEqual(partial["state"], "completed", partial.get("error", ""))
                    self.assertEqual(partial["failed_pages"], [2])
                    self.assertEqual(partial["retry_settings"]["ignore_content"], ["references"])
                    before = fetch(uri + "/download/translated")
                    with fitz.open(stream=before) as pdf:
                        first_pixels = pdf[0].get_pixmap().samples
                        self.assertIn("采样电容", pdf[0].get_text())
                        self.assertIn("Measuring the settling error", pdf[1].get_text())
                    with fitz.open(stream=fetch(uri + "/download/bilingual")) as pdf:
                        self.assertEqual(len(pdf), 2)

                    edited = fetch(uri + "/text/1")
                    edited["pairs"][0][1] = "人工校对标记 [99]。"
                    fetch(uri + "/text/1", payload=edited, method="PUT")
                    found = fetch(uri + "/search?" + "q=" + quote("人工校对标记") + "&side=translated")
                    self.assertEqual(found["hits"], [])
                    self.assertTrue(fetch(uri + "/search/boxes?q=settling%20error&side=original&page=2")["boxes"])
                    self.assertFalse(fetch(uri + "/search?q=Measuring&side=translated")["hits"])

                    fetch(uri + "/retry-failed", payload=settings)
                    self.assertEqual(await_result()["failed_pages"], [2])
                    self.assertEqual(fetch(uri + "/download/translated"), before)
                    api_state["fail_page"] = False
                    api_state["requests"].clear()
                    fetch(host + "/api/settings", payload={"ignore_content": []})
                    fetch(uri + "/retry-failed", payload=settings)
                    after = await_result()
                    self.assertEqual(after["state"], "completed", after.get("error", ""))
                    self.assertEqual(after["failed_pages"], [])
                    self.assertEqual(after["retry_settings"]["ignore_content"], ["references"])
                    self.assertTrue(api_state["requests"])
                    self.assertTrue(all("Reducing noise" not in text for request in api_state["requests"] for text in request))
                    self.assertTrue(all("Reference entry" not in text for request in api_state["requests"] for text in request))
                    with fitz.open(stream=fetch(uri + "/download/translated")) as pdf:
                        self.assertEqual(pdf[0].get_pixmap().samples, first_pixels)
                        self.assertIn("建立误差复测", pdf[1].get_text())
                        self.assertIn("Reference entry for filtered retries.", pdf[1].get_text())
                    self.assertEqual(fetch(uri + "/text/1")["pairs"][0][1], "人工校对标记 [99]。")
                    self.assertEqual(fetch(uri + "/audit")["summary"]["citation"], 1)
                    self.assertTrue(fetch(uri + "/search?q=" + quote("建立误差复测") + "&side=translated")["hits"])
            finally:
                workbench.worker.shutdown()

    def test_imports_word_notes_and_images_as_pdfs_and_keeps_source(self):
        with TemporaryDirectory(prefix="paper-studio-import-") as tmp, listen(FakeCompletions) as api:
            fitz = server.pdf_module()
            from PIL import Image

            docx = BytesIO()
            with ZipFile(docx, "w") as package:
                package.writestr("word/document.xml", """<w:document
                    xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                    <w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
                    <w:r><w:t>Sampling noise in analog circuits</w:t></w:r></w:p>
                    <w:p><w:r><w:t>The sampling capacitor reduces thermal noise in this experiment.</w:t></w:r></w:p>
                    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Measurement</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>Noise power</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
                    </w:body></w:document>""")
            tiff = BytesIO()
            with Image.new("RGB", (250, 350), "white") as first, Image.new("RGB", (350, 250), "black") as second:
                first.save(tiff, format="TIFF", save_all=True, append_images=[second])
            cases = (
                ("采样记录.DOCX", docx.getvalue(), 1, "Noise power"),
                ("笔记.txt", "采样记录\n\n测量噪声。".encode("gb18030"), 1, "测量噪声"),
                ("笔记.markdown", "# Methods\n\n| Value |\n| --- |\n| 10 mV |\n", 1, "10 mV"),
                ("扫描.tiff", tiff.getvalue(), 2, ""),
            )
            workbench = server.Workbench(Path(tmp))
            try:
                with listen(server.Handler, workbench) as host:
                    for filename, data, pages, expected in cases:
                        with self.subTest(filename=filename):
                            data = data.encode() if isinstance(data, str) else data
                            job = fetch(host + "/api/upload", upload=data, filename=filename)["job"]
                            self.assertEqual(job["name"], filename)
                            self.assertEqual(job["source_format"], filename.rsplit(".", 1)[1].lower())
                            self.assertEqual(job["pages"], pages)
                            uri = f"{host}/api/jobs/{job['id']}"
                            self.assertEqual(fetch(uri + "/download/source"), data)
                            with fitz.open(stream=fetch(uri + "/download/original")) as original:
                                self.assertEqual(len(original), pages)
                                if expected:
                                    self.assertIn(expected, original[0].get_text())
                                else:
                                    self.assertFalse(original[0].get_text().strip())
                                    self.assertTrue(all(page.get_images() for page in original))
                            if filename.endswith(".DOCX"):
                                options = {"provider": "api", "base_url": api + "/v1", "api_key": "test-key",
                                           "model": "test-model", "pages": "1"}
                                fetch(uri + "/translate", payload=options)
                                deadline = monotonic() + 90
                                while monotonic() < deadline:
                                    current = next(item for item in fetch(host + "/api/jobs")["jobs"] if item["id"] == job["id"])
                                    if current["state"] not in server.ACTIVE:
                                        break
                                    sleep(0.25)
                                self.assertEqual(current["state"], "completed", current.get("error", ""))
                                with fitz.open(stream=fetch(uri + "/download/translated")) as translated:
                                    self.assertIn("采样电容", translated[0].get_text())
                    with self.assertRaises(HTTPError) as error:
                        fetch(host + "/api/upload", upload=b"not a docx", filename="broken.docx")
                    self.assertEqual(error.exception.code, 400)
                    self.assertEqual(len(fetch(host + "/api/jobs")["jobs"]), len(cases))
            finally:
                workbench.worker.shutdown()

    def test_layout_and_scan_in_one_job_with_side_by_side_exports(self):
        with TemporaryDirectory(prefix="paper-studio-test-") as tmp, listen(FakeCompletions) as api:
            root = Path(tmp)
            contents = fixture(root)
            workbench = server.Workbench(root / "data")
            try:
                with listen(server.Handler, workbench) as host:
                    original = fetch(host + "/api/upload", upload=contents)["job"]
                    self.assertEqual(original["pages"], 3)
                    uri = f"{host}/api/jobs/{original['id']}"
                    settings = {"provider": "api", "base_url": api + "/v1", "api_key": "test-key",
                                "model": "test-model", "pages": "1-2", "glossary": "noise = 噪声"}
                    self.assertTrue(fetch(host + "/api/check", payload=settings)["ok"])
                    fetch(uri + "/translate", payload=settings)
                    deadline = monotonic() + 120
                    while monotonic() < deadline:
                        job, = fetch(host + "/api/jobs")["jobs"]
                        if job["state"] not in server.ACTIVE:
                            break
                        sleep(0.3)
                    self.assertEqual(job["state"], "completed", job.get("error", ""))
                    self.assertEqual(job["ocr_pages"], [2])
                    self.assertNotIn("test-key", (root / "data" / job["id"] / "job.json").read_text(encoding="utf-8"))
                    self.assertEqual(fetch(uri + "/text/1")["mode"], "layout")
                    scan = fetch(uri + "/text/2")
                    self.assertEqual(scan["mode"], "ocr")
                    self.assertIn("settling error", " ".join(pair[0] for pair in scan["pairs"]).lower())
                    self.assertEqual(fetch(uri + "/text/3")["pairs"], [])
                    self.assertIn("第 2 页（OCR）", fetch(uri + "/download/markdown").decode())
                    self.assertTrue(fetch(uri + "/page/translated/2.png").startswith(b"\x89PNG"))

                    fitz = server.pdf_module()
                    spread = fetch(uri + "/download/bilingual")
                    self.assertLess(len(spread), 2 * 1024 * 1024, "An OCR page should not embed an entire CJK font")
                    with (fitz.open(stream=contents) as source,
                          fitz.open(stream=fetch(uri + "/download/translated")) as mono,
                          fitz.open(stream=spread) as dual):
                        self.assertEqual(len(source), len(mono))
                        self.assertEqual(len(source), len(dual))
                        self.assertEqual(source[0].rect, mono[0].rect)
                        self.assertIn("采样电容", mono[0].get_text())
                        self.assertIn("采样电容", mono[1].get_text())
                        self.assertEqual(source[2].get_text(), mono[2].get_text())
                        self.assertGreater(dual[0].rect.width, source[0].rect.width * 2)
                        translated_right = dual[0].get_text(clip=fitz.Rect(
                            source[0].rect.width + 12, 0, dual[0].rect.width, dual[0].rect.height))
                        self.assertIn("采样电容", translated_right)
            finally:
                workbench.worker.shutdown()

    def test_bundled_demo_can_be_viewed_without_a_model(self):
        with TemporaryDirectory(prefix="paper-demo-test-") as tmp:
            workbench = server.Workbench(Path(tmp))
            try:
                with listen(server.Handler, workbench) as host:
                    first = fetch(host + "/api/demo", post=True)["job"]
                    second = fetch(host + "/api/demo", post=True)["job"]
                    self.assertEqual(first["id"], second["id"])
                    self.assertTrue(first["has_text"])
                    self.assertTrue(len(first.get("toc", [])) >= 2)
                    self.assertIn("采样电路", fetch(host + f"/api/jobs/{first['id']}/text/1")["pairs"][0][1])

                    # Exercise full segments, inline segment editing, and multi-format exports
                    all_segs = fetch(host + f"/api/jobs/{first['id']}/segments")["pages"]
                    self.assertIn("1", all_segs)
                    pairs_p1 = all_segs["1"]["pairs"]
                    pairs_p1[0][1] = "已在线校对的标题译文"
                    updated = fetch(host + f"/api/jobs/{first['id']}/text/1", payload={"pairs": pairs_p1})
                    self.assertEqual(updated["pairs"][0][1], "已在线校对的标题译文")
                    self.assertIn("已在线校对的标题译文", fetch(host + f"/api/jobs/{first['id']}/download/markdown_mono").decode("utf-8"))
                    self.assertIn("已在线校对的标题译文", fetch(host + f"/api/jobs/{first['id']}/download/html").decode("utf-8"))
                    self.assertIn("已在线校对的标题译文", fetch(host + f"/api/jobs/{first['id']}/download/word").decode("utf-8"))

                    # Exercise persistent settings storage
                    saved = fetch(host + "/api/settings", payload={"provider": "magpie", "model": "auto/gemini-3.8-flash", "concurrency": 6})
                    self.assertEqual(saved["active_provider"], "magpie")
                    self.assertEqual(saved["concurrency"], 6)
                    self.assertEqual(fetch(host + "/api/settings")["profiles"]["magpie"]["model"], "auto/gemini-3.8-flash")
            finally:
                workbench.worker.shutdown()

    def test_paragraph_pdf_writeback_and_note_snapshot(self):
        with TemporaryDirectory(prefix="paper-review-test-") as tmp:
            workbench = server.Workbench(Path(tmp))
            try:
                with listen(server.Handler, workbench) as host:
                    job = fetch(host + "/api/demo", post=True)["job"]
                    uri = f"{host}/api/jobs/{job['id']}"
                    original_page = fetch(uri + "/text/1")
                    review = fetch(uri + "/paragraph/1/0")
                    note = fetch(uri + "/notes", payload={
                        "page": 1, "segment": 0, "revision": review["revision"], "comment": "保留校对前的摘录",
                    })["note"]
                    draft = fetch(uri + "/paragraph/1/1", method="PUT", payload={
                        "translation": "另一段的文字稿", "revision": review["revision"], "write_pdf": False,
                    })["job"]
                    written = fetch(uri + "/paragraph/1/0", method="PUT", payload={
                        "translation": "回写后的论文标题", "revision": draft["text_revision"],
                    })["job"]
                    self.assertNotEqual(written["result_id"], job.get("result_id"))
                    self.assertEqual(fetch(uri + "/text/1")["pairs"][1][1], "另一段的文字稿")
                    with server.pdf_module().open(stream=fetch(uri + "/download/translated")) as pdf:
                        rendered = server.document_search.normalize(pdf[0].get_text())
                        self.assertIn("回写后的论文标题", rendered)
                        self.assertNotIn("另一段的文字稿", rendered)
                    notes = fetch(uri + "/notes")["notes"]
                    self.assertEqual(notes[0]["translation"], original_page["pairs"][0][1])
                    self.assertIn("保留校对前的摘录", fetch(uri + "/notes.md").decode("utf-8"))
                    with self.assertRaises(HTTPError) as stale:
                        fetch(uri + "/paragraph/1/0", method="PUT", payload={
                            "translation": "过期的译文", "revision": review["revision"],
                        })
                    self.assertEqual(stale.exception.code, 409)
                    fetch(f"{uri}/notes/{note['id']}", method="DELETE", post=True)
                    self.assertEqual(fetch(uri + "/notes")["notes"], [])
            finally:
                workbench.worker.shutdown()


if __name__ == "__main__":
    unittest.main()
