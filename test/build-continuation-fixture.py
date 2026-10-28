"""Two-page PDF with a paragraph interrupted by a figure and one by a page break."""
from pathlib import Path

out = Path(__file__).parent / "fixtures" / "reading" / "continuations.pdf"
out.parent.mkdir(parents=True, exist_ok=True)
streams = [b"""BT /F2 16 Tf 50 740 Td (Interrupted paragraph regression) Tj ET
BT /F2 10 Tf 50 700 Td (The network combines two feature representations to improve) Tj ET
0.9 0.93 0.96 rg 50 400 500 230 re f
0 0 0 rg BT /F1 10 Tf 70 510 Td (FIGURE LABEL) Tj ET
BT /F1 9 Tf 50 385 Td (Figure 1: Separate caption.) Tj ET
BT /F1 10 Tf 50 350 Td (the accuracy of its predictions on unseen samples.) Tj ET
BT /F2 12 Tf 50 240 Td (2 Page boundary) Tj ET
BT /F1 10 Tf 50 170 Td (The model minimizes a consistency objective while retaining) Tj ET
""", b"""BT /F1 10 Tf 50 700 Td (the original features needed for downstream prediction.) Tj ET
BT /F1 10 Tf 50 630 Td (This independent paragraph discusses a different experiment.) Tj ET
"""]
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 7 0 R >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
]
for stream in streams:
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream")
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
out.write_bytes(pdf)
print(out)
