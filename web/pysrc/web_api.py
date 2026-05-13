"""寻典网页版 — Python 侧 API（Pyodide 内运行）。

设计要点：
- 这个 Api 不直接管文件、也不直接读写 IndexedDB。所有持久化都是 JS 端的事。
- JS 调每个方法时把需要的数据（PDF bytes、docx bytes、书目缓存）作为参数传入；
  Python 算完后返回纯字典/列表，JS 端通过 `.toJs({dict_converter: Object.fromEntries})`
  转换为 JS 普通对象。
- 仅缓存"最近一次扫描的内部对象"以支撑「导出核对表 docx」时不需要再扫一遍。
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from .extract_quotes import extract_quotes, Quote
from .pdf_text import (
    PageText,
    ParsingCancelled,
    finalize_raw_pages,
    extract_pdf_text_async,
    page_from_dict,
)
from .matcher import match_quote, precompute_books, MatchCandidate, MatchResult
from .citation import format_citation
from .render_report import render_report_bytes


# —— JS 通信辅助 ——

def _emit(kind: str, **payload):
    """向 JS 端推一条进度事件。前端注册 window.onPyEvent(kind, payload) 接收。"""
    try:
        import js
        from pyodide.ffi import to_js
        from js import Object

        js.window.onPyEvent(
            kind, to_js(payload, dict_converter=Object.fromEntries)
        )
    except Exception:
        # 测试环境下没有 js 模块，静默
        pass


def _to_py(value: Any) -> Any:
    """把 JS 端传进来的 PyProxy/JsProxy 递归转成纯 Python 类型。
    Pyodide 在函数调用时不深度转换 dict/list，必要时调用方需手动 to_py。"""
    try:
        # JsProxy 有 to_py
        if hasattr(value, "to_py"):
            return value.to_py()
    except Exception:
        pass
    return value


def _restore_books_pages(books_data: Any) -> Dict[str, List[PageText]]:
    """{file_id: [page_dict, ...]} → {file_id: [PageText, ...]}。"""
    books_data = _to_py(books_data) or {}
    out: Dict[str, List[PageText]] = {}
    for file_id, pages_list in books_data.items():
        pages_list = _to_py(pages_list) or []
        out[file_id] = [page_from_dict(_to_py(p)) for p in pages_list]
    return out


# —— 序列化 ——

def _candidate_to_dict(cand: MatchCandidate) -> dict:
    return {
        "book_file": cand.book_file,
        "pdf_page": cand.pdf_page,
        "book_page": cand.book_page,
        "pdf_page_end": cand.pdf_page_end,
        "book_page_end": cand.book_page_end,
        "is_cross_page": cand.is_cross_page,
        "score": round(cand.score, 4),
        "ctx_score": round(cand.ctx_score, 4),
        "final_score": round(cand.final_score, 4),
        "snippet": cand.snippet,
        "snippet_before": cand.snippet_before,
        "snippet_after": cand.snippet_after,
    }


def _format_cand_citation(cand: MatchCandidate, meta_dict: Optional[Dict[str, dict]]) -> str:
    """根据候选所在书的 meta 拼一条「出处建议」给前端候选卡片用。
    meta_dict 缺失时返回空串（前端按"没有 citation"渲染）。"""
    if meta_dict is None:
        return ""
    m = meta_dict.get(cand.book_file) or {}
    return format_citation(
        author=m.get("author", "XX"),
        title=m.get("title", cand.book_file),
        doc_type=m.get("doc_type", "M"),
        place=m.get("place", "XX"),
        publisher=m.get("publisher", "XX出版社"),
        year=m.get("year", "0000"),
        book_page=cand.book_page,
        pdf_page=cand.pdf_page,
    )


def _quote_result_to_dict(
    quote: Quote,
    result: MatchResult,
    citation: str,
    threshold: float,
    meta_dict: Optional[Dict[str, dict]] = None,
) -> dict:
    if not result.candidates:
        status = "miss"
    elif result.best.score >= max(threshold, 0.95):
        status = "hit"
    elif result.best.score >= threshold:
        status = "low"
    else:
        status = "miss"
    cand_dicts = []
    for c in result.candidates:
        d = _candidate_to_dict(c)
        d["citation"] = _format_cand_citation(c, meta_dict)
        cand_dicts.append(d)
    return {
        "quote_id": quote.quote_id,
        "text": quote.text,
        "context_before": quote.context_before,
        "context_after": quote.context_after,
        "status": status,
        "citation": citation,
        "candidates": cand_dicts,
    }


DEFAULT_SETTINGS = {
    "threshold": 0.85,
    "ctx_weight": 0.1,
    "top_k": 3,
}


class Api:
    """Pyodide 内的单例。整个会话只存在一个实例。"""

    def __init__(self):
        self.settings: dict = dict(DEFAULT_SETTINGS)
        self._cancel_flag: bool = False
        # 最近一次扫描的内部状态（供 export 用）
        self._last_scan: Optional[dict] = None

    # —— 设置 ——

    def set_settings(self, settings):
        """JS 启动时把 IndexedDB 里读到的 settings 同步给 Python。"""
        s = _to_py(settings) or {}
        merged = {**DEFAULT_SETTINGS, **s}
        # 类型矫正
        merged["threshold"] = float(merged.get("threshold", 0.85))
        merged["ctx_weight"] = float(merged.get("ctx_weight", 0.1))
        merged["top_k"] = int(merged.get("top_k", 3))
        self.settings = merged
        return dict(self.settings)

    def get_settings(self):
        return dict(self.settings)

    # —— docx 抽引文 ——

    def extract_quotes_from_bytes(self, docx_bytes):
        """JS 端传 Uint8Array；返回引文列表（字典）"""
        data = bytes(docx_bytes)
        quotes = extract_quotes(data)
        return [self._quote_to_dict(q) for q in quotes]

    @staticmethod
    def _quote_to_dict(q: Quote) -> dict:
        return {
            "quote_id": q.quote_id,
            "text": q.text,
            "paragraph_index": q.paragraph_index,
            "paragraph_text": q.paragraph_text,
            "char_start": q.char_start,
            "char_end": q.char_end,
            "context_before": q.context_before,
            "context_after": q.context_after,
        }

    # —— PDF 抽文字"后处理" ——
    # 网页版的 PDF 抽文字已经在 JS 端（pdf.js）做完，比 Pyodide pypdf 快 10-100 倍。
    # 这里只做语言无关的后处理：is_low_quality 标记 + 书内页码识别。
    # 输入是 JS 端传来的 [{page: 1, text: "..."}, ...]，输出是完整的 page 字典列表。

    def finalize_pages(self, raw_pages):
        pages = finalize_raw_pages(raw_pages)
        low_q = sum(1 for p in pages if p.is_low_quality)
        return {
            "pages": [asdict(p) for p in pages],
            "page_count": len(pages),
            "low_quality_pages": low_q,
        }

    # —— pypdf 后备：pdf.js 抽空时（OCR 扫描 PDF）改用这条路径 ——
    async def extract_with_pypdf(self, pdf_bytes, file_id: str):
        """完整的 pypdf 抽文字流程；带进度推送 + 取消支持。
        返回的 pages 已经填好 is_low_quality 与 book_page，JS 端可直接缓存。"""
        self._cancel_flag = False

        def _cancel():
            return self._cancel_flag

        def _on_page(cur, total):
            _emit("book_progress", file_id=file_id, current=cur, total=total)

        try:
            pages = await extract_pdf_text_async(
                bytes(pdf_bytes),
                on_progress=_on_page,
                cancel_check=_cancel,
            )
        except ParsingCancelled:
            raise
        low_q = sum(1 for p in pages if p.is_low_quality)
        return {
            "pages": [asdict(p) for p in pages],
            "page_count": len(pages),
            "low_quality_pages": low_q,
            "fallback": "pypdf",
        }

    def cancel_parsing(self):
        """JS 端点取消按钮时调；pypdf 后备路径里 Python 会读这个标志。"""
        self._cancel_flag = True
        return {"cancelled": True}

    # —— 文档扫描（流式） ——

    async def scan_document(self, docx_bytes, books_data, books_meta, docx_name: str = ""):
        """
        docx_bytes: Uint8Array
        books_data: {file_id: [page_dict, ...]} — 已经解析过的书目（JS 从 IndexedDB 取出）
        books_meta: {file_id: {author, title, doc_type, place, publisher, year}}
        docx_name: 仅用于事件显示
        """
        _emit("scan_start", docx=docx_name or "document.docx")

        # 阶段 0：抽引文
        quotes = extract_quotes(bytes(docx_bytes))
        _emit("scan_total", total=len(quotes))

        if not quotes:
            _emit("scan_done", total=0, hits=0, lows=0, miss=0)
            return {"quotes": [], "books_summary": []}

        # 阶段 1：恢复 PageText 对象 + 预归一化
        _emit("scan_phase", phase="loading_books")
        books_pages = _restore_books_pages(books_data)
        # 让 JS 事件循环喘口气，更新 "loading_books" 文案
        await asyncio.sleep(0)

        _emit("scan_phase", phase="precomputing")
        # 自己做预归一化（替代一次性的 precompute_books），按本书让出事件循环，
        # 避免大书架（10+ 本，每本几百页）一气跑完把 UI 冻 5-6 秒
        from .matcher import normalize as _normalize
        precomputed = {}
        for _fid, _pgs in books_pages.items():
            _norm_texts = [_normalize(p.text) for p in _pgs]
            _lens = [len(t) for t in _norm_texts]
            _offsets = [0]
            for _ln in _lens:
                _offsets.append(_offsets[-1] + _ln)
            precomputed[_fid] = {
                "book_norm": "".join(_norm_texts),
                "page_norm_lens": _lens,
                "page_offsets": _offsets,
                "page_norm_texts": _norm_texts,
            }
            await asyncio.sleep(0)  # 每本书让一次

        threshold = float(self.settings["threshold"])
        ctx_weight = float(self.settings["ctx_weight"])
        top_k = int(self.settings["top_k"])

        meta_dict = _to_py(books_meta) or {}
        # JS Map → Python dict 后内部可能仍是 JsProxy
        meta_dict_clean: Dict[str, dict] = {}
        for k, v in meta_dict.items():
            meta_dict_clean[k] = _to_py(v) or {}

        results = []
        matches_for_export: List[MatchResult] = []
        citations_for_export: List[str] = []
        quotes_for_export: List[Quote] = []
        hits = lows = miss = 0

        for idx, q in enumerate(quotes, start=1):
            mr = match_quote(
                q.text,
                books_pages,
                threshold=threshold,
                top_k=top_k,
                docx_before=q.context_before,
                docx_after=q.context_after,
                ctx_weight=ctx_weight,
                precomputed=precomputed,
            )
            matches_for_export.append(mr)
            quotes_for_export.append(q)

            if mr.best is None:
                citation = "待人工确认"
            else:
                meta = meta_dict_clean.get(mr.best.book_file, {})
                citation = format_citation(
                    author=meta.get("author", "XX"),
                    title=meta.get("title", mr.best.book_file),
                    doc_type=meta.get("doc_type", "M"),
                    place=meta.get("place", "XX"),
                    publisher=meta.get("publisher", "XX出版社"),
                    year=meta.get("year", "0000"),
                    book_page=mr.best.book_page,
                    pdf_page=mr.best.pdf_page,
                )
            citations_for_export.append(citation)

            result_dict = _quote_result_to_dict(q, mr, citation, threshold, meta_dict_clean)
            results.append(result_dict)

            if result_dict["status"] == "hit":
                hits += 1
            elif result_dict["status"] == "low":
                lows += 1
            else:
                miss += 1

            _emit(
                "scan_match",
                current=idx,
                total=len(quotes),
                hits=hits,
                lows=lows,
                miss=miss,
                result=result_dict,
            )
            # 每条引文都让出一次事件循环 —— 让 UI 可滚 / 可切 tab；
            # 单条匹配本身仍是同步的（50-200 ms 卡顿），但不会出现长时间整体冻结
            await asyncio.sleep(0)

        books_summary = []
        for fid, pages in books_pages.items():
            n = len(pages)
            lq = sum(1 for p in pages if p.is_low_quality)
            books_summary.append({
                "file_id": fid,
                "page_count": n,
                "low_quality_pages": lq,
            })

        # 缓存最后一次扫描的内部对象，供 export_report 用
        self._last_scan = {
            "quotes": quotes_for_export,
            "matches": matches_for_export,
            "citations": citations_for_export,
            "books_pages": books_pages,
            "meta_dict": meta_dict_clean,
            "threshold": threshold,
        }

        _emit("scan_done", total=len(quotes), hits=hits, lows=lows, miss=miss)
        return {"quotes": results, "books_summary": books_summary}

    # —— 单句查询 ——

    def lookup_quote(self, quote: str, context_before: str, context_after: str,
                     books_data, books_meta):
        if not quote or not str(quote).strip():
            raise ValueError("引文不能为空")
        text = str(quote).strip()

        books_pages = _restore_books_pages(books_data)
        meta_dict = _to_py(books_meta) or {}
        meta_dict_clean: Dict[str, dict] = {}
        for k, v in meta_dict.items():
            meta_dict_clean[k] = _to_py(v) or {}

        threshold = float(self.settings["threshold"])
        ctx_weight = float(self.settings["ctx_weight"])
        # 单句查询场景下，用户希望看到尽量多的候选 —— 绕开扫描用的 top_k 设置，
        # 固定最多 10 条；并允许同一本书出现多次（搜"你"这种高频字时尤其需要）。
        LOOKUP_TOP_K = 10
        LOOKUP_PER_BOOK_CAP = 10

        mr = match_quote(
            text,
            books_pages,
            threshold=threshold,
            top_k=LOOKUP_TOP_K,
            docx_before=context_before or "",
            docx_after=context_after or "",
            ctx_weight=ctx_weight,
            per_book_cap=LOOKUP_PER_BOOK_CAP,
        )

        if mr.best is None:
            citation = "待人工确认"
        else:
            meta = meta_dict_clean.get(mr.best.book_file, {})
            citation = format_citation(
                author=meta.get("author", "XX"),
                title=meta.get("title", mr.best.book_file),
                doc_type=meta.get("doc_type", "M"),
                place=meta.get("place", "XX"),
                publisher=meta.get("publisher", "XX出版社"),
                year=meta.get("year", "0000"),
                book_page=mr.best.book_page,
                pdf_page=mr.best.pdf_page,
            )

        # 构造一个"伪 Quote"，让 _quote_result_to_dict 复用即可
        fake = Quote(
            quote_id=0,
            text=text,
            paragraph_index=0,
            paragraph_text=text,
            char_start=0,
            char_end=len(text),
        )
        return {"quote": _quote_result_to_dict(fake, mr, citation, threshold, meta_dict_clean)}

    # —— 导出核对表 ——

    def export_report_bytes(self):
        if self._last_scan is None:
            raise RuntimeError("还没扫描过任何文档；请先在「文档扫描」中扫描一次。")
        s = self._last_scan
        data = render_report_bytes(
            quotes=s["quotes"],
            matches=s["matches"],
            citations=s["citations"],
            book_meta=s["meta_dict"],
            threshold=s["threshold"],
            books_pages=s["books_pages"],
        )
        return data


# 模块加载时自动建实例，JS 端通过 py.api 直接访问
api = Api()
