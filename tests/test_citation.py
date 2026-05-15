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


if __name__ == "__main__":
    unittest.main()
