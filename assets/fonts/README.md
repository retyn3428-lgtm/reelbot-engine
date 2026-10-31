# Fonts bundled with ReelBot

The original variable TTF files are included so Pillow can measure captions consistently. Matching regular and bold static TTFs are also bundled: these are generated from the variable files with `fontTools` because FFmpeg/libass does not reliably select variable-font weights on every runner. Russian Cyrillic glyph coverage was checked locally.

- Inter variable font: `Inter[opsz,wght].ttf` — [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/inter); [license](https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt).
- Montserrat variable font: `Montserrat[wght].ttf` — [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/montserrat); [license](https://github.com/google/fonts/blob/main/ofl/montserrat/OFL.txt).
- Oswald variable font: `Oswald[wght].ttf` — [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/oswald); [license](https://github.com/google/fonts/blob/main/ofl/oswald/OFL.txt).

Each family is licensed under the SIL Open Font License 1.1. The original license files are retained next to the font files; the static instances are derivative font software and remain under the same license. No Reserved Font Name is listed in the included license notices. Google Fonts states that its fonts are open source and may be used in commercial products subject to their individual license conditions: [Google Fonts FAQ](https://developers.google.com/fonts/faq).
