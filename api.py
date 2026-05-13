"""寻典 — pywebview 暴露给前端的 Python API。

约定：所有方法的入参/出参都必须是可 JSON 序列化的基本类型（dict/list/str/int/bool）。
所有抛错都被捕获后封装成 {"ok": False, "error": "..."} 返回，避免 JS 端 unhandled。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import traceback
import webbrowser
from dataclasses import asdict
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import webview

from src.extract_quotes import extract_quotes
from src.pdf_text import extract_pdf_text, ParsingCancelled
from src.matcher import match_quote, precompute_books
from src.citation import format_citation
from src.render_report import render_report
from src.library import Library, load_settings, save_settings


def _safe(fn):
    """统一异常包装：成功返回原值，异常返回 {ok:False, error:...}。"""
    def wrapped(self, *args, **kwargs):
        try:
            result = fn(self, *args, **kwargs)
            if isinstance(result, dict) and "ok" not in result:
                result = {"ok": True, **result}
            elif not isinstance(result, dict):
                result = {"ok": True, "data": result}
            return result
        except Exception as e:
            traceback.print_exc()
            return {"ok": False, "error": str(e), "type": type(e).__name__}
    wrapped.__name__ = fn.__name__
    return wrapped


def _candidate_to_dict(cand) -> dict:
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


def _format_cand_citation(cand, meta_lookup) -> str:
    """根据候选所在书的 meta 给前端候选卡片拼一条"出处建议"。
    meta_lookup 是一个 callable: file_id → dict（找不到时返回空 dict）。"""
    if meta_lookup is None:
        return ""
    m = meta_lookup(cand.book_file) or {}
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


def _quote_result_to_dict(quote, result, citation: str, threshold: float, meta_lookup=None) -> dict:
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
        d["citation"] = _format_cand_citation(c, meta_lookup)
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


class Api:
    def __init__(self):
        self.lib = Library()
        self.settings = load_settings()
        self._window: Optional[webview.Window] = None
        # 缓存最近一次扫描结果，便于导出报告
        self._last_scan = None  # (quotes, matches, citations, books_pages)
        # 取消标志：批量解析时由前端 cancel_parsing 触发
        self._cancel_event: Optional[threading.Event] = None

    def set_window(self, window: webview.Window) -> None:
        self._window = window

    # —— 进度推送 ——
    def _emit_progress(self, kind: str, **payload) -> None:
        """向前端推一条事件（前端要有 window.onPyEvent(kind, payload)）。"""
        if self._window is None:
            return
        try:
            import json as _json
            js = (
                f"window.onPyEvent && window.onPyEvent("
                f"{_json.dumps(kind)}, {_json.dumps(payload, ensure_ascii=False)})"
            )
            self._window.evaluate_js(js)
        except Exception:
            pass

    # —— 设置 ——
    @_safe
    def get_settings(self):
        return {"settings": dict(self.settings)}

    @_safe
    def update_settings(self, patch: dict):
        self.settings = save_settings(patch or {})
        return {"settings": dict(self.settings)}

    # —— 文件选择 ——
    @_safe
    def pick_pdf_file(self):
        if self._window is None:
            return {"path": None}
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("PDF 文件 (*.pdf)",),
        )
        if not result:
            return {"path": None}
        return {"path": result[0]}

    @_safe
    def pick_pdf_files(self):
        """多选版本：返回选中的所有 PDF 路径列表。"""
        if self._window is None:
            return {"paths": []}
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=("PDF 文件 (*.pdf)",),
        )
        if not result:
            return {"paths": []}
        return {"paths": list(result)}

    @_safe
    def add_book_quick(self, pdf_path: str):
        """快速登记：用占位元数据加入书架，不弹表单。供批量导入用。"""
        try:
            b = self.lib.add_book(pdf_path, {})
            return {"ok": True, "book": asdict(b), "skipped": False}
        except ValueError as e:
            # 同名书已存在等
            return {"ok": True, "skipped": True, "reason": str(e)}

    @_safe
    def pick_docx_file(self):
        if self._window is None:
            return {"path": None}
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Word 文档 (*.docx)",),
        )
        if not result:
            return {"path": None}
        return {"path": result[0]}

    @_safe
    def pick_save_path(self, default_name: str = "引文核对表.docx"):
        if self._window is None:
            return {"path": None}
        result = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=default_name,
            file_types=("Word 文档 (*.docx)",),
        )
        if not result:
            return {"path": None}
        return {"path": result if isinstance(result, str) else result[0]}

    # —— 书架 ——
    @_safe
    def list_books(self):
        return {"books": [asdict(b) for b in self.lib.list_books()]}

    @_safe
    def add_book(self, pdf_path: str, meta: Optional[dict] = None):
        b = self.lib.add_book(pdf_path, meta or {})
        return {"book": asdict(b)}

    @_safe
    def update_book(self, file_id: str, meta: dict):
        b = self.lib.update_book(file_id, meta or {})
        return {"book": asdict(b)}

    @_safe
    def remove_book(self, file_id: str):
        ok = self.lib.remove_book(file_id)
        return {"removed": ok}

    # —— 文件夹管理 ——
    @_safe
    def list_folders(self):
        """返回 [{name, count}, ...] + 一个 ungrouped 字段。"""
        names = self.lib.list_folder_names()
        counts = self.lib.folder_counts()
        folders = [{"name": n, "count": counts.get(n, 0)} for n in names]
        ungrouped = counts.get(None, 0)
        return {"folders": folders, "ungrouped": ungrouped}

    @_safe
    def create_folder(self, name: str):
        n = self.lib.create_folder(name)
        return {"name": n}

    @_safe
    def rename_folder(self, old_name: str, new_name: str):
        n = self.lib.rename_folder(old_name, new_name)
        return {"name": n}

    @_safe
    def delete_folder(self, name: str):
        affected = self.lib.delete_folder(name)
        return {"affected": affected}

    @_safe
    def update_book_folders(self, file_ids: list, folder: Optional[str]):
        """批量把若干本书移到指定文件夹。folder=None 即移出（变未分组）。"""
        affected = self.lib.update_book_folders(file_ids or [], folder)
        return {"affected": affected}

    def _clear_one_book_cache(self, file_id: str) -> None:
        stem = Path(file_id).stem
        for suffix in (".jsonl", ".sig.json"):
            f = self.lib.cache_dir / (stem + suffix)
            if f.exists():
                try:
                    f.unlink()
                except OSError:
                    pass

    @_safe
    def clear_book_caches(self, file_ids: list):
        """删除指定书的解析缓存（不动 PDF 原文件、不动 books.json）。"""
        cleared = 0
        for fid in (file_ids or []):
            self._clear_one_book_cache(fid)
            cleared += 1
        return {"cleared": cleared}

    @_safe
    def reparse_book(self, file_id: str):
        """删除某本书的缓存后重新解析。用于缓存损坏或抽取逻辑升级时。"""
        b = self.lib.get_book(file_id)
        if b is None:
            raise KeyError(f"未在书架中找到：{file_id}")
        self._clear_one_book_cache(file_id)
        return self.parse_book(file_id)

    # —— 批量解析 + 可取消 ——
    @_safe
    def parse_books_batch(self, file_ids: list):
        """
        在 Python 中循环解析多本 PDF，期间可被 cancel_parsing() 中断。
        事件流：batch_start -> [book_start -> book_progress* -> (book_done|book_failed|book_cancelled)]* -> batch_done
        """
        if not file_ids:
            return {"results": []}

        # 重置取消标志
        self._cancel_event = threading.Event()

        results = []
        done = cancelled = failed = skipped = 0

        self._emit_progress("batch_start", total=len(file_ids), file_ids=file_ids)

        for i, file_id in enumerate(file_ids, start=1):
            # 整体取消：未开始的书都直接 skip
            if self._cancel_event.is_set():
                results.append({"file_id": file_id, "status": "skipped"})
                skipped += 1
                self._emit_progress("book_cancelled", file_id=file_id, reason="skipped")
                continue

            b = self.lib.get_book(file_id)
            if b is None or not b.exists:
                results.append({"file_id": file_id, "status": "failed",
                                "error": "PDF 文件不存在或不在书架"})
                failed += 1
                self._emit_progress("book_failed", file_id=file_id,
                                    error="PDF 文件不存在或不在书架")
                continue

            self._emit_progress("book_start", file_id=file_id, index=i, total=len(file_ids))

            def _on_page(cur: int, tot: int, _fid=file_id):
                self._emit_progress("book_progress", file_id=_fid,
                                    current=cur, total=tot)

            def _check_cancel():
                return self._cancel_event.is_set()

            try:
                pages = extract_pdf_text(
                    Path(b.pdf_path),
                    self.lib.cache_dir,
                    use_cache=True,
                    on_progress=_on_page,
                    cancel_check=_check_cancel,
                )
                low_q = sum(1 for p in pages if p.is_low_quality)
                results.append({
                    "file_id": file_id, "status": "done",
                    "page_count": len(pages),
                    "low_quality_pages": low_q,
                })
                done += 1
                self._emit_progress("book_done", file_id=file_id,
                                    page_count=len(pages),
                                    low_quality_pages=low_q)
            except ParsingCancelled:
                # 取消的本书：缓存未写入（extract_pdf_text 的 cache 写在末尾，
                # 抛异常已在写入前，所以无副作用）
                results.append({"file_id": file_id, "status": "cancelled"})
                cancelled += 1
                self._emit_progress("book_cancelled", file_id=file_id, reason="aborted")
            except Exception as e:
                results.append({"file_id": file_id, "status": "failed",
                                "error": str(e)})
                failed += 1
                self._emit_progress("book_failed", file_id=file_id, error=str(e))

        self._emit_progress(
            "batch_done",
            total=len(file_ids),
            done=done, cancelled=cancelled, failed=failed, skipped=skipped,
        )
        # 清空取消标志（供下次解析）
        self._cancel_event = None
        return {"results": results, "done": done, "cancelled": cancelled,
                "failed": failed, "skipped": skipped}

    @_safe
    def cancel_parsing(self):
        """前端点"取消解析"时调。立即设置取消标志；正在解析的页跑完即停。"""
        if self._cancel_event is not None:
            self._cancel_event.set()
            return {"cancelled": True}
        return {"cancelled": False, "reason": "当前没有正在进行的解析"}

    @_safe
    def parse_book(self, file_id: str):
        """同步抽取并缓存某本 PDF。期间通过 evaluate_js 推进度。"""
        b = self.lib.get_book(file_id)
        if b is None:
            raise KeyError(f"未在书架中找到：{file_id}")
        if not b.exists:
            raise FileNotFoundError(f"PDF 文件不存在：{b.pdf_path}")

        def _cb(cur: int, total: int):
            self._emit_progress(
                "parse_progress",
                file_id=file_id,
                current=cur,
                total=total,
            )

        self._emit_progress("parse_start", file_id=file_id)
        pages = extract_pdf_text(
            Path(b.pdf_path),
            self.lib.cache_dir,
            use_cache=True,
            on_progress=_cb,
        )
        low_q = sum(1 for p in pages if p.is_low_quality)
        self._emit_progress(
            "parse_done",
            file_id=file_id,
            page_count=len(pages),
            low_quality_pages=low_q,
        )
        return {
            "page_count": len(pages),
            "low_quality_pages": low_q,
        }

    # —— 文档扫描 / 单句查询 共享底层 ——
    def _resolve_scope(self, scope: Optional[dict]) -> Optional[set]:
        """
        把前端传来的 scope 解析为 file_ids 集合。
        scope 形如 {"folders": [...], "file_ids": [...]}：
          - None / 空字典 / 缺失 → 返回 None 表示"全部"
          - 否则取并集（folders 下所有书 + 显式 file_ids）
        """
        if not scope:
            return None
        folders = set(scope.get("folders") or [])
        file_ids = set(scope.get("file_ids") or [])
        # ungrouped 特殊标记：scope.folders 里如果有 "" 或 None，视为含未分组
        include_ungrouped = scope.get("include_ungrouped") is True
        if not folders and not file_ids and not include_ungrouped:
            return None  # 等价于全部

        keep = set(file_ids)
        for b in self.lib.list_books():
            if b.folder in folders and b.folder is not None:
                keep.add(b.file_id)
            if include_ungrouped and b.folder is None:
                keep.add(b.file_id)
        return keep

    def _load_books_pages(self, scope: Optional[dict] = None) -> dict:
        """加载书架上指定范围的 PDF。scope=None 取全部。"""
        keep = self._resolve_scope(scope)
        pages_by_file: dict = {}
        for b in self.lib.list_books():
            if not b.exists:
                continue
            if keep is not None and b.file_id not in keep:
                continue
            pages = extract_pdf_text(
                Path(b.pdf_path),
                self.lib.cache_dir,
                use_cache=True,
            )
            pages_by_file[b.file_id] = pages
        return pages_by_file

    @_safe
    def scan_document(self, docx_path: str, scope: Optional[dict] = None):
        if not docx_path or not Path(docx_path).exists():
            raise FileNotFoundError(docx_path or "未提供 docx 路径")

        self._emit_progress("scan_start", docx=Path(docx_path).name)

        # 阶段 0：抽引文（毫秒级）
        quotes = extract_quotes(Path(docx_path))
        # 立即告诉前端总数，便于显示 0/N 进度条
        self._emit_progress("scan_total", total=len(quotes))

        if not quotes:
            self._emit_progress("scan_done", total=0, hits=0, lows=0, miss=0)
            return {"quotes": [], "books_summary": []}

        # 阶段 1：加载书架 + 预归一化（一次性消耗，后续每条引文都受益）
        self._emit_progress("scan_phase", phase="loading_books")
        books_pages = self._load_books_pages(scope=scope)
        self._emit_progress("scan_phase", phase="precomputing")
        precomputed = precompute_books(books_pages)

        threshold = float(self.settings["threshold"])
        ctx_weight = float(self.settings["ctx_weight"])
        top_k = int(self.settings["top_k"])

        results = []
        matches_for_export = []
        citations_for_export = []
        meta_dict = self.lib.to_meta_dict()
        hits = lows = miss = 0

        # 阶段 2：逐条匹配，每条立刻推给前端
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
            if mr.best is None:
                citation = "待人工确认"
            else:
                meta = meta_dict.get(mr.best.book_file, {})
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
            result_dict = _quote_result_to_dict(q, mr, citation, threshold, meta_dict.get)
            results.append(result_dict)

            if result_dict["status"] == "hit":
                hits += 1
            elif result_dict["status"] == "low":
                lows += 1
            else:
                miss += 1

            self._emit_progress(
                "scan_match",
                current=idx,
                total=len(quotes),
                hits=hits,
                lows=lows,
                miss=miss,
                result=result_dict,
            )

        # 简短的书目质量摘要给前端展示
        books_summary = []
        for file_id, pages in books_pages.items():
            n = len(pages)
            lq = sum(1 for p in pages if p.is_low_quality)
            books_summary.append({
                "file_id": file_id,
                "page_count": n,
                "low_quality_pages": lq,
            })

        # 缓存供导出
        self._last_scan = {
            "quotes": quotes,
            "matches": matches_for_export,
            "citations": citations_for_export,
            "books_pages": books_pages,
            "meta_dict": meta_dict,
            "threshold": threshold,
        }
        self._emit_progress(
            "scan_done",
            total=len(quotes), hits=hits, lows=lows, miss=miss,
        )
        return {"quotes": results, "books_summary": books_summary}

    @_safe
    def lookup_quote(
        self,
        quote: str,
        context_before: str = "",
        context_after: str = "",
        scope: Optional[dict] = None,
    ):
        if not quote or not quote.strip():
            raise ValueError("引文不能为空")

        books_pages = self._load_books_pages(scope=scope)
        threshold = float(self.settings["threshold"])
        ctx_weight = float(self.settings["ctx_weight"])
        # 单句查询场景下，用户希望看到尽量多的候选 —— 绕开扫描用的 top_k 设置，
        # 固定最多 10 条；并允许同一本书出现多次（搜"你"这种高频字时尤其需要）。
        LOOKUP_TOP_K = 10
        LOOKUP_PER_BOOK_CAP = 10

        mr = match_quote(
            quote.strip(),
            books_pages,
            threshold=threshold,
            top_k=LOOKUP_TOP_K,
            docx_before=context_before or "",
            docx_after=context_after or "",
            ctx_weight=ctx_weight,
            per_book_cap=LOOKUP_PER_BOOK_CAP,
        )

        meta_dict = self.lib.to_meta_dict()
        if mr.best is None:
            citation = "待人工确认"
        else:
            meta = meta_dict.get(mr.best.book_file, {})
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

        # 用一个临时 quote 对象套用统一序列化
        class _Q:
            quote_id = 0
            text = quote
            context_before = ""
            context_after = ""
        return {
            "quote": _quote_result_to_dict(_Q(), mr, citation, threshold, meta_dict.get),
        }

    # —— PDF 跳转 ——
    def _find_browser(self):
        """
        找一个支持 file://...#page=N 的浏览器。
        返回 (kind, payload) 或 None：
          - ("exec", path)    Windows：可执行文件路径，subprocess.Popen([path, url])
          - ("mac_app", name) macOS：app 名字，subprocess.Popen(["open", "-a", name, url])
        """
        if os.name == "nt":
            candidates = [
                shutil.which("msedge"),
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                shutil.which("chrome"),
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            ]
            for path in candidates:
                if path and Path(path).exists():
                    return ("exec", path)
            return None

        if sys.platform == "darwin":
            # macOS：优先 Chrome / Edge（PDF 跳页最稳）。
            # Safari 即便给了 #page= 也常常忽略，所以这里不再兜底 Safari。
            mac_apps = [
                "/Applications/Google Chrome.app",
                "/Applications/Microsoft Edge.app",
            ]
            for app_path in mac_apps:
                if Path(app_path).exists():
                    return ("mac_app", Path(app_path).stem)
            return None

        return None

    @_safe
    def open_pdf_at_page(self, file_id: str, pdf_page: int):
        """
        关键：必须强制用浏览器打开，否则系统默认 PDF 阅读器
        （Win 上的 Acrobat/Foxit/WPS、Mac 上的 Preview）通常会忽略 #page= 锚点，
        只打开第一页。Edge / Chrome / Safari 都支持。
        """
        b = self.lib.get_book(file_id)
        if b is None or not b.exists:
            raise FileNotFoundError(f"找不到 PDF：{file_id}")

        # 路径里可能有中文 → percent-encode，保留 / 和 :
        abs_posix = Path(b.pdf_path).resolve().as_posix()
        encoded_path = quote(abs_posix, safe="/:")
        url = f"file:///{encoded_path}#page={int(pdf_page)}"

        found = self._find_browser()
        if found is not None:
            kind, payload = found
            try:
                if kind == "exec":
                    subprocess.Popen([payload, url])
                    return {"opened": True, "url": url, "via": Path(payload).name}
                elif kind == "mac_app":
                    # 关键：必须用 --args，否则 macOS 的 LaunchServices 会把 file:// URL
                    # 当成文件引用解析，#page=N 这一段会被丢掉，浏览器只打开第一页。
                    # 加 --args 后 URL 作为命令行参数原样传给浏览器进程，#page= 才生效。
                    subprocess.Popen(["open", "-a", payload, "--args", url])
                    return {"opened": True, "url": url, "via": payload}
            except Exception:
                pass

        # 兜底：webbrowser.open（可能调系统默认应用，#page 可能丢失）
        webbrowser.open(url)
        return {
            "opened": True,
            "url": url,
            "via": "default",
            "warning": "未找到 Edge/Chrome；调用了系统默认应用，跳页可能不生效。",
        }

    # —— 导出 ——
    @_safe
    def export_report(self, output_path: str):
        if self._last_scan is None:
            raise RuntimeError("还没扫描过任何文档；请先在「文档扫描」中扫描一次。")
        s = self._last_scan
        render_report(
            Path(output_path),
            quotes=s["quotes"],
            matches=s["matches"],
            citations=s["citations"],
            book_meta=s["meta_dict"],
            threshold=s["threshold"],
            books_pages=s["books_pages"],
        )
        return {"saved_to": output_path}

    # —— 数据目录路径（供前端展示） ——
    @_safe
    def get_data_dir_path(self):
        return {"path": str(self.lib.data_dir)}

    @_safe
    def open_data_dir(self):
        """用系统文件管理器打开数据目录。"""
        path = self.lib.data_dir
        if os.name == "nt":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return {"path": str(path)}

    @_safe
    def get_about_info(self):
        """关于信息：版本号、Python 版本、数据目录、依赖状态。"""
        info = {
            "app_name": "寻典",
            "version": "1.0.0-internal",
            "python_version": sys.version.split()[0],
            "data_dir": str(self.lib.data_dir),
            "deps": {},
        }
        # 探依赖
        try:
            import opencc  # noqa
            info["deps"]["opencc"] = "已安装"
        except Exception:
            info["deps"]["opencc"] = "未安装（简繁转换将退到内置最小映射）"
        try:
            import webview as _w
            info["deps"]["pywebview"] = getattr(_w, "__version__", "已安装")
        except Exception:
            info["deps"]["pywebview"] = "未安装"
        try:
            import pypdf as _p
            info["deps"]["pypdf"] = getattr(_p, "__version__", "已安装")
        except Exception:
            info["deps"]["pypdf"] = "未安装"
        try:
            import docx as _d
            info["deps"]["python-docx"] = getattr(_d, "__version__", "已安装")
        except Exception:
            info["deps"]["python-docx"] = "未安装"
        return {"info": info}
