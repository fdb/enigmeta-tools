# /// script
# requires-python = ">=3.10"
# dependencies = ["reportlab", "pillow"]
# ///
"""Generate a test PDF with an embedded JPEG image, a lossless PNG image, and an
embedded TrueType font, for exercising the PDF asset extractor."""

import io
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image

OUT = "scripts/test.pdf"

# Embed a TrueType font (reportlab subsets it as a FontFile2 stream).
pdfmetrics.registerFont(TTFont("TestArial", "/System/Library/Fonts/Supplemental/Arial.ttf"))

# A JPEG image -> DCTDecode in the PDF.
jpg = Image.new("RGB", (240, 160))
for y in range(160):
    for x in range(240):
        jpg.putpixel((x, y), (x % 256, y % 256, (x * y) % 256))
jpg_buf = io.BytesIO()
jpg.save(jpg_buf, format="JPEG", quality=85)
jpg_buf.seek(0)

# A lossless RGB image -> FlateDecode in the PDF (reconstructed to PNG).
png = Image.new("RGB", (120, 90), (200, 40, 90))
for x in range(120):
    png.putpixel((x, 0), (0, 0, 0))
png_buf = io.BytesIO()
png.save(png_buf, format="PNG")
png_buf.seek(0)

c = canvas.Canvas(OUT, pagesize=A4)
c.setFont("TestArial", 32)
c.drawString(72, 720, "Embedded font sample — Ag 123")
c.drawImage(ImageReader(jpg_buf), 72, 480, width=240, height=160)
c.drawImage(ImageReader(png_buf), 72, 360, width=120, height=90)
c.showPage()
c.save()
print(f"wrote {OUT}")
