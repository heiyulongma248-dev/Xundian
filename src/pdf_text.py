"""PDF 逐页文本抽取，带 mtime+size 校验的缓存，以及书内页码提取。"""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, List, Optional

from pypdf import PdfReader


class ParsingCancelled(Exception):
    """用户在 GUI 中点了取消时抛出。调用方应当捕获并清理（不写部分缓存）。"""
    pass


@dataclass
class PageText:
    page: int  # PDF 页码，1-based
    text: str
    book_page: Optional[int] = None  # 书内页码；提取失败为 None
    is_low_quality: bool = False  # 文字层质量差：极少字符或几乎无中文


_CJK_RE = re.compile(r"[一-鿿]")


def _judge_quality(text: str) -> bool:
    """启发式判 OCR 低质量页：去空白后 < 50 字、或中文字符占比 < 30%。"""
    flat = re.sub(r"\s", "", text or "")
    if len(flat) < 50:
        return True
    cjk_count = len(_CJK_RE.findall(flat))
    if cjk_count / max(1, len(flat)) < 0.3:
        return True
    return False


# 日记本页眉：胡适日记全编(?)· 24 · 或 一九二八年 ·25 ·
_HEADER_PAGE_RE = re.compile(r"·\s*(\d{1,4})\s*·")
# 家书页尾：内容 ... 127
_FOOTER_PAGE_RE = re.compile(r"(?:^|\s)(\d{1,4})\s*$")


def _candidate_book_pages(text: str) -> List[int]:
    """同一页可能给出多个候选数字，由全书一致性二次校验决定取哪个。"""
    candidates: List[int] = []
    head = text[:200]
    m = _HEADER_PAGE_RE.search(head)
    if m:
        candidates.append(int(m.group(1)))
    tail = text.rstrip()[-80:] if text.strip() else ""
    m = _FOOTER_PAGE_RE.search(tail)
    if m:
        candidates.append(int(m.group(1)))
    return candidates


def _resolve_book_pages(pages: List[PageText]) -> None:
    """用全书最常见的 (pdf_page - book_page) 偏移去消歧/纠错。"""
    diffs: Counter = Counter()
    per_page_options: List[List[int]] = []
    for p in pages:
        opts = _candidate_book_pages(p.text)
        per_page_options.append(opts)
        for c in opts:
            diff = p.page - c
            if 0 < diff < 100:  # 合理范围：卷首通常 < 100 页
                diffs[diff] += 1

    if not diffs:
        return
    # 取出现频率最高的偏移作为主偏移
    primary_offset = diffs.most_common(1)[0][0]

    for p, opts in zip(pages, per_page_options):
        # 对每个候选，看哪个与主偏移最一致
        best = None
        for c in opts:
            if p.page - c == primary_offset:
                best = c
                break
        if best is None and opts:
            # 没有与主偏移完全一致的：用主偏移直接推算（兜底）
            inferred = p.page - primary_offset
            if inferred > 0:
                best = inferred
        elif best is None:
            inferred = p.page - primary_offset
            if inferred > 0:
                best = inferred
        p.book_page = best


# 缓存格式版本 — 字段或抽取逻辑变化时手动 +1，让旧缓存自动失效
_CACHE_VERSION = 2


def _signature(pdf_path: Path) -> dict:
    st = pdf_path.stat()
    return {
        "name": pdf_path.name,
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "version": _CACHE_VERSION,
    }


def extract_pdf_text(
    pdf_path: Path,
    cache_dir: Path,
    use_cache: bool = True,
    on_progress=None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> List[PageText]:
    """
    on_progress: 可选回调 (current_page, total_pages) -> None；每 10 页调一次。
    cancel_check: 可选的取消探询函数 () -> bool；返回 True 时立即抛 ParsingCancelled，
                  调用方负责清理（本函数不写部分缓存）。
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / (pdf_path.stem + ".jsonl")
    sig_file = cache_dir / (pdf_path.stem + ".sig.json")

    sig = _signature(pdf_path)
    if use_cache and cache_file.exists() and sig_file.exists():
        try:
            cached_sig = json.loads(sig_file.read_text(encoding="utf-8"))
            if cached_sig == sig:
                pages = []
                with cache_file.open("r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            d = json.loads(line)
                            pages.append(PageText(**d))
                return pages
        except (json.JSONDecodeError, OSError, TypeError):
            pass

    reader = PdfReader(str(pdf_path))
    total = len(reader.pages)
    pages: List[PageText] = []
    for i, page in enumerate(reader.pages, start=1):
        # 每页前查一次取消标志：响应延迟 = 单页处理时间（< 100 ms）
        if cancel_check is not None and cancel_check():
            raise ParsingCancelled(f"取消于第 {i}/{total} 页")
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        pages.append(
            PageText(page=i, text=text, is_low_quality=_judge_quality(text))
        )
        if on_progress is not None and (i % 10 == 0 or i == total):
            try:
                on_progress(i, total)
            except Exception:
                pass

    _resolve_book_pages(pages)

    with cache_file.open("w", encoding="utf-8") as f:
        for p in pages:
            f.write(json.dumps(asdict(p), ensure_ascii=False) + "\n")
    sig_file.write_text(json.dumps(sig, ensure_ascii=False), encoding="utf-8")
    return pages


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    pdf = Path(sys.argv[1])
    pages = extract_pdf_text(pdf, Path("cache"))
    non_empty = sum(1 for p in pages if p.text.strip())
    with_page = sum(1 for p in pages if p.book_page is not None)
    print(f"{pdf.name}: {len(pages)} pages, {non_empty} with text layer, {with_page} with book page")
    for i in [10, 30, 50, 100, 150, 200]:
        if i < len(pages):
            print(f"  pdf p{pages[i].page} -> book p{pages[i].book_page}")
