"""Rebuild the print fonts from pinned Noto Serif SC, Noto Sans SC and STIX Two Text sources.

Usage: python3 scripts/build-paper-fonts.py /path/to/source-directory
See NOTICE.md for the input filenames and revisions. Requires fontTools and
Brotli. Normal builds use the checked-in WOFF2 files.
"""
import hashlib
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

OUTPUT = Path(__file__).resolve().parents[1] / "addon/content/lib/paper-fonts"
HASHES = {
    "NotoSansSC.ttf": "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    "NotoSerifSC.ttf": "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9",
    "STIXTwoText.ttf": "7962b8b7811e6a896c9a91a0bccbb5241047770eb24d4997c5cb5fe21d5c0df2",
    "STIXTwoText-Italic.ttf": "88c0e2e316eaff56eddc9e51e4850317e2a1e490bbf758b2dec4793aedba9c74",
}


def read_font(directory, name):
    path = directory / name
    if hashlib.sha256(path.read_bytes()).hexdigest() != HASHES[name]:
        raise ValueError(f"Unexpected source revision for {name}, see NOTICE.md")
    return TTFont(path, recalcTimestamp=False)


def chinese_characters():
    # All 6,763 GB 2312 ideographs, plus Chinese typesetting punctuation.
    han = set()
    for row in range(0xB0, 0xF8):
        for col in range(0xA1, 0xFF):
            han.update(map(ord, bytes([row, col]).decode("gb2312", errors="ignore")))
    return han | set(range(0x3000, 0x3040)) | set(range(0xFF01, 0xFF61)) | set(map(ord, "‘’“”…·"))


def write_face(font, family, style, weight, filename):
    # Gecko prints static faces as selectable text. Some native print backends
    # outline variable-font runs even when the screen renders them correctly.
    face = instantiateVariableFont(font, {"wght": weight}, updateFontNames=False)
    face.recalcTimestamp = False
    ps_name = family.replace(" ", "") + "-" + style.replace(" ", "")
    names = {1: family, 2: style, 3: ps_name + " " + face["name"].getDebugName(5),
             4: family + " " + style, 6: ps_name, 16: family, 17: style}
    for record in face["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    bold = "Bold" in style
    italic = "Italic" in style
    flags = (0x20 if bold else 0) | (1 if italic else 0) | (0x40 if not bold and not italic else 0)
    face["OS/2"].fsSelection = (face["OS/2"].fsSelection & ~0x61) | flags
    face["head"].macStyle = (face["head"].macStyle & ~3) | int(bold) | (int(italic) << 1)
    face.flavor = "woff2"
    face.save(OUTPUT / filename)


def build(directory):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    ideographs = chinese_characters()
    for source, family, name, chars, normal, bold in [
        ("NotoSerifSC.ttf", "DeepRead Song", "song", ideographs, 450, 680),
        ("NotoSansSC.ttf", "DeepRead Hei", "hei", ideographs | set(range(0x20, 0x180)), 400, 700),
    ]:
        font = read_font(directory, source)
        options = subset.Options()
        options.name_IDs = ["*"]  # Preserve original copyright and license records.
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=chars)
        subsetter.subset(font)
        write_face(font, family, "Regular", normal, name + "-text.woff2")
        write_face(font, family, "Bold", bold, name + "-bold.woff2")
    for source, regular, bold in [("STIXTwoText.ttf", "Regular", "Bold"),
                                   ("STIXTwoText-Italic.ttf", "Italic", "Bold Italic")]:
        roman = read_font(directory, source)
        for style, weight in [(regular, 400), (bold, 700)]:
            write_face(roman, "DeepRead Roman", style, weight, "roman-" + style.lower().replace(" ", "-") + ".woff2")


if __name__ == "__main__":
    build(Path(sys.argv[1]))
