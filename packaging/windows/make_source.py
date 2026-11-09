"""Assemble source materials alongside the distributable installer."""

from hashlib import file_digest
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


HERE = Path(__file__).resolve().parent
STUDIO = HERE.parent.parent
CACHE = STUDIO / "test-data" / "windows-packaging-cache"
DESTINATION = STUDIO / "output" / "windows" / "PaperTranslationStudio-Source-1.0.0.zip"
SOURCES = {
    "pymupdf-1.25.2.tar.gz": "9ea88ff1b3ccb359620f106a6fd5ba6877d959d21d78272052c3496ceede6eec",
    "pdf2zh-1.9.11.tar.gz": "8135d3d0b76d2416437b2245285dfe6acf576723e5219889b4a4960b267f4cb4",
    "babeldoc-0.2.33.tar.gz": "27d42d2e33f9389a1d9987d84854b84ff26ad78972186d8468fe331adcc447ee",
    "levenshtein-0.27.1.tar.gz": "3e18b73564cfc846eec94dd13fab6cb006b5d2e0cc56bad1fd7d5585881302e3",
    "python_levenshtein-0.27.1.tar.gz": "3a5314a011016d373d309a68e875fd029caaa692ad3f32e78319299648045f11",
    "mupdf-1.25.2-source.tar.gz": "36ccf6a5e691e188acf8db6e98d08bf05f27bb4ce30432dc15fc76d329a92d4d",
}


def main():
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    for name, expected in SOURCES.items():
        path = CACHE / name
        if not path.is_file():
            raise FileNotFoundError(f"缺少源码包 {name}。")
        if expected:
            with path.open("rb") as source:
                if file_digest(source, "sha256").hexdigest() != expected:
                    raise ValueError(f"源码包 {name} 校验失败。")

    with ZipFile(DESTINATION, "w", allowZip64=True) as output:
        included = [*STUDIO.glob("*.py"), STUDIO / "README.md", STUDIO / "THIRD_PARTY.md", STUDIO / "start.bat"]
        included += [path for path in (STUDIO / "static").rglob("*") if path.is_file()]
        included += [path for path in HERE.rglob("*") if path.is_file() and path.suffix.lower() in
                     {".py", ".ps1", ".cs", ".iss", ".txt", ".ico", ".md"}]
        for path in included:
            output.write(path, Path("paper-translation-studio") / path.relative_to(STUDIO), ZIP_DEFLATED)
        installed_pdf2zh = STUDIO.parent / "pdf2zh" / "build" / "site-packages" / "pdf2zh"
        for path in installed_pdf2zh.rglob("*.py"):
            output.write(path, Path("bundled-pdf2zh") / path.relative_to(installed_pdf2zh), ZIP_DEFLATED)
        for name in SOURCES:
            output.write(CACHE / name, Path("upstream-sources") / name, ZIP_STORED)
    print(f"已生成源码包：{DESTINATION}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        sys.exit(str(exc))
