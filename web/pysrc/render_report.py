"""把每条引文及其匹配/脚注渲染为一份对照表 docx（网页版：返回 bytes）。

行为与桌面版的 src/render_report.py 完全一致；唯一的差别是 render_report 不再
写文件，而是返回 docx 的字节流，让 JS 端创建 Blob 触发下载。
"""
from __future__ import annotations

import io
from typing import Dict, List, Optional

from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from .extract_quotes import Quote
from .matcher import MatchResult, MatchCandidate
from .pdf_text import PageText


_HIT = "✓ 自动命中"
_LOW = "⚠ 置信度偏低"
_MISS = "✗ 未命中"

_COLOR_HIT = RGBColor(0x1E, 0x82, 0x3B)
_COLOR_LOW = RGBColor(0xB7, 0x86, 0x12)
_COLOR_MISS = RGBColor(0xC0, 0x39, 0x2B)
_COLOR_DIM = RGBColor(0x66, 0x66, 0x66)


LATIN_FONT = "Times New Roman"
CJK_FONT = "宋体"


def _set_style_fonts(style, *, latin: str = LATIN_FONT, cjk: str = CJK_FONT) -> None:
    style.font.name = latin
    rPr = style.element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.insert(0, rFonts)
    rFonts.set(qn("w:ascii"), latin)
    rFonts.set(qn("w:hAnsi"), latin)
    rFonts.set(qn("w:cs"), latin)
    rFonts.set(qn("w:eastAsia"), cjk)


def _setup_document_fonts(doc) -> None:
    normal = doc.styles["Normal"]
    _set_style_fonts(normal)
    normal.font.size = Pt(11)

    for sty_id, size_pt, bold in (
        ("Heading 1", 16, True),
        ("Heading 2", 14, True),
        ("Heading 3", 12, True),
    ):
        if sty_id in [s.name for s in doc.styles]:
            sty = doc.styles[sty_id]
            _set_style_fonts(sty)
            sty.font.size = Pt(size_pt)
            sty.font.bold = bold
            sty.font.color.rgb = RGBColor(0x1A, 0x3A, 0x6B)


def _status_label_color(result: MatchResult, threshold: float):
    if not result.candidates:
        return _MISS, _COLOR_MISS
    s = result.best.score
    if s >= max(threshold, 0.95):
        return _HIT, _COLOR_HIT
    if s >= threshold:
        return _LOW, _COLOR_LOW
    return _MISS, _COLOR_MISS


def _format_candidate_loc(cand: MatchCandidate) -> str:
    if cand.is_cross_page:
        bp_start = cand.book_page if cand.book_page is not None else "?"
        bp_end = cand.book_page_end if cand.book_page_end is not None else "?"
        return (
            f"{cand.book_file} · PDF p{cand.pdf_page}–{cand.pdf_page_end} · "
            f"书内 p{bp_start}–{bp_end}（跨页）"
        )
    bp = f"书内 p{cand.book_page}" if cand.book_page is not None else "书内页码未识别"
    return f"{cand.book_file} · PDF p{cand.pdf_page} · {bp}"


def _format_scores(cand: MatchCandidate) -> str:
    return (
        f"主分 {cand.score:.2f} · 语境分 {cand.ctx_score:.2f} · "
        f"综合 {cand.final_score:.2f}"
    )


