"""Build a source-only deployment archive. Local databases and credentials are excluded."""
from __future__ import annotations

import hashlib
import json
import zipfile
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path


_PUBLISH_LOCK = threading.Lock()


def build(root: Path) -> Path:
    root = root.resolve()
    files = [root / "app.py", root / "schedule.py"]
    for folder in ("static", "server", "handbook", "deploy/online"):
        files.extend(p for p in (root / folder).rglob("*") if p.is_file() and not p.is_symlink() and "__pycache__" not in p.parts and p.suffix != ".pyc")
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d")
    destination = root / "releases" / "online" / f"anime-handbook-online-{stamp}.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    manifest = {}
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=destination.stem + ".", suffix=".tmp", delete=False) as stage:
        temporary = Path(stage.name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(files):
                name = path.relative_to(root).as_posix()
                # Hash exactly the bytes archived, even if a source changes during packaging.
                data = path.read_bytes()
                manifest[name] = hashlib.sha256(data).hexdigest()
                info = zipfile.ZipInfo.from_file(path, arcname=name)
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
            archive.writestr("MANIFEST.sha256.json", json.dumps(manifest, indent=2))
        with _PUBLISH_LOCK:
            temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    print(build(Path(__file__).resolve().parents[1]))
