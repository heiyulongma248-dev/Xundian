"""引文 → 书页定位：归一化 + 直接子串 + 滑窗模糊匹配 + 语境消歧。

归一化阶段做四件事：
1. 全角字母数字 → 半角
2. 简繁统一为简体（opencc 可用时）；不可用时退到内置最小映射表
3. 常见 OCR 形近字宽容（小型固定表，避免引入误命中）
4. 去掉所有空白与中英文标点
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import List, Optional, Tuple

from .pdf_text import PageText


# ---------- 归一化 ----------

_STRIP_RE = re.compile(
    r"[\s"
    r"，。、；：！？“”‘’'\"《》〈〉「」『』（）()【】\[\]\.\,\;\:\!\?"
    r"…·—\-_／/]+"
)

# opencc 装好就用；装不上落回这张最小映射（仅常见胡适语料里出现的繁体字）
try:
    from opencc import OpenCC

    _OPENCC = OpenCC("t2s")

    def _to_simplified(s: str) -> str:
        return _OPENCC.convert(s)

except Exception:  # pragma: no cover
    _T2S_FALLBACK = str.maketrans({
        "適": "适", "記": "记", "編": "编", "繁": "繁", "體": "体",
        "國": "国", "經": "经", "個": "个", "這": "这", "為": "为",
        "熱": "热", "夢": "梦", "顯": "显", "華": "华", "舊": "旧",
        "豐": "丰", "話": "话", "說": "说", "樣": "样", "誰": "谁",
        "醫": "医", "處": "处", "歲": "岁", "雖": "虽", "聲": "声",
        "頭": "头", "備": "备", "麼": "么", "問": "问", "讀": "读",
    })

    def _to_simplified(s: str) -> str:
        return s.translate(_T2S_FALLBACK)


# 形近 OCR 错字白名单：仅纳入风险低、收益高的几对。
# 规则：把所有变体统一成"右值"（标准字）。任何一对引入前都要确保两个字的"语义碰撞"
# 不会造成误匹配（比如"己/已"这种有歧义的就不能加）。
_OCR_LOOKALIKE = str.maketrans({
    # 数字 / 字母
    "Ｏ": "0", "○": "0", "〇": "0",
    "ｌ": "1", "Ｉ": "1",
    # 易花的标点形近（不是所有字都该归并；这里只做绝对安全的）
    # 暂留空，后续观察实际错例再扩
})


def normalize(text: str) -> str:
    if not text:
        return ""
    # 1. 全角 → 半角
    out = []
    for ch in text:
        code = ord(ch)
        if 0xFF10 <= code <= 0xFF19 or 0xFF21 <= code <= 0xFF5A:
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    s = "".join(out)
    # 2. 简繁统一
    s = _to_simplified(s)
    # 3. OCR 形近字归并
    s = s.translate(_OCR_LOOKALIKE)
    # 4. 去标点空白
    return _STRIP_RE.sub("", s)


@dataclass
class MatchCandidate:
    book_file: str
    pdf_page: int                # 命中起始 PDF 页（跨页时为起页）
    book_page: Optional[int]     # 命中起始书内页码
    score: float                 # 主匹配分（路径 A=1.0；路径 B=滑窗 ratio）
    snippet: str                 # 命中页中接近引文的一段原文
    snippet_before: str = ""     # 引文之前的片段，用于语境消歧
    snippet_after: str = ""      # 引文之后的片段
    ctx_score: float = 0.0       # 语境相似度（0~1）
    final_score: float = 0.0     # score + ctx_weight * ctx_score，排序键
    pdf_page_end: Optional[int] = None     # 跨页命中时的结束 PDF 页（含）
    book_page_end: Optional[int] = None    # 跨页命中时的结束书内页码

    @property
    def is_cross_page(self) -> bool:
        return self.pdf_page_end is not None and self.pdf_page_end != self.pdf_page


@dataclass
class MatchResult:
    quote_text: str
    candidates: List[MatchCandidate]  # 已按 final_score 降序排列

    @property
    def best(self) -> Optional[MatchCandidate]:
        return self.candidates[0] if self.candidates else None


# ---------- 滑窗与片段抽取 ----------

def _best_window_ratio(needle_norm: str, hay_norm: str) -> float:
    n = len(needle_norm)
    h = len(hay_norm)
    if n == 0 or h == 0:
        return 0.0
    if n >= h:
        return SequenceMatcher(None, needle_norm, hay_norm).ratio()
    step = max(1, n // 2)
    best = 0.0
    matcher = SequenceMatcher(None, needle_norm, "")
    matcher.set_seq1(needle_norm)
    for i in range(0, h - n + 1, step):
        matcher.set_seq2(hay_norm[i : i + n])
        r = matcher.ratio()
        if r > best:
            best = r
            if best == 1.0:
                break
    return best


def _locate_in_raw(text: str, needle: str) -> int:
    """在原始（未归一化）文本里近似定位 needle 起点；找不到返回 -1。"""
    if not text or not needle:
        return -1
    idx = text.find(needle)
    if idx != -1:
        return idx
    # 退化策略：在去空白文本里找，再把偏移映射回原 text
    flat = re.sub(r"\s", "", text)
    idx = flat.find(needle)
    if idx == -1:
        return -1
    seen = 0
    for raw_idx, ch in enumerate(text):
        if re.match(r"\s", ch):
            continue
        if seen == idx:
            return raw_idx
        seen += 1
    return -1


def _snippet_split(
    text: str, needle: str, span: int = 40
) -> Tuple[str, str, str]:
    """返回 (full_snippet, before, after) —— before/after 用于语境打分。"""
    if not text:
        return "", "", ""
    idx = _locate_in_raw(text, needle)
    if idx == -1:
        return text[: span * 2].replace("\n", " ").strip(), "", ""
    start = max(0, idx - span)
    end = min(len(text), idx + len(needle) + span)
    full = text[start:end].replace("\n", " ").strip()
    before = text[start:idx].replace("\n", " ")
    after = text[idx + len(needle): end].replace("\n", " ")
    return full, before, after


# ---------- 语境分 ----------

def _ctx_score(
    docx_before_norm: str,
    docx_after_norm: str,
    cand_before_raw: str,
    cand_after_raw: str,
) -> float:
    """对 before/after 各算一次相似度，取均值。两边任一为空时按 0 处理。"""
    cand_b = normalize(cand_before_raw)
    cand_a = normalize(cand_after_raw)

    def _r(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        return SequenceMatcher(None, a, b).ratio()

    return (_r(docx_before_norm, cand_b) + _r(docx_after_norm, cand_a)) / 2


# ---------- 主入口 ----------

def precompute_books(books_pages: dict[str, List[PageText]]) -> dict:
    """
    在批量扫描前对每本书的归一化结果做一次缓存，避免每条引文都重复 normalize 整本书。
    返回 {file_id: {"book_norm": str, "page_norm_lens": [int], "page_offsets": [int],
                     "page_norm_texts": [str]}}
    """
    out = {}
    for file_id, pages in books_pages.items():
        norm_texts = [normalize(p.text) for p in pages]
        lens = [len(t) for t in norm_texts]
        offsets = [0]
        for ln in lens:
            offsets.append(offsets[-1] + ln)
        out[file_id] = {
            "book_norm": "".join(norm_texts),
            "page_norm_lens": lens,
            "page_offsets": offsets,
            "page_norm_texts": norm_texts,
        }
    return out


def match_quote(
    quote: str,
    books_pages: dict[str, List[PageText]],
    threshold: float = 0.85,
    top_k: int = 3,
    docx_before: str = "",
    docx_after: str = "",
    ctx_weight: float = 0.1,
    precomputed: dict | None = None,
) -> MatchResult:
    """
    返回每本书最多一个候选（同书多次出现时取语境分最高的那次），
    跨书按 final_score = score + ctx_weight * ctx_score 排序，截 top_k。

    precomputed: 可选的预计算缓存（来自 precompute_books），批量扫描时大幅加速。
    """
    needle_norm = normalize(quote)
    if not needle_norm:
        return MatchResult(quote_text=quote, candidates=[])

    docx_before_norm = normalize(docx_before)
    docx_after_norm = normalize(docx_after)

    candidates: List[MatchCandidate] = []

    for book_file, pages in books_pages.items():
        # ---- 路径 A：整书子串，可能多次出现，全部纳入 ----
        if precomputed and book_file in precomputed:
            pc = precomputed[book_file]
            book_norm = pc["book_norm"]
            page_offsets = pc["page_offsets"]
            page_norm_texts = pc["page_norm_texts"]
        else:
            page_norm_texts = [normalize(p.text) for p in pages]
            page_norm_lens = [len(t) for t in page_norm_texts]
            page_offsets = [0]
            for ln in page_norm_lens:
                page_offsets.append(page_offsets[-1] + ln)
            book_norm = "".join(page_norm_texts)

        def _locate_page(pos_in_book: int):
            """返回 (page_index, page_obj)；二分定位偏移所在页。"""
            lo, hi = 0, len(pages) - 1
            while lo < hi:
                mid = (lo + hi) // 2
                if page_offsets[mid + 1] <= pos_in_book:
                    lo = mid + 1
                else:
                    hi = mid
            return lo, pages[lo]

        if needle_norm in book_norm:
            book_cands: List[MatchCandidate] = []
            n_len = len(needle_norm)

            start = 0
            while True:
                pos = book_norm.find(needle_norm, start)
                if pos == -1:
                    break

                # 用首字、末字位置分别定位起页 / 终页（跨页支持）
                start_idx, start_page = _locate_page(pos)
                end_idx, end_page = _locate_page(pos + n_len - 1)

                # 取"中点"所在页作为代表页（命中字符多的那页）
                mid_idx, mid_page = _locate_page(pos + n_len // 2)

                full, b, a = _snippet_split(mid_page.text, quote)
                cs = _ctx_score(docx_before_norm, docx_after_norm, b, a)

                cross = end_idx != start_idx
                book_cands.append(
                    MatchCandidate(
                        book_file=book_file,
                        pdf_page=start_page.page,
                        book_page=start_page.book_page,
                        score=1.0,
                        snippet=full,
                        snippet_before=b.strip(),
                        snippet_after=a.strip(),
                        ctx_score=cs,
                        final_score=1.0 + ctx_weight * cs,
                        pdf_page_end=end_page.page if cross else None,
                        book_page_end=end_page.book_page if cross else None,
                    )
                )
                start = pos + 1

            if book_cands:
                book_cands.sort(key=lambda c: c.final_score, reverse=True)
                candidates.append(book_cands[0])
            continue

        # ---- 路径 B：逐页滑窗模糊匹配 ----
        page_best = None
        page_best_score = 0.0
        for p, n_text in zip(pages, page_norm_texts):
            if not n_text:
                continue
            r = _best_window_ratio(needle_norm, n_text)
            if r > page_best_score:
                page_best_score = r
                page_best = p
        if page_best is not None and page_best_score >= threshold:
            full, b, a = _snippet_split(page_best.text, quote)
            cs = _ctx_score(docx_before_norm, docx_after_norm, b, a)
            candidates.append(
                MatchCandidate(
                    book_file=book_file,
                    pdf_page=page_best.page,
                    book_page=page_best.book_page,
                    score=page_best_score,
                    snippet=full,
                    snippet_before=b.strip(),
                    snippet_after=a.strip(),
                    ctx_score=cs,
                    final_score=page_best_score + ctx_weight * cs,
                )
            )

    candidates.sort(key=lambda c: c.final_score, reverse=True)
    return MatchResult(quote_text=quote, candidates=candidates[:top_k])
