"""Local consistency hints for academic translation pairs."""

from collections import Counter
from decimal import Decimal, InvalidOperation
import re
import unicodedata


FORMULA_RE = re.compile(r"\{v\d+\}|〔公式见\s*PDF〕", re.I)
_CITE_ITEM = r"\d{1,5}(?:\s*[-–—]\s*\d{1,5})?"
CITATION_RE = re.compile(rf"\[\s*({_CITE_ITEM}(?:\s*[,、]\s*{_CITE_ITEM})*)\s*\]")
_NUMBER = r"[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d{1,3})?"
# Canonical dimensions and scale factors allow equivalent SI conversions.
_UNIT_GROUPS = {
    "voltage": {"V": "1", "伏": "1", "伏特": "1", "mV": ".001", "毫伏": ".001", "μV": ".000001"},
    "current": {"A": "1", "安培": "1", "mA": ".001", "毫安": ".001", "μA": ".000001", "nA": "1e-9"},
    "power": {"W": "1", "瓦": "1", "mW": ".001", "毫瓦": ".001", "μW": ".000001", "nW": "1e-9", "pW": "1e-12"},
    "frequency": {"Hz": "1", "赫兹": "1", "kHz": "1e3", "千赫": "1e3", "MHz": "1e6", "兆赫": "1e6", "GHz": "1e9", "吉赫": "1e9"},
    "distance": {"m": "1", "米": "1", "cm": ".01", "厘米": ".01", "mm": ".001", "毫米": ".001", "μm": "1e-6", "微米": "1e-6", "nm": "1e-9", "纳米": "1e-9", "km": "1e3", "千米": "1e3"},
    "duration": {"s": "1", "秒": "1", "ms": ".001", "毫秒": ".001", "μs": "1e-6", "微秒": "1e-6", "ns": "1e-9", "ps": "1e-12", "fs": "1e-15"},
    "resistance": {"Ω": "1", "欧姆": "1", "kΩ": "1e3", "MΩ": "1e6"},
    "capacitance": {"F": "1", "μF": "1e-6", "nF": "1e-9", "pF": "1e-12", "fF": "1e-15"},
    "level": {"dB": "1", "分贝": "1"},
    "celsius": {"°C": "1", "摄氏度": "1"},
    "temperature": {"K": "1"},
    "percent": {"%": "1"},
}
_UNITS = {
    label: (dimension, Decimal(scale))
    for dimension, items in _UNIT_GROUPS.items()
    for label, scale in items.items()
}
_UNITS.update({label.replace("μ", "u"): unit for label, unit in _UNITS.items() if label.startswith("μ")})
_UNIT_RE = "|".join(re.escape(label) for label in sorted(_UNITS, key=len, reverse=True))
DATA_RE = re.compile(rf"(?<![A-Za-z0-9_.,])(?P<number>{_NUMBER})(?:\s*(?P<unit>{_UNIT_RE}))?(?![A-Za-z0-9_]|\.\d|,\d)")
PERCENT_CN = re.compile(rf"百分之\s*({_NUMBER})")
_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def _normalize(text):
    text = unicodedata.normalize("NFKC", text).translate(str.maketrans({"−": "-", "【": "[", "】": "]"}))
    return PERCENT_CN.sub(r"\1%", text)


def _citations(text):
    result = set()
    for match in CITATION_RE.finditer(text):
        for part in re.split(r"[,、]", match[1]):
            bounds = [int(n) for n in re.findall(r"\d+", part)]
            start, end = bounds[0], bounds[-1]
            if 0 <= end - start <= 80:
                result.update(str(i) for i in range(start, end + 1))
            else:
                result.add(f"{start}–{end}")
    return result


