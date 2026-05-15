"""共享 JSON 用例驱动的 Python 端 citation 渲染测试。"""
import json
import os
import sys
import unittest

# 把 web/ 加进 sys.path，让 pysrc 可被 import
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "web"))

from pysrc.citation import render_citation  # noqa: E402


FIXTURE = os.path.join(ROOT, "tests", "citation_test_cases.json")


class CitationRendererTest(unittest.TestCase):
    def test_all_cases(self):
        with open(FIXTURE, "r", encoding="utf-8") as f:
            data = json.load(f)
        failures = []
        for case in data["cases"]:
            out = render_citation(
                template=case["template"],
                meta=case["meta"],
                book_page=case.get("book_page"),
                book_page_end=case.get("book_page_end"),
                pdf_page=case.get("pdf_page"),
            )
            if out != case["expected"]:
                failures.append(
                    f"\n  [{case['name']}]\n    期望: {case['expected']}\n    实际: {out}"
                )
        if failures:
            self.fail("有用例失败：" + "".join(failures))


from pysrc.formats import BUILTIN_FORMATS, get_builtin_template  # noqa: E402


class BuiltinFormatsTest(unittest.TestCase):
    def test_three_builtins_present(self):
        ids = {f["id"] for f in BUILTIN_FORMATS}
        self.assertEqual(ids, {"gbt7714", "humanities_2024", "law_2025"})

    def test_get_builtin_template_returns_string(self):
        t = get_builtin_template("gbt7714")
        self.assertIsInstance(t, str)
        self.assertIn("{author}", t)

    def test_get_builtin_template_unknown_returns_none(self):
        self.assertIsNone(get_builtin_template("nonexistent_id"))

    def test_builtin_humanities_renders_correctly(self):
        template = get_builtin_template("humanities_2024")
        out = render_citation(
            template=template,
            meta={"author": "任继愈", "role": "主编", "country": "", "translator": "",
                  "title": "中国哲学发展史（先秦卷）", "place": "北京",
                  "publisher": "人民出版社", "year": "1983"},
            book_page=25,
        )
        self.assertEqual(
            out,
            "任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。"
        )


class WebApiBackwardCompatTest(unittest.TestCase):
    """验证不传 format_id/template 时仍按 GB/T 7714 渲染（旧调用兼容）。"""

    def test_format_citation_still_works(self):
        # citation.py 里的 format_citation 仍可用（旧代码用它）
        from pysrc.citation import format_citation
        out = format_citation(
            author="胡适", title="胡适日记", doc_type="M",
            place="合肥", publisher="安徽教育出版社", year="2001",
            book_page=25,
        )
        self.assertEqual(out, "胡适. 胡适日记[M]. 合肥: 安徽教育出版社, 2001: 25.")

    def test_resolve_template_falls_back_to_default(self):
        from pysrc.web_api import _resolve_template
        # 都不传 → 默认 GB/T
        t = _resolve_template(None, None)
        self.assertIn("{author}", t)
        self.assertIn("[{doc_type}]", t)

    def test_resolve_template_template_wins(self):
        from pysrc.web_api import _resolve_template
        t = _resolve_template("gbt7714", "CUSTOM {title}")
        self.assertEqual(t, "CUSTOM {title}")

    def test_resolve_template_unknown_id_falls_back(self):
        from pysrc.web_api import _resolve_template
        t = _resolve_template("user_xxxxxx", None)
        self.assertIn("{author}", t)  # 回退默认


if __name__ == "__main__":
    unittest.main()
