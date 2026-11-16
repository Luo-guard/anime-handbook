from io import BytesIO
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import Mock, patch

from lxml import html
from PIL import Image

from handbook import detail_artwork


class DetailArtworkTest(unittest.TestCase):
    def test_alpha_checks_each_image_even_after_a_gallery_redirect(self):
        lookup = Mock()
        lookup.page.return_value = (html.fromstring("""
          <div>
            <div class="thumb-container-wallpaper-desktop">
              <a class="thumb-tag-masonry">Max</a>
              <div class="thumb-info-masonry">1920x1080</div>
              <meta itemprop="contentUrl" content="dog">
            </div>
            <div class="thumb-container-wallpaper-desktop">
              <a class="thumb-tag-masonry">Anime</a><a class="thumb-tag-masonry">Max Reijou</a>
              <div class="thumb-info-masonry">1920x1080</div>
              <meta itemprop="contentUrl" content="anime">
            </div>
          </div>"""), "https://alphacoders.com/max-wallpapers")
        self.assertEqual(list(detail_artwork._alpha(lookup, ["Max Reijou"])), [
            ("anime", "https://alphacoders.com/max-wallpapers"),
        ])

    def test_anime_pictures_skips_multi_series_posts(self):
        lookup = Mock()
        target = {"id": 202402, "type": 3, "tag": "100 Girlfriends"}
        other = {"id": 196555, "type": 3, "tag": "Frieren"}
        character = {"id": 7, "type": 1, "tag": "character"}
        base = {"erotics": 0, "width": 1920, "height": 1080, "score": 3, "score_number": 2, "download_count": 1}
        lookup.json.side_effect = [
            {"exclusive_tag": target, "posts": [{**base, "id": 1}, {**base, "id": 2}]},
            {"tags": [{"tag": target}, {"tag": other}], "post": {"big_preview": "mixed"}},
            {"tags": [{"tag": target}, {"tag": character}], "post": {"big_preview": "solo"}},
        ]
        self.assertEqual(list(detail_artwork._anime_pictures(lookup, ["100 Girlfriends"])), [
            ("solo", "https://anime-pictures.net/"),
        ])

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

    def test_never_falls_back_to_unverified_legacy_wallpaper(self):
        with TemporaryDirectory() as directory, patch.object(detail_artwork, "_find", return_value=None):
            root = Path(directory)
            old = root / "detail-artwork" / "12.webp"
            old.parent.mkdir()
            old.write_bytes(b"unchecked artwork")
            self.assertIsNone(detail_artwork.get_artwork(root, {"id": 12, "name": "作品"}))
            self.assertEqual(old.read_bytes(), b"unchecked artwork")

    def test_recovers_missing_artwork_with_an_id_matched_alias(self):
        with TemporaryDirectory() as directory, patch.object(detail_artwork, "_find", return_value=b"image") as find:
            root = Path(directory)
            previous = root / "detail-artwork" / "v2" / "27364.webp"
            previous.parent.mkdir(parents=True)
            previous.write_bytes(b"")
            catalogue = root / "animeschedule" / "external-ids.json"
            catalogue.parent.mkdir()
            catalogue.write_text('[{"bgm_id":"27364","anime_planet_id":"hyouka"}]', encoding="utf-8")
            self.assertEqual(detail_artwork.get_artwork(root, {"id": 27364, "name": "氷菓"}, miss_hours=0), b"image")
            find.assert_called_once_with(["氷菓", "hyouka"])

    def test_keeps_previously_verified_positive_cache(self):
        with TemporaryDirectory() as directory, patch.object(detail_artwork, "_find") as find:
            root = Path(directory)
            previous = root / "detail-artwork" / "v2" / "12.webp"
            previous.parent.mkdir(parents=True)
            previous.write_bytes(b"verified")
            self.assertEqual(detail_artwork.get_artwork(root, {"id": 12, "name": "作品"}), b"verified")
            find.assert_not_called()

    def test_transliteration_does_not_allow_unrelated_partial_tags(self):
        self.assertTrue(detail_artwork._label_keys("Bungo Stray Dogs") & detail_artwork._label_keys("Bungou Stray Dogs"))
        self.assertFalse(detail_artwork._label_keys("Max Reijou Nano Ni") & detail_artwork._label_keys("Max"))

    def test_configured_miss_expiry_and_permanent_mode_use_existing_cache(self):
        anime = {"id": 12, "name": "作品"}
        with TemporaryDirectory() as directory, patch.object(
            detail_artwork, "_find", side_effect=[None, b"image"],
        ) as find:
            root = Path(directory)
            self.assertIsNone(detail_artwork.get_artwork(root, anime))
            cached = root / "detail-artwork" / detail_artwork.CACHE_VERSION / "12.webp"
            check_time = time.time() - 48 * 3600
            os.utime(cached, (check_time, check_time))
            self.assertIsNone(detail_artwork.get_artwork(root, anime))  # default 7 days
            self.assertIsNone(detail_artwork.get_artwork(root, anime, miss_hours=0))
            self.assertEqual(find.call_count, 1)
            self.assertEqual(detail_artwork.get_artwork(root, anime, miss_hours=24), b"image")
            self.assertEqual(detail_artwork.get_artwork(root, anime, miss_hours=1), b"image")
            self.assertEqual(find.call_count, 2)

    def test_unavailable_catalogues_do_not_create_a_permanent_miss(self):
        anime = {"id": 12, "name": "作品"}
        with TemporaryDirectory() as directory, patch.object(
            detail_artwork, "_find", side_effect=[detail_artwork.ArtworkCataloguesUnavailable, b"image"],
        ) as find:
            root = Path(directory)
            self.assertIsNone(detail_artwork.get_artwork(root, anime, miss_hours=0))
            cached = root / "detail-artwork" / detail_artwork.CACHE_VERSION / "12.webp"
            retry = cached.with_suffix(".retry")
            self.assertFalse(cached.exists())
            self.assertIsNone(detail_artwork.get_artwork(root, anime, miss_hours=0))
            self.assertEqual(find.call_count, 1)
            check_time = time.time() - 7 * 3600
            os.utime(retry, (check_time, check_time))
            self.assertEqual(detail_artwork.get_artwork(root, anime, miss_hours=0), b"image")
            self.assertFalse(retry.exists())

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
