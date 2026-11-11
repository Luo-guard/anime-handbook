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
SUBTITLE_FILES = (
    'jassub.bundle.js', 'jassub-worker.bundle.js', 'default.woff2', 'noto-sans-sc-400.woff2',
    'wasm/jassub-worker.js', 'wasm/jassub-worker-modern.js',
    'wasm/jassub-worker.wasm', 'wasm/jassub-worker-modern.wasm', 'LICENSES.txt',
)


def check_subtitles(root: Path) -> dict[str, str]:
    """Fail before publishing an archive that would silently lose ASS support."""
    folder = root / 'static' / 'vendor' / 'jassub'
    try:
        manifest_data = (folder / 'assets-manifest.json').read_bytes()
        manifest = json.loads(manifest_data)
        hashes = manifest['files']
        result = {'static/vendor/jassub/assets-manifest.json': hashlib.sha256(manifest_data).hexdigest()}
        for name in SUBTITLE_FILES:
            file = folder / name
            data = file.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if file.is_symlink() or not data or hashes[name] != digest:
                raise ValueError(f'Invalid asset: {name}')
            result[f'static/vendor/jassub/{name}'] = digest
        return result
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError('Subtitle assets missing or damaged. Run: node tools/prepare_subtitles.cjs') from error


def build(root: Path) -> Path:
    root = root.resolve()
    subtitle_hashes = check_subtitles(root)
    files = [root / "app.py", root / "schedule.py"]
    for folder in ("static", "server", "handbook", "deploy/online"):
        files.extend(p for p in (root / folder).rglob("*") if p.is_file() and not p.is_symlink()
                     and "__pycache__" not in p.parts and p.suffix != ".pyc"
                     and not any(part.startswith(('.jassub-build-', '.jassub-backup-')) for part in p.parts))
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
                if name in subtitle_hashes and manifest[name] != subtitle_hashes[name]:
                    raise RuntimeError(f'Subtitle asset changed during packaging: {name}')
                info = zipfile.ZipInfo.from_file(path, arcname=name)
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
            if not subtitle_hashes.keys() <= manifest.keys():
                raise RuntimeError('Subtitle assets removed during packaging; rebuild and retry.')
            archive.writestr("MANIFEST.sha256.json", json.dumps(manifest, indent=2))
        with _PUBLISH_LOCK:
            temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    print(build(Path(__file__).resolve().parents[1]))
