"""GB/T 7714—2015 专著脚注字符串拼装。"""
from __future__ import annotations

from typing import Optional


def format_citation(
    *,
    author: str,
    title: str,
    doc_type: str = "M",
    place: str = "XX",
    publisher: str = "XX出版社",
    year: str = "0000",
    book_page: Optional[int] = None,
    pdf_page: Optional[int] = None,
) -> str:
    """
    GB/T 7714—2015 专著（顺序编码制）格式：
        作者. 题名: 其他题名信息[文献类型标志]. 出版地: 出版者, 出版年: 引文页码.
    若 book_page 缺失，用 pdf_page 占位提示人工标定。
    """
    if book_page is not None:
        page_part = str(book_page)
    elif pdf_page is not None:
        page_part = f"PDF第{pdf_page}页（书内页码待标定）"
    else:
        page_part = "页码待补"
    return (
        f"{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page_part}."
    )
