"""Run the Argos English-to-Chinese package on the portable Windows CPU runtime."""

from functools import cache
from hashlib import file_digest
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile


ASSETS = Path(__file__).resolve().parent / ".offline-translation-v1"
MODEL_FOLDER = "translate-en_zh-1_9"
RUNTIME_FILES = ("ctranslate2/__init__.py", "sentencepiece/__init__.py")
MODEL_FILES = (
    "metadata.json", "README.md", "sentencepiece.model",
    "model/model.bin", "model/config.json", "model/shared_vocabulary.json",
)
DOWNLOADS = (
    (
        "https://files.pythonhosted.org/packages/cb/84/6a2f815ca1f6f29c3f176902e4b9ddaf7a105e07a822d7740858f331e417/"
        "ctranslate2-4.8.5-cp312-cp312-win_amd64.whl",
        "16b1478f9dccd3c6eedb7a1b2e23cb2a41f03976266b71afa1bd9019df7c7014",
    ),
    (
        "https://files.pythonhosted.org/packages/2d/81/92df5673c067148c2545b1bfe49adfd775bcc3a169a047f5a0e6575ddaca/"
        "sentencepiece-0.2.1-cp312-cp312-win_amd64.whl",
        "4cdc7c36234fda305e85c32949c5211faaf8dd886096c7cea289ddc12a2d02de",
    ),
    (
        f"https://argos-net.com/v1/{MODEL_FOLDER}.argosmodel",
        "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab",
    ),
)
SENTENCE_BOUNDARY = re.compile(r"(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])")
TOKEN_LIMIT = 128


def available(folder=None):
    folder = folder or ASSETS
    return (
        all((folder / "runtime" / name).is_file() for name in RUNTIME_FILES)
        and all((folder / MODEL_FOLDER / name).is_file() for name in MODEL_FILES)
    )


def install():
    if available():
        print("离线英译中已就绪。", flush=True)
        return
    if ASSETS.exists():
        raise RuntimeError(f"离线翻译目录不完整。请移走 {ASSETS} 后再安装。")
    with TemporaryDirectory(prefix=".offline-translation-", dir=ASSETS.parent) as temp:
        stage = Path(temp)
        payload = stage / "assets"
        for url, expected in DOWNLOADS:
            name = url.rsplit("/", 1)[1]
            download = stage / name
            print(f"正在下载 {name}", flush=True)
            subprocess.run(
                ["curl.exe", "--fail", "--location", "--retry", "2", "--connect-timeout", "15",
                 "--max-time", "180", "--proto", "=https", "--proto-redir", "=https",
                 "--output", str(download), url],
                check=True,
            )
            with download.open("rb") as file:
                if file_digest(file, "sha256").hexdigest() != expected:
                    raise RuntimeError(f"{name} 校验失败，请重新运行安装。")
            with ZipFile(download) as archive:
                if name.endswith(".whl"):
                    archive.extractall(payload / "runtime")
                else:
                    archive.extractall(payload, [f"{MODEL_FOLDER}/{name}" for name in MODEL_FILES])
        if not available(payload):
            raise RuntimeError("离线翻译文件缺失，请重新运行安装。")
        try:
            payload.rename(ASSETS)
        except OSError:
            if not available():
                raise
    print("离线英译中已安装。启动论文译读，在翻译服务中选择「本机离线 · 免费英译中」。", flush=True)


@cache
def _engine():
    from engine import discover_pdf2zh

    for folder in (discover_pdf2zh() / "site-packages", ASSETS / "runtime"):
        path = str(folder)
        if path not in sys.path:
            sys.path.insert(0, path)
    import ctranslate2
    from sentencepiece import SentencePieceProcessor

    model = ASSETS / MODEL_FOLDER
    tokenizer = SentencePieceProcessor(model_file=str(model / "sentencepiece.model"))
    translator = ctranslate2.Translator(
        str(model / "model"), device="cpu", intra_threads=min(4, os.cpu_count() or 1),
    )
    return translator, tokenizer


def _encode(text, tokenizer):
    for sentence in SENTENCE_BOUNDARY.split(text.strip()):
        tokens = tokenizer.encode(sentence, out_type=str)
        while len(tokens) > TOKEN_LIMIT:
            cut = next(
                (i for i in range(TOKEN_LIMIT, TOKEN_LIMIT // 2, -1) if tokens[i].startswith("▁")),
                TOKEN_LIMIT,
            )
            yield tokens[:cut]
            tokens = tokens[cut:]
        if tokens:
            yield tokens


def translate_texts(texts):
    if not texts:
        return []
    translator, tokenizer = _engine()
    groups = [list(_encode(text, tokenizer)) for text in texts]
    tokens = [sentence for group in groups for sentence in group]
    translated = iter(translator.translate_batch(tokens, beam_size=4, max_batch_size=16, max_decoding_length=256))
    return [
        " ".join(tokenizer.decode(next(translated).hypotheses[0]).replace("▁", " ").strip() for _ in group).strip()
        for group in groups
    ]


if __name__ == "__main__":
    try:
        install()
    except (OSError, RuntimeError, subprocess.CalledProcessError, BadZipFile, KeyError) as exc:
        sys.exit(f"离线翻译安装失败。{exc}")
