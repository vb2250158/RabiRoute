import unittest
from unittest.mock import patch
from rabiroute_tray.desktop_pet_media import foreground_media_evidence


class MediaEvidenceTest(unittest.TestCase):
    def test_background_audio_is_not_assigned_to_foreground_video(self):
        async def sessions():
            return [{"kind": "audio", "status": "playing", "title": "Song"},
                    {"kind": "video", "status": "playing", "title": "Episode 1"}]
        with patch("rabiroute_tray.desktop_pet_media._sessions", sessions):
            self.assertIsNone(foreground_media_evidence("Source code"))
            self.assertEqual(foreground_media_evidence("Episode 1 - Player")["kind"], "video")

    def test_missing_metadata_falls_back_without_blocking_capture(self):
        async def sessions():
            raise OSError("Unsupported")
        with patch("rabiroute_tray.desktop_pet_media._sessions", sessions):
            self.assertIsNone(foreground_media_evidence("Player"))
