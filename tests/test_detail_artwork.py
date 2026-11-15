from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image

from handbook import detail_artwork


class DetailArtworkTest(unittest.TestCase):
    def test_search_uses_provider_order_and_skips_broken_candidates(self):
        calls = []

        def provider(name, candidates):
            def search(_lookup, titles):
                calls.append((name, titles))
                yield from ((url, "") for url in candidates)
            return search

        providers = (
            provider("Alpha Coders", ["broken"]),
            provider("Wallhaven", []),
            provider("Anime-Pictures", ["portrait", "landscape"]),
            provider("Pixiv", ["unused"]),
        )
        with patch.object(detail_artwork, "PROVIDERS", providers), patch.object(
            detail_artwork, "_image", side_effect=[OSError(), None, b"image"],
        ):
            self.assertEqual(detail_artwork._find(["作品"]), b"image")
        self.assertEqual([name for name, _ in calls], ["Alpha Coders", "Wallhaven", "Anime-Pictures"])

    def test_uses_cached_image_and_temporarily_caches_a_miss(self):
        anime = {"id": 12, "name": "作品 第3期"}
        with TemporaryDirectory() as directory, patch.object(
            detail_artwork, "_find", side_effect=[b"image", None],
        ) as find:
            root = Path(directory)
            self.assertEqual(detail_artwork.get_artwork(root, anime), b"image")
            self.assertEqual(detail_artwork.get_artwork(root, anime), b"image")
            self.assertIsNone(detail_artwork.get_artwork(root, {**anime, "id": 13}))
            self.assertIsNone(detail_artwork.get_artwork(root, {**anime, "id": 13}))
            self.assertEqual(find.call_count, 2)
            self.assertEqual(find.call_args.args[0], ["作品", "作品 第3期"])

    def test_decodes_and_resizes_an_actual_landscape(self):
        for size, expected in [((2560, 1440), (1920, 1080)), ((1280, 1600), None), ((1920, 408), None)]:
            with self.subTest(size=size):
                raw = BytesIO()
                Image.new("RGB", size).save(raw, format="PNG")
                lookup = unittest.mock.Mock()
                lookup.read.return_value = (raw.getvalue(), "")
                data = detail_artwork._image(lookup, "test", "")
                if expected:
                    with Image.open(BytesIO(data)) as image:
                        self.assertEqual((image.format, image.size), ("WEBP", expected))
                else:
                    self.assertIsNone(data)
