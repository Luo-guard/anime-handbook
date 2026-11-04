"""Explicit shared route dependencies; no desktop initialization at import."""
from __future__ import annotations
from .settings_service import save_settings
from .http_support import send_asset
from .video_links import VideoLinks
from .collection import save_collection
from typing import Any
from http import HTTPStatus
from pathlib import Path
from schedule import ScheduleService
from schedule import attach_collection
import base64
import json
import mimetypes
from urllib.parse import parse_qs
import re
from schedule import season_key
import secrets
import time
from urllib.parse import unquote
from urllib.parse import urlparse
from .common import CATEGORY_NAMES, background_stem, find_background_asset, normalize_background_bytes, safe_asset_id
from .jumps import normalize_jump
def _desktop():
    from . import desktop
    return desktop
