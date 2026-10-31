import unittest

import runner


class CaptionPositionTests(unittest.TestCase):
    def setUp(self):
        self.groups = [{
            "start": 0.2,
            "end": 1.8,
            "words": ["Я", "нашла", "способ", "показать", "результат."],
        }]

    def test_manual_top_and_bottom_positions_are_stable(self):
        self.assertEqual(runner.detect_caption_positions("unused.mp4", self.groups, "top"), [runner.CAPTION_ANCHORS["top"]])
        self.assertEqual(runner.detect_caption_positions("unused.mp4", self.groups, "bottom"), [runner.CAPTION_ANCHORS["bottom"]])

    def test_ass_uses_position_for_clean_style(self):
        ass = runner.make_ass(self.groups, "clean", positions=[(300, 900)])
        self.assertIn(r"\an5\pos(300,900)", ass)
        self.assertIn("PlayResX: 1080", ass)

    def test_ass_uses_position_for_shifted_card_and_text(self):
        ass = runner.make_ass(self.groups, "shifted", positions=[(780, 420)])
        self.assertIn(r"\pos(780,420)", ass)
        self.assertIn("Dialogue: 0,", ass)
        self.assertIn("Dialogue: 1,", ass)

    def test_ass_uses_position_for_echo_layers(self):
        ass = runner.make_ass(self.groups, "echo", positions=[(270, 1020)])
        self.assertIn(r"\an5\pos(270,996)", ass)
        self.assertIn(r"\an5\pos(270,1020)", ass)

    def test_ass_without_detected_position_keeps_existing_style_position(self):
        ass = runner.make_ass(self.groups, "clean", positions=[None])
        self.assertNotIn(r"\pos(0,0)", ass)
        self.assertIn("MarginV, Encoding", ass)

    def test_selected_font_and_plate_opacity_reach_ass(self):
        ass = runner.make_ass(self.groups, "shifted", plate_opacity=80, font_id="oswald")
        self.assertIn("Style: Base,Oswald,", ass)
        self.assertIn("\\1a&H33&", ass)  # 80% opaque => 20% ASS transparency.

    def test_karaoke_uses_whisper_word_boundaries(self):
        group = {"start": 0.0, "end": 1.2, "words": ["Мой", "хук", "работает"],
                 "wordTimes": [{"word": "Мой", "start": 0.0, "end": 0.25},
                               {"word": "хук", "start": 0.30, "end": 0.55},
                               {"word": "работает", "start": 0.60, "end": 1.2}]}
        ass = runner.make_ass([group], "karaoke_yellow")
        self.assertIn("Dialogue: 2,0:00:00.30,0:00:00.55,Base", ass)
        self.assertIn("\\1c&H4DD8FF&", ass)  # Yellow accent, converted to ASS BGR.
        self.assertIn("Style: Base,Montserrat,", ass)

    def test_glass_bar_uses_one_rounded_translucent_shape(self):
        ass = runner.make_ass(self.groups, "glass_bar", plate_opacity=50, font_id="inter")
        self.assertIn("Style: Base,Inter,", ass)
        self.assertIn("\\1a&H80&", ass)
        self.assertIn("\\p1\\bord0\\shad0", ass)


class CaptionEditTests(unittest.TestCase):
    def test_edit_changes_only_nearest_caption_and_keeps_timing(self):
        groups = [
            {"start": 0.0, "end": 1.8, "words": ["Первая", "фраза."]},
            {"start": 2.0, "end": 3.6, "words": ["Вторая", "фраза."]},
            {"start": 4.0, "end": 5.8, "words": ["Третья", "фраза."]},
        ]
        result = runner.apply_caption_edits(groups, [{"at": 2.7, "text": "Исправленный текст."}])
        self.assertEqual(result[1]["text"], "Исправленный текст.")
        self.assertEqual((result[1]["start"], result[1]["end"]), (2.0, 3.6))
        self.assertEqual(result[0]["words"], ["Первая", "фраза."])
        self.assertEqual(result[2]["words"], ["Третья", "фраза."])


class CameraAndFilterTests(unittest.TestCase):
    def test_camera_modes_disable_or_strengthen_zoom(self):
        groups = [{"start": 0.0, "end": 2.0, "words": ["Привет."]}]
        self.assertEqual(runner.zoom_expression(groups, None, 3.0, "none"), "1")
        regular = runner.zoom_expression(groups, None, 3.0, "standard")
        boosted = runner.zoom_expression(groups, None, 3.0, "boosted")
        self.assertIn("0.160", regular)
        self.assertIn("0.232", boosted)

    def test_every_documented_color_preset_has_an_ffmpeg_expression(self):
        expected = {"original", "clean", "peach", "soft", "cool", "film", "contrast", "bright", "warm"}
        self.assertEqual(set(runner.COLOR_FILTERS), expected)
        for preset in expected:
            self.assertTrue(runner.color_filter_expression(preset).startswith("eq="))
        self.assertEqual(runner.color_filter_expression("unknown"), runner.COLOR_FILTERS["original"])

    def test_filter_graph_points_libass_to_project_fonts(self):
        graph = runner.build_filter_graph([], "null", "/tmp/captions.ass", "/project/assets/fonts")
        self.assertIn("fontsdir='/project/assets/fonts'", graph)

    def test_speed_selection_is_limited_to_supported_values(self):
        with self.assertRaises(runner.UserError):
            runner.apply_speed("unused.mp4", 1.4, "/tmp")


class MediaCreditTests(unittest.TestCase):
    def test_commons_credit_message_contains_artist_license_and_source(self):
        sent = []
        original = runner.say
        runner.say = lambda chat, text: sent.append((chat, text))
        try:
            runner.send_media_credits(42, [
                {"sourceName": "Wikimedia Commons", "name": "Clip.mp4", "artist": "Jane Doe",
                 "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
                 "sourceUrl": "https://commons.wikimedia.org/wiki/File:Clip.mp4"},
                {"name": "my-own.gif", "artist": "Me"},
            ])
        finally:
            runner.say = original
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], 42)
        self.assertIn("Jane Doe", sent[0][1])
        self.assertIn("CC BY 4.0", sent[0][1])
        self.assertIn("https://commons.wikimedia.org/wiki/File:Clip.mp4", sent[0][1])
        self.assertNotIn("my-own.gif", sent[0][1])


class ScriptAssistantFallbackTests(unittest.TestCase):
    def test_script_without_ai_key_gives_safe_outline(self):
        original = runner.ANTHROPIC_KEY
        runner.ANTHROPIC_KEY = ""
        try:
            message = runner.script_with_ai("уход за волосами")
        finally:
            runner.ANTHROPIC_KEY = original
        self.assertIn("каркас", message)
        self.assertIn("Не добавляй цифры", message)
        self.assertIn("Instagram", message)


if __name__ == "__main__":
    unittest.main()
