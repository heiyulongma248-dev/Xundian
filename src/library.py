"""数据目录与书架管理。

数据目录布局：
    %APPDATA%/XunDian/         (Windows)
    ~/.xundian/                (其他系统)
        books.json             — { folders: [...], books: [...] }
        cache/                 — pdf_text 的 jsonl 缓存
        settings.json          — 阈值等运行参数

books.json 格式（v2）：
    {
      "version": 2,
      "folders": ["胡适日记", "胡适书信"],   # 显式文件夹列表，可有空文件夹
      "books": [
        {"file_id": "...", "folder": "胡适日记" | null, ...}
      ]
    }

兼容 v1（裸数组）：首次读取时自动迁移到 v2 格式。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Optional


# —— 数据目录 ——

def get_data_dir() -> Path:
    """返回应用数据目录，自动创建。各平台用各自惯例位置。"""
    import sys
    if os.name == "nt":
        # Windows: %APPDATA%/XunDian
        base = Path(os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming")))
        d = base / "XunDian"
    elif sys.platform == "darwin":
        # macOS: ~/Library/Application Support/XunDian
        d = Path.home() / "Library" / "Application Support" / "XunDian"
    else:
        # Linux/其他: 跟 XDG 也行，但目前简化为隐藏目录
        d = Path.home() / ".xundian"
    d.mkdir(parents=True, exist_ok=True)
    (d / "cache").mkdir(parents=True, exist_ok=True)
    return d


# —— 设置 ——

DEFAULT_SETTINGS = {
    "threshold": 0.85,
    "ctx_weight": 0.1,
    "top_k": 3,
}


def load_settings() -> dict:
    p = get_data_dir() / "settings.json"
    if not p.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return {**DEFAULT_SETTINGS, **d}
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_SETTINGS)


def save_settings(patch: dict) -> dict:
    cur = load_settings()
    cur.update(patch)
    p = get_data_dir() / "settings.json"
    p.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
    return cur


# —— 书架 ——

@dataclass
class BookEntry:
    file_id: str          # 主键，使用 PDF 文件名（含扩展名）
    pdf_path: str         # 绝对路径
    author: str
    title: str
    doc_type: str         # M/J/N…
    place: str
    publisher: str
    year: str
    page_offset: Optional[int] = None  # 兼容旧字段，未使用
    folder: Optional[str] = None       # 文件夹标签；None 表示未分组
    # 运行时附加（不持久化到 books.json）：
    exists: bool = True
    parsed: bool = False
    page_count: int = 0
    low_quality_pages: int = 0


_PERSIST_FIELDS = (
    "file_id", "pdf_path", "author", "title",
    "doc_type", "place", "publisher", "year", "page_offset",
    "folder",
)

_BOOKS_JSON_VERSION = 2


def _placeholder_meta(pdf_path: Path) -> dict:
    return {
        "file_id": pdf_path.name,
        "pdf_path": str(pdf_path.resolve()),
        "author": "XX",
        "title": pdf_path.stem.strip(),
        "doc_type": "M",
        "place": "XX",
        "publisher": "XX出版社",
        "year": "0000",
        "page_offset": None,
        "folder": None,
    }


def _normalize_folder_name(name: Optional[str]) -> Optional[str]:
    if name is None:
        return None
    s = str(name).strip()
    return s if s else None


class Library:
    """轻量包装 books.json。所有改动写盘原子化（先写 .tmp 再 rename）。"""

    def __init__(self, data_dir: Optional[Path] = None):
        self.data_dir = data_dir or get_data_dir()
        self.cache_dir = self.data_dir / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.books_json = self.data_dir / "books.json"
        self._maybe_migrate_legacy()

    # ---------- 持久化（v2 结构） ----------

    def _read_doc(self) -> dict:
        """读 books.json，统一返回 v2 结构 {version, folders, books}。"""
        if not self.books_json.exists():
            return {"version": _BOOKS_JSON_VERSION, "folders": [], "books": []}
        try:
            data = json.loads(self.books_json.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"version": _BOOKS_JSON_VERSION, "folders": [], "books": []}

        # v1（裸数组） → 升级
        if isinstance(data, list):
            return {
                "version": _BOOKS_JSON_VERSION,
                "folders": [],
                "books": data,
            }
        # v2
        if isinstance(data, dict):
            return {
                "version": data.get("version", _BOOKS_JSON_VERSION),
                "folders": list(data.get("folders") or []),
                "books": list(data.get("books") or []),
            }
        return {"version": _BOOKS_JSON_VERSION, "folders": [], "books": []}

    def _write_doc(self, doc: dict) -> None:
        # 仅落盘指定字段，避免运行时附加字段污染文件
        cleaned_books = []
        for b in doc.get("books", []):
            cleaned_books.append({k: b.get(k) for k in _PERSIST_FIELDS})
        out = {
            "version": _BOOKS_JSON_VERSION,
            "folders": [str(f).strip() for f in doc.get("folders", []) if str(f).strip()],
            "books": cleaned_books,
        }
        tmp = self.books_json.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(out, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(self.books_json)

    # ---------- 迁移旧 books.json（项目根目录） ----------

    def _maybe_migrate_legacy(self) -> None:
        if self.books_json.exists():
            return
        for candidate_root in {Path.cwd(), Path(__file__).resolve().parent.parent}:
            legacy = candidate_root / "books.json"
            if not legacy.exists():
                continue
            try:
                old = json.loads(legacy.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            new_books = []
            for item in (old if isinstance(old, list) else old.get("books", [])):
                fname = item.get("file") or item.get("file_id")
                if not fname:
                    continue
                pdf_abs = item.get("pdf_path")
                if not pdf_abs:
                    guess = candidate_root / "Books" / fname
                    pdf_abs = str(guess.resolve()) if guess.exists() else ""
                new_books.append({
                    "file_id": fname,
                    "pdf_path": pdf_abs,
                    "author": item.get("author", "XX"),
                    "title": item.get("title", Path(fname).stem),
                    "doc_type": item.get("doc_type", "M"),
                    "place": item.get("place", "XX"),
                    "publisher": item.get("publisher", "XX出版社"),
                    "year": item.get("year", "0000"),
                    "page_offset": item.get("page_offset"),
                    "folder": item.get("folder"),
                })
            if new_books:
                self._write_doc({
                    "version": _BOOKS_JSON_VERSION,
                    "folders": (old.get("folders", []) if isinstance(old, dict) else []),
                    "books": new_books,
                })
                return
        # 没有旧文件 → 初始化空 doc
        self._write_doc({"version": _BOOKS_JSON_VERSION, "folders": [], "books": []})

    # ---------- 文件夹 ----------

    def list_folder_names(self) -> List[str]:
        """返回显式文件夹列表（含空文件夹），排序后。"""
        return sorted(self._read_doc().get("folders", []))

    def folder_counts(self) -> dict:
        """统计每个文件夹的书数（含未分组）。"""
        counts = {}
        for b in self._read_doc().get("books", []):
            f = _normalize_folder_name(b.get("folder"))
            counts[f] = counts.get(f, 0) + 1
        return counts

    def create_folder(self, name: str) -> str:
        n = _normalize_folder_name(name)
        if not n:
            raise ValueError("文件夹名不能为空")
        doc = self._read_doc()
        existing = set(doc.get("folders", []))
        if n in existing:
            raise ValueError(f"已存在同名文件夹：{n}")
        doc["folders"].append(n)
        self._write_doc(doc)
        return n

    def rename_folder(self, old_name: str, new_name: str) -> str:
        old = _normalize_folder_name(old_name)
        new = _normalize_folder_name(new_name)
        if not old:
            raise ValueError("旧文件夹名不能为空")
        if not new:
            raise ValueError("新文件夹名不能为空")
        doc = self._read_doc()
        folders = doc.get("folders", [])
        if old not in folders:
            raise KeyError(f"找不到文件夹：{old}")
        if new != old and new in folders:
            raise ValueError(f"已存在同名文件夹：{new}")
        # 更新文件夹列表
        doc["folders"] = [new if f == old else f for f in folders]
        # 更新所有书
        for b in doc["books"]:
            if _normalize_folder_name(b.get("folder")) == old:
                b["folder"] = new
        self._write_doc(doc)
        return new

    def delete_folder(self, name: str) -> int:
        """删除文件夹（不删书）；该文件夹下的书 folder 字段置 None。返回受影响书数。"""
        n = _normalize_folder_name(name)
        if not n:
            raise ValueError("文件夹名不能为空")
        doc = self._read_doc()
        if n not in doc.get("folders", []):
            raise KeyError(f"找不到文件夹：{n}")
        doc["folders"] = [f for f in doc["folders"] if f != n]
        affected = 0
        for b in doc["books"]:
            if _normalize_folder_name(b.get("folder")) == n:
                b["folder"] = None
                affected += 1
        self._write_doc(doc)
        return affected

    # ---------- 书 ----------

    def list_books(self) -> List[BookEntry]:
        out: List[BookEntry] = []
        for d in self._read_doc().get("books", []):
            entry = BookEntry(
                file_id=d.get("file_id") or d.get("file", ""),
                pdf_path=d.get("pdf_path", ""),
                author=d.get("author", "XX"),
                title=d.get("title", ""),
                doc_type=d.get("doc_type", "M"),
                place=d.get("place", "XX"),
                publisher=d.get("publisher", "XX出版社"),
                year=d.get("year", "0000"),
                page_offset=d.get("page_offset"),
                folder=_normalize_folder_name(d.get("folder")),
            )
            entry.exists = bool(entry.pdf_path) and Path(entry.pdf_path).exists()
            cache_file = self.cache_dir / (Path(entry.file_id).stem + ".jsonl")
            sig_file = self.cache_dir / (Path(entry.file_id).stem + ".sig.json")
            entry.parsed = cache_file.exists() and sig_file.exists()
            if entry.parsed:
                pc, lq = 0, 0
                try:
                    with cache_file.open("r", encoding="utf-8") as f:
                        for line in f:
                            if not line.strip():
                                continue
                            pc += 1
                            try:
                                if json.loads(line).get("is_low_quality"):
                                    lq += 1
                            except json.JSONDecodeError:
                                pass
                except OSError:
                    pass
                entry.page_count = pc
                entry.low_quality_pages = lq
            out.append(entry)
        return out

    def get_book(self, file_id: str) -> Optional[BookEntry]:
        for b in self.list_books():
            if b.file_id == file_id:
                return b
        return None

    def add_book(self, pdf_path: str, meta: Optional[dict] = None) -> BookEntry:
        p = Path(pdf_path).resolve()
        if not p.exists():
            raise FileNotFoundError(pdf_path)
        if p.suffix.lower() != ".pdf":
            raise ValueError("only .pdf files are accepted")

        doc = self._read_doc()
        file_id = p.name
        if any(e.get("file_id") == file_id for e in doc["books"]):
            raise ValueError(f"已存在同名书：{file_id}")

        new_entry = _placeholder_meta(p)
        if meta:
            for k in ("author", "title", "doc_type", "place", "publisher", "year"):
                if meta.get(k):
                    new_entry[k] = meta[k]
            if "folder" in meta:
                folder = _normalize_folder_name(meta.get("folder"))
                new_entry["folder"] = folder
                # 自动添加到文件夹列表（如果是新名字）
                if folder and folder not in doc["folders"]:
                    doc["folders"].append(folder)
        doc["books"].append(new_entry)
        self._write_doc(doc)
        return self.get_book(file_id)  # type: ignore[return-value]

    def update_book(self, file_id: str, meta_patch: dict) -> BookEntry:
        doc = self._read_doc()
        for e in doc["books"]:
            if e.get("file_id") == file_id:
                for k in ("author", "title", "doc_type", "place", "publisher", "year"):
                    if k in meta_patch:
                        e[k] = meta_patch[k]
                if "folder" in meta_patch:
                    folder = _normalize_folder_name(meta_patch.get("folder"))
                    e["folder"] = folder
                    # 自动登记新文件夹
                    if folder and folder not in doc["folders"]:
                        doc["folders"].append(folder)
                self._write_doc(doc)
                return self.get_book(file_id)  # type: ignore[return-value]
        raise KeyError(file_id)

    def update_book_folders(self, file_ids: List[str], folder: Optional[str]) -> int:
        """批量把若干本书移到指定文件夹（folder=None 表示移出到未分组）。"""
        target = _normalize_folder_name(folder)
        doc = self._read_doc()
        if target and target not in doc["folders"]:
            doc["folders"].append(target)
        affected = 0
        ids = set(file_ids or [])
        for e in doc["books"]:
            if e.get("file_id") in ids:
                e["folder"] = target
                affected += 1
        self._write_doc(doc)
        return affected

    def remove_book(self, file_id: str, *, drop_cache: bool = True) -> bool:
        doc = self._read_doc()
        before = len(doc["books"])
        doc["books"] = [e for e in doc["books"] if e.get("file_id") != file_id]
        if len(doc["books"]) == before:
            return False
        self._write_doc(doc)
        if drop_cache:
            stem = Path(file_id).stem
            for suffix in (".jsonl", ".sig.json"):
                f = self.cache_dir / (stem + suffix)
                if f.exists():
                    try:
                        f.unlink()
                    except OSError:
                        pass
        return True

    def to_meta_dict(self) -> dict:
        return {b.file_id: asdict(b) for b in self.list_books()}