def render_report_bytes(
    quotes: List[Quote],
    matches: List[MatchResult],
    citations: List[str],
    book_meta: Dict[str, dict],
    threshold: float,
    books_pages: Optional[Dict[str, List[PageText]]] = None,
) -> bytes:
    doc = Document()
    _setup_document_fonts(doc)

    h = doc.add_heading("引文核对表", level=1)
    h.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER

    total = len(quotes)
    hits = sum(1 for m in matches if m.candidates and m.best.score >= 0.95)
    low = sum(1 for m in matches if m.candidates and threshold <= m.best.score < 0.95)
    miss = total - hits - low
    doc.add_paragraph(
        f"共 {total} 条引文 · 自动命中 {hits} · 置信度偏低 {low} · 未命中 {miss}"
    )
    doc.add_paragraph(
        "说明：脚注按 GB/T 7714—2015 规范拼装，出版社/年份等占位字段（XX出版社、0000）"
        "需人工补全。当一条引文在多本书中均出现时，程序按「综合分」（主分 + 0.1 × 语境分）"
        "排序，首位为推荐；其余候选放在「其他疑似候选」中供人工对照判断。"
    )

    if books_pages:
        p = doc.add_paragraph()
        run = p.add_run("书目 OCR 质量：")
        run.bold = True
        for book_file, pages in books_pages.items():
            n = len(pages)
            low_q = sum(1 for pg in pages if pg.is_low_quality)
            ratio = low_q / n if n else 0
            line = f"  · {book_file}：{n} 页，低质量 {low_q} 页（{ratio:.0%}）"
            p2 = doc.add_paragraph(line)
            if ratio >= 0.10:
                for r in p2.runs:
                    r.font.color.rgb = _COLOR_LOW

    doc.add_paragraph()

    for quote, result, citation in zip(quotes, matches, citations):
        status, color = _status_label_color(result, threshold)

        p = doc.add_paragraph()
        run = p.add_run(f"[{quote.quote_id}] 引文：")
        run.bold = True
        p.add_run(quote.text)

        p = doc.add_paragraph()
        run = p.add_run("出处（建议）：")
        run.bold = True
        p.add_run(citation)

        p = doc.add_paragraph()
        run = p.add_run("状态：")
        run.bold = True
        run = p.add_run(status)
        run.font.color.rgb = color

        p = doc.add_paragraph()
        run = p.add_run("原文上下文：")
        run.bold = True
        p.add_run(
            f"……{quote.context_before}「{quote.text}」{quote.context_after}……"
        )

        if not result.candidates:
            p = doc.add_paragraph()
            run = p.add_run("命中位置：")
            run.bold = True
            run = p.add_run("无 — 已配置书目中均未找到")
            run.font.color.rgb = _COLOR_MISS
            if books_pages:
                noisy = [
                    (bf, sum(1 for pg in pgs if pg.is_low_quality), len(pgs))
                    for bf, pgs in books_pages.items()
                ]
                noisy = [(bf, lo, n) for bf, lo, n in noisy if n and lo / n >= 0.05]
                if noisy:
                    p = doc.add_paragraph()
                    run = p.add_run("    提示：")
                    run.bold = True
                    detail = "、".join(f"{bf}({lo}/{n})" for bf, lo, n in noisy)
                    run = p.add_run(
                        f"以下书存在低质量 OCR 页（{detail}），命中失败可能由文字层缺失/噪声导致，"
                        f"建议人工翻阅 PDF 原图。"
                    )
                    run.font.color.rgb = _COLOR_LOW
        else:
            best = result.candidates[0]

            p = doc.add_paragraph()
            run = p.add_run("命中位置：")
            run.bold = True
            p.add_run(_format_candidate_loc(best))

            p = doc.add_paragraph()
            run = p.add_run("    " + _format_scores(best))
            run.font.color.rgb = _COLOR_DIM

            p = doc.add_paragraph()
            run = p.add_run("书中片段：")
            run.bold = True
            if best.snippet_before or best.snippet_after:
                p.add_run(
                    f"……{best.snippet_before}「{quote.text}」{best.snippet_after}……"
                )
            else:
                p.add_run(best.snippet)

            others = result.candidates[1:]
            if others:
                p = doc.add_paragraph()
                run = p.add_run(f"其他疑似候选（{len(others)} 条，供人工对照）：")
                run.bold = True

                for i, cand in enumerate(others, start=2):
                    p = doc.add_paragraph()
                    run = p.add_run(f"  候选 {i} · ")
                    run.bold = True
                    run = p.add_run(_format_candidate_loc(cand))
                    run.bold = True

                    p = doc.add_paragraph()
                    run = p.add_run("    " + _format_scores(cand))
                    run.font.color.rgb = _COLOR_DIM

                    p = doc.add_paragraph()
                    run = p.add_run("    书中片段：")
                    run.bold = True
                    if cand.snippet_before or cand.snippet_after:
                        p.add_run(
                            f"……{cand.snippet_before}「{quote.text}」{cand.snippet_after}……"
                        )
                    else:
                        p.add_run(cand.snippet)

        doc.add_paragraph("─" * 30)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
