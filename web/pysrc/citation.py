"""引文渲染 — 模板引擎。

模板语法（v1）：
    {field}                必填占位；字段为空则输出"〔X待补〕"占位文
    {?field literal{}literal}   可选段；字段非空时输出整段（{}=字段值），空则消失
其它字符 = 字面。

合法字段（11 个）：
    author role country title translator edition doc_type place publisher year page

规则：
    - role == "著" 或为空 → 渲染为空（{?role …} 段被吃掉）
    - {page} 智能渲染：单页 "25"；跨页 "11-12"；book_page 缺则 pdf_page 兜底；全空 → "页码待补"
    - 不支持嵌套 {?…{?…}}
    - 不支持 { } 转义
"""
from __future__ import annotations

from typing import Optional


VALID_FIELDS = frozenset([
    "author", "role", "country", "title", "translator", "edition",
    "doc_type", "place", "publisher", "year", "page",
])

# 必填字段（{field} 空时显示占位文），运行时字段 page 单独处理
PLACEHOLDER = {
    "author": "〔作者待补〕",
    "title": "〔书名待补〕",
    "place": "〔出版地待补〕",
    "publisher": "〔出版社待补〕",
    "year": "〔出版年待补〕",
    "doc_type": "M",
}


class TemplateSyntaxError(ValueError):
    """模板语法错误（保存前会被编辑器拦下）。"""


def _format_page(book_page, book_page_end, pdf_page) -> str:
    if book_page is not None:
        if book_page_end is not None and book_page_end != book_page:
            return f"{book_page}-{book_page_end}"
        return str(book_page)
    if pdf_page is not None:
        return f"PDF第{pdf_page}页（书内页码待标定）"
    return "页码待补"


def _get_field(field: str, meta: dict, book_page, book_page_end, pdf_page) -> str:
    """取字段值。role=="著" 视为空。page 用智能渲染。"""
    if field == "page":
        return _format_page(book_page, book_page_end, pdf_page)
    val = meta.get(field, "")
    val = "" if val is None else str(val)
    if field == "role" and val == "著":
        return ""
    return val


def _render_required(field: str, value: str) -> str:
    """{field} 必填占位。空 → 占位文；非空 → 值。"""
    if value:
        return value
    return PLACEHOLDER.get(field, "")


def _parse(template: str):
    """模板 → token 数组。token = ('lit', s) | ('req', field) | ('opt', field, prefix, suffix)。

    抛 TemplateSyntaxError 表示模板有问题。
    """
    tokens = []
    i = 0
    n = len(template)
    while i < n:
        c = template[i]
        if c == "}":
            raise TemplateSyntaxError(f"位置 {i}：单独的 }} 无对应 {{")
        if c != "{":
            j = i
            while j < n and template[j] != "{" and template[j] != "}":
                j += 1
            tokens.append(("lit", template[i:j]))
            i = j
            continue
        # 进入 { ... }
        # 找匹配 }：对可选段而言，内部允许出现 {} 占位（必须跳过它的 }）
        # 策略：若 i+1 处是 '?'，则查找时跳过 "{}" 序列；否则取第一个 '}'。
        if i + 1 < n and template[i + 1] == "?":
            j = i + 1
            end = -1
            while j < n:
                ch = template[j]
                if ch == "{":
                    # 仅允许 "{}" 占位
                    if j + 1 < n and template[j + 1] == "}":
                        j += 2
                        continue
                    raise TemplateSyntaxError(
                        f"位置 {i}：可选段内不允许嵌套 {{ 或 {{ 后非 }}"
                    )
                if ch == "}":
                    end = j
                    break
                j += 1
            if end < 0:
                raise TemplateSyntaxError(f"位置 {i}：{{ 没有对应的 }}")
        else:
            end = template.find("}", i + 1)
            if end < 0:
                raise TemplateSyntaxError(f"位置 {i}：{{ 没有对应的 }}")
        inner = template[i + 1:end]
        if not inner:
            raise TemplateSyntaxError(f"位置 {i}：空 {{}} 不允许")
        if inner[0] == "?":
            # 可选段 ?field literal{}literal
            rest = inner[1:].lstrip()
            sp = rest.find(" ")
            if sp < 0:
                raise TemplateSyntaxError(f"位置 {i}：可选段缺少字段名与文本分隔空格")
            field = rest[:sp]
            body = rest[sp + 1:]
            if field not in VALID_FIELDS:
                raise TemplateSyntaxError(f"位置 {i}：未知字段 {field!r}")
            slot = body.find("{}")
            if slot < 0:
                raise TemplateSyntaxError(f"位置 {i}：可选段内必须含一个 {{}} 占位")
            if body.find("{}", slot + 2) >= 0:
                raise TemplateSyntaxError(f"位置 {i}：可选段内只能含一个 {{}} 占位")
            prefix = body[:slot]
            suffix = body[slot + 2:]
            tokens.append(("opt", field, prefix, suffix))
        else:
            field = inner
            if field not in VALID_FIELDS:
                raise TemplateSyntaxError(f"位置 {i}：未知字段 {field!r}")
            tokens.append(("req", field))
        i = end + 1
    return tokens


def render_citation(
    *,
    template: str,
    meta: dict,
    book_page: Optional[int] = None,
    book_page_end: Optional[int] = None,
    pdf_page: Optional[int] = None,
) -> str:
    """根据模板和元数据渲染一条引文字符串。"""
    tokens = _parse(template)
    out_parts = []
    for tok in tokens:
        if tok[0] == "lit":
            out_parts.append(tok[1])
        elif tok[0] == "req":
            field = tok[1]
            val = _get_field(field, meta, book_page, book_page_end, pdf_page)
            out_parts.append(_render_required(field, val))
        else:  # opt
            _, field, prefix, suffix = tok
            val = _get_field(field, meta, book_page, book_page_end, pdf_page)
            if val:
                out_parts.append(prefix + val + suffix)
    return "".join(out_parts)


# —— 向后兼容封装 ——
# 老代码 `from .citation import format_citation` 仍可用，
# 内部转调 render_citation 以 GB/T 7714 模板。

GBT_7714_TEMPLATE = "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}."


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
    """[已弃用，仅向后兼容] GB/T 7714 渲染。新代码请用 render_citation。"""
    return render_citation(
        template=GBT_7714_TEMPLATE,
        meta={
            "author": author, "title": title, "doc_type": doc_type,
            "place": place, "publisher": publisher, "year": year,
        },
        book_page=book_page,
        pdf_page=pdf_page,
    )
