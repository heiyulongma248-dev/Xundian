"""内置引用格式模板。仅 3 个，硬编码，不依赖运行时存储。

用户和"已修改的内置"都存 IndexedDB；运行时由 JS 端负责合并查询。
Python 端只懂内置 3 个，用户格式调用必须由 JS 传 template 字符串过来（见 web_api.render_citation）。
"""
from __future__ import annotations

from typing import Optional


BUILTIN_FORMATS = [
    {
        "id": "gbt7714",
        "name": "GB/T 7714—2015",
        "category": "builtin",
        "template": "{author}. {title}[{doc_type}]. {place}: {publisher}, {year}: {page}.",
    },
    {
        "id": "humanities_2024",
        "name": "历史研究体例",
        "category": "builtin",
        "template": "{?country [{}]}{author}{?role {}}：《{title}》，{?translator {}译，}{place}：{publisher}，{year}年，第{page}页。",
    },
    {
        "id": "law_2025",
        "name": "法学引注手册 2025",
        "category": "builtin",
        "template": "{?country [{}]}{author}{?role {}}：《{title}》{?edition （第{}版）}，{?translator {}译，}{publisher}{year}年版，第{page}页。",
    },
]

DEFAULT_FORMAT_ID = "gbt7714"


def get_builtin_template(format_id: str) -> Optional[str]:
    """返回内置格式的模板字符串；未知 id 返回 None。"""
    for f in BUILTIN_FORMATS:
        if f["id"] == format_id:
            return f["template"]
    return None
