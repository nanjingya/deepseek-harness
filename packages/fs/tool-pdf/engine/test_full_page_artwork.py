#!/usr/bin/env python3
"""Synthetic-page checks for uncaptioned full-page artwork detection."""

from __future__ import annotations

import unittest

from PIL import Image, ImageDraw

from pdf_wiki_parser import is_full_page_artwork


class FullPageArtworkTests(unittest.TestCase):
    def test_blank_page_with_binding_shadow_is_not_artwork(self) -> None:
        image = Image.new("RGB", (400, 560), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 8, 560), fill=(90, 90, 90))
        draw.point((200, 280), fill="black")
        self.assertFalse(is_full_page_artwork(image))

    def test_centered_logo_is_not_artwork(self) -> None:
        image = Image.new("RGB", (400, 560), "white")
        draw = ImageDraw.Draw(image)
        draw.ellipse((150, 220, 250, 320), outline=(220, 140, 90), width=8)
        draw.ellipse((170, 240, 230, 300), fill=(220, 140, 90))
        self.assertFalse(is_full_page_artwork(image))

    def test_dense_diagram_filling_the_page_is_artwork(self) -> None:
        image = Image.new("RGB", (400, 560), "white")
        draw = ImageDraw.Draw(image)
        for y in range(40, 520, 12):
            draw.line((30, y, 370, y), fill="black", width=2)
        for x in range(30, 370, 16):
            draw.line((x, 40, x, 520), fill="black", width=2)
        self.assertTrue(is_full_page_artwork(image))

    def test_sparse_line_drawing_spanning_the_page_is_artwork(self) -> None:
        image = Image.new("RGB", (400, 560), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((40, 50, 360, 510), outline="black", width=4)
        for offset in range(0, 280, 28):
            draw.line((40 + offset, 50, 40 + offset, 510), fill="black", width=2)
        self.assertTrue(is_full_page_artwork(image))


if __name__ == "__main__":
    unittest.main()
