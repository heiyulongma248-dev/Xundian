"""引文核对表生成入口。

使用：
    python main.py
    python main.py --threshold 0.80
    python main.py --no-cache
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from src.extract_quotes import extract_quotes
from src.pdf_text import extract_pdf_text
from src.matcher import match_quote
from src.citation import format_citation
from src.render_report import render_report


def _placeholder_book_entry(pdf_name: str) -> dict:
    """为新发现的 PDF 生成一份占位元数据。"""
    title_guess = Path(pdf_name).stem.strip()
    return {
        "file": pdf_name,
        "author": "XX",
        "title": title_guess,
        "doc_type": "M",
        "place": "XX",
        "publisher": "XX出版社",
        "year": "0000",
        "page_offset": None,
    }


def _sync_books_config(config_path: Path, books_dir: Path) -> list:
    """读取 books.json；为 Books/ 下未登记的新 PDF 自动追加占位条目并写回。"""
    if config_path.exists():
        existing = json.loads(config_path.read_text(encoding="utf-8"))
    else:
        existing = []
    known = {item["file"] for item in existing}

    on_disk = sorted(p.name for p in books_dir.glob("*.pdf"))
    new_files = [name for name in on_disk if name not in known]

    if new_files:
        for name in new_files:
            existing.append(_placeholder_book_entry(name))
            print(f"    [auto-add] 新发现 PDF：{name}（已在 books.json 中追加占位条目，"
                  f"作者/出版社等请手动补全）")
        config_path.write_text(
            json.dumps(existing, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # 同时报告 books.json 中登记但磁盘上不存在的条目
    on_disk_set = set(on_disk)
    missing = [item["file"] for item in existing if item["file"] not in on_disk_set]
    for name in missing:
        print(f"    [warn] books.json 中登记但 {books_dir.name}/ 下找不到：{name}")

    return existing


def main() -> int:
    parser = argparse.ArgumentParser(description="ai 查询并标注引文 — 核对表生成器")
    parser.add_argument("--input", default="ai查询并标注引文.docx", help="输入 docx")
    parser.add_argument("--books-dir", default="Books", help="PDF 书目目录")
    parser.add_argument("--books-config", default="books.json", help="书目元数据 JSON")
    parser.add_argument("--cache-dir", default="cache", help="PDF 文本缓存目录")
    parser.add_argument("--output", default="引文核对表.docx", help="输出对照表")
    parser.add_argument("--threshold", type=float, default=0.85, help="模糊匹配阈值")
    parser.add_argument("--ctx-weight", type=float, default=0.1,
                        help="语境分权重（仅用于打平时排序，默认 0.1）")
    parser.add_argument("--top-k", type=int, default=3, help="每条引文最多列出的候选数")
    parser.add_argument("--no-cache", action="store_true", help="忽略 PDF 缓存重抽")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    input_path = (root / args.input).resolve()
    books_dir = (root / args.books_dir).resolve()
    cache_dir = (root / args.cache_dir).resolve()
    output_path = (root / args.output).resolve()
    config_path = (root / args.books_config).resolve()

    # 1. 抽取引文
    print(f"[1/4] 抽取引文：{input_path.name}")
    quotes = extract_quotes(input_path)
    if not quotes:
        print("    未在高亮段中找到任何 \"\" 引文。")
        return 1
    print(f"    抽到 {len(quotes)} 条引文。")

    # 2. 同步书目（自动收纳 Books/ 下的新 PDF）+ 抽取每本 PDF 的文本
    print(f"[2/4] 同步书目配置：{config_path.name}")
    book_meta_list = _sync_books_config(config_path, books_dir)
    book_meta = {item["file"]: item for item in book_meta_list}

    books_pages = {}
    for item in book_meta_list:
        pdf_path = books_dir / item["file"]
        if not pdf_path.exists():
            continue  # 已在 _sync_books_config 中报过 warn
        print(f"    解析 PDF：{pdf_path.name}")
        pages = extract_pdf_text(pdf_path, cache_dir, use_cache=not args.no_cache)
        with_book_page = sum(1 for p in pages if p.book_page is not None)
        print(f"    {len(pages)} 页，{with_book_page} 页识别出书内页码。")
        books_pages[item["file"]] = pages

    # 3. 逐条匹配并生成脚注字符串
    print(f"[3/4] 匹配 {len(quotes)} 条引文（阈值 {args.threshold}）……")
    matches = []
    citations = []
    for q in quotes:
        result = match_quote(
            q.text,
            books_pages,
            threshold=args.threshold,
            top_k=args.top_k,
            docx_before=q.context_before,
            docx_after=q.context_after,
            ctx_weight=args.ctx_weight,
        )
        matches.append(result)
        if result.best is None:
            citations.append("待人工确认")
        else:
            meta = book_meta.get(result.best.book_file, {})
            citations.append(
                format_citation(
                    author=meta.get("author", "XX"),
                    title=meta.get("title", result.best.book_file),
                    doc_type=meta.get("doc_type", "M"),
                    place=meta.get("place", "XX"),
                    publisher=meta.get("publisher", "XX出版社"),
                    year=meta.get("year", "0000"),
                    book_page=result.best.book_page,
                    pdf_page=result.best.pdf_page,
                )
            )
        status = "✓" if result.best and result.best.score >= 0.95 else (
            "⚠" if result.best else "✗"
        )
        if result.best is None:
            loc = "—"
        else:
            b = result.best
            tag = "（跨页）" if b.is_cross_page else ""
            if b.book_page is not None:
                loc = (
                    f"{b.book_file} 书内 p{b.book_page}"
                    + (f"–{b.book_page_end}" if b.is_cross_page and b.book_page_end else "")
                    + tag
                )
            else:
                loc = f"{b.book_file} pdf p{b.pdf_page}{tag}"
        print(f"    {status} [{q.quote_id}] {q.text}  →  {loc}")

    # 4. 渲染对照表
    print(f"[4/4] 写出 {output_path.name}")
    render_report(
        output_path, quotes, matches, citations, book_meta, args.threshold,
        books_pages=books_pages,
    )
    print("完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
