"""Local rotating diagnostics; never log bodies, queries, cookies or error text."""
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import traceback

LOG = logging.getLogger("anime_handbook")


def configure_logging(root):
    if LOG.handlers: return
    directory = Path(root) / "logs"
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(directory / "backend.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8", delay=True)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    LOG.propagate = False


def record_failure(operation, error, request_id=""):
    # Trace locations are useful; exception messages can contain credentials or
    # user prose. Log type and call sites only, with an ID the UI can report.
    frames = traceback.extract_tb(error.__traceback__)
    locations = " > ".join(f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}" for frame in frames)
    LOG.error("failure op=%s id=%s type=%s at=%s", operation, request_id, type(error).__name__, locations)


def close_logging():
    for handler in list(LOG.handlers):
        LOG.removeHandler(handler)
        handler.close()