def _data(text):
    text = FORMULA_RE.sub(" ", CITATION_RE.sub(" ", text))
    numbers, units = {}, {}
    for match in DATA_RE.finditer(text):
        raw, label = match.group("number", "unit")
        try:
            value = Decimal(raw.replace(",", ""))
        except InvalidOperation:
            continue
        if label and label != "%":
            dimension, scale = _UNITS[label]
            units.setdefault((dimension, value * scale), f"{raw} {label}")
        elif label == "%" or len(raw) > 1:
            # Single-digit bare numbers often serve as section labels. A unit
            # or percentage makes even a single-digit number meaningful here.
            numbers.setdefault((value, label or ""), raw + (label or ""))
    return numbers, units


def _labels(values, limit=4):
    values = list(values)
    return "、".join(values[:limit]) + ("等" if len(values) > limit else "")


def audit_pair(original: str, translated: str) -> list[dict]:
    """Return review hints for one pair of original and translated paragraphs."""
    original = original.strip()
    translated = translated.strip()
    issues = []

    def add(kind, message, level="warning"):
        issues.append({"type": kind, "level": level, "message": message})

    if not original:
        return issues
    if not translated:
        add("missing", "这一段没有译文。", "error")
        return issues

    orig, trans = _normalize(original), _normalize(translated)
    orig_formulas = Counter(FORMULA_RE.findall(orig))
    trans_formulas = Counter(FORMULA_RE.findall(trans))
    if orig_formulas != trans_formulas:
        changed = list((orig_formulas - trans_formulas) + (trans_formulas - orig_formulas))
        add("formula", f"公式标记可能不一致，请对照 PDF 核对 {_labels(changed)}。")

    orig_cites, trans_cites = _citations(orig), _citations(trans)
    if orig_cites != trans_cites:
        missing, extra = orig_cites - trans_cites, trans_cites - orig_cites
        changes = []
        if missing:
            changes.append("原文有 " + _labels(f"[{c}]" for c in sorted(missing)))
        if extra:
            changes.append("译文新增 " + _labels(f"[{c}]" for c in sorted(extra)))
        add("citation", "请核对引用编号，" + "，".join(changes) + "。")

    orig_numbers, orig_units = _data(orig)
    trans_numbers, trans_units = _data(trans)
    for kind, label, left, right in (
        ("number", "关键数值", orig_numbers, trans_numbers),
        ("unit", "数值和单位", orig_units, trans_units),
    ):
        missing = [value for key, value in left.items() if key not in right]
        if missing:
            added = [value for key, value in right.items() if key not in left]
            difference = f"原文 {_labels(missing)}"
            if added:
                difference += f"，译文出现 {_labels(added)}"
            add(kind, f"请核对{label}，{difference}。")

    words = _WORD_RE.findall(orig)
    if len(words) >= 8 and words == _WORD_RE.findall(trans):
        add("missing", "这一段与原文几乎相同，可能仍需翻译。")
    elif len(orig) >= 120 and len(trans) < max(10, len(orig) * .08):
        add("truncation", "这段译文明显偏短，建议核对是否有漏译。")
    return issues


def audit_document_segments(segments: dict) -> dict:
    page_results = {}
    counts = Counter()
    checked_segments = 0
    for page, entry in segments.items():
        page_issues = []
        for index, pair in enumerate(entry.get("pairs", [])):
            if not isinstance(pair, (list, tuple)) or not pair or not isinstance(pair[0], str):
                continue
            orig = pair[0]
            trans = pair[1] if len(pair) > 1 and isinstance(pair[1], str) else ""
            checked_segments += 1
            issues = audit_pair(orig, trans)
            if not issues:
                continue
            counts.update(issue["type"] for issue in issues)
            page_issues.append({
                "segment_index": index,
                "issues": issues,
                "original_snippet": orig[:100],
                "translated_snippet": trans[:100],
            })
        if page_issues:
            page_results[page] = page_issues
    return {
        "total_issues": sum(counts.values()),
        "checked_segments": checked_segments,
        "summary": dict(counts),
        "pages_with_issues": len(page_results),
        "details": page_results,
    }
