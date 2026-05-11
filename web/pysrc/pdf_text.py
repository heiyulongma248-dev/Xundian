"""PDF 文字层相关的纯 Python 逻辑（网页版）。

与桌面版的差异：抽 PDF 字层的工作已由 JS 端 pdf.js 完成（速度 10-100x 提升），
本模块只保留语言无关的"后处理"逻辑：
    - PageText 数据结构
    - 文字层质量评估 _judge_quality
    - 书内页码（页眉/页脚数字）识别 _resolve_book_pages

JS 端把 [{page: 1, text: "..."}, ...] 通过 finalize_raw_pages 喂进来，
回吐完整 PageText 列表（含 is_low_quality 与 book_page）。
"""
from __future__ import annotations

import asyncio
import io
import re
from collections import Counter
from dataclasses import dataclass, asdict
from typing import Any, Callable, List, Optional, Union


class ParsingCancelled(Exception):
    """pypdf 后备解析中点了取消时抛出。"""
    pass


@dataclass
class PageText:
    page: int                       # PDF 页码，1-based
    text: str
    book_page: Optional[int] = None  # 书内页码；提取失败为 None
    is_low_quality: bool = False     # 文字层质量差：极少字符或几乎无中文


# 扩大 CJK 范围：
#   U+3400-4DBF  CJK Unified Ideographs Extension A（生僻字）
#   U+4E00-9FFF  CJK Unified Ideographs（常用字）
#   U+F900-FAFF  CJK Compatibility Ideographs（兼容字，某些 PDF 字体用这块编码）
# 桌面版 pypdf 几乎只输出 U+4E00-9FFF；但 pdf.js 对部分 OCR'd PDF 会输出更多
# 兼容区字符，所以两边的 CJK 命中比例不一样。扩展后两边接近。
_CJK_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


def _judge_quality(text: str) -> bool:
    """启发式判 OCR 低质量页：去空白后 < 30 字、或中文字符占比 < 15%。

    阈值比桌面版（50 字 / 30%）放宽 —— pdf.js 抽出来的文字里
    会夹带较多 ASCII 控制字符 / 标点 / PUA 残留，但 CJK 实际仍可用。
    放宽后跟桌面版"几乎所有页都不算低质"的判定行为一致。
    """
    flat = re.sub(r"\s", "", text or "")
    if len(flat) < 30:
        return True
    cjk_count = len(_CJK_RE.findall(flat))
    if cjk_count / max(1, len(flat)) < 0.15:
        return True
    return False


# 日记本页眉：胡适日记全编(?)· 24 · 或 一九二八年 ·25 ·
_HEADER_PAGE_RE = re.compile(r"·\s*(\d{1,4})\s*·")
# 家书页尾：内容 ... 127
_FOOTER_PAGE_RE = re.compile(r"(?:^|\s)(\d{1,4})\s*$")


def _candidate_book_pages(text: str) -> List[int]:
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
            if 0 < diff < 100:
                diffs[diff] += 1

    if not diffs:
        return
    primary_offset = diffs.most_common(1)[0][0]

    for p, opts in zip(pages, per_page_options):
        best = None
        for c in opts:
            if p.page - c == primary_offset:
                best = c
                break
        if best is None and opts:
            inferred = p.page - primary_offset
            if inferred > 0:
                best = inferred
        elif best is None:
            inferred = p.page - primary_offset
            if inferred > 0:
                best = inferred
        p.book_page = best


# —— pypdf 后备路径：当 pdf.js 抽空时（OCR 扫描 PDF 用 Type 3 字体或不可见文字层）
#     退到 pypdf 在 Pyodide 里跑。慢但兼容性好。

async def extract_pdf_text_async(
    pdf_bytes: Union[bytes, bytearray, memoryview],
    on_progress=None,
    cancel_check: Optional[Callable[[], bool]] = None,
    progress_every: int = 10,
    yield_every: int = 25,
) -> List[PageText]:
    """pypdf 后备解析（Pyodide 主线程）。仅在 pdf.js 抽空时调用。
    每 yield_every 页 yield 一次让 JS 事件循环有机会跑取消按钮。"""
    # 延迟 import：未触发后备时不挂在主路径
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(bytes(pdf_bytes)))
    total = len(reader.pages)
    pages: List[PageText] = []
    for i, page in enumerate(reader.pages, start=1):
        if cancel_check is not None and cancel_check():
            raise ParsingCancelled(f"取消于第 {i}/{total} 页")
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        pages.append(
            PageText(page=i, text=text, is_low_quality=_judge_quality(text))
        )
        if on_progress is not None and (i % progress_every == 0 or i == total):
            try:
                on_progress(i, total)
            except Exception:
                pass
        if i % yield_every == 0 and i != total:
            await asyncio.sleep(0)
    _resolve_book_pages(pages)
    return pages


# —— 新版主入口：从 JS 端 pdf.js 抽出的 [{page, text}] → 完整 PageText 列表 ——

def finalize_raw_pages(raw_pages: Any) -> List[PageText]:
    """
    raw_pages: JS 端 pdf-extract.js 的 extractPdfPages() 输出，
               JsProxy/list 都接受。每项是 {page: int, text: str}。
    返回填好 is_low_quality + book_page 的 PageText 列表。
    """
    # 兼容 JsProxy
    if hasattr(raw_pages, "to_py"):
        raw_pages = raw_pages.to_py()
    pages: List[PageText] = []
    for item in (raw_pages or []):
        if hasattr(item, "to_py"):
            item = item.to_py()
        page_num = int(item.get("page") if isinstance(item, dict) else item["page"])
        text = (item.get("text") if isinstance(item, dict) else item["text"]) or ""
        pages.append(
            PageText(page=page_num, text=text, is_low_quality=_judge_quality(text))
        )
    pages.sort(key=lambda p: p.page)  # 保险：确保按 PDF 页码升序
    _resolve_book_pages(pages)
    return pages


# —— JSON 序列化辅助（缓存往 IndexedDB 写 / 读时用） ——

def page_to_dict(p: PageText) -> dict:
    return asdict(p)


def page_from_dict(d: dict) -> PageText:
    return PageText(
        page=int(d["page"]),
        text=d.get("text", "") or "",
        book_page=d.get("book_page"),
        is_low_quality=bool(d.get("is_low_quality", False)),
    )
