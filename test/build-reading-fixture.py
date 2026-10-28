"""Small deterministic PDF with bold lead-in and a figure; no external dependencies."""
from pathlib import Path

out = Path(__file__).parent / "fixtures" / "reading" / "typography.pdf"
out.parent.mkdir(parents=True, exist_ok=True)
stream = b"""BT /F2 16 Tf 50 740 Td (Reading layout regression) Tj ET
BT /F2 10 Tf 50 690 Td (Important result.) Tj /F1 10 Tf ( Ordinary explanation.) Tj ET
BT /F1 10 Tf 50 676 Td (The body text should stay separate from the chart.) Tj ET
0.9 0.93 0.96 rg 50 350 230 230 re f
0 0 0 rg BT /F1 10 Tf 70 460 Td (AXIS LABEL) Tj ET
BT /F2 9 Tf 50 330 Td (Figure 1:) Tj /F1 9 Tf ( Measured performance.) Tj ET
BT /F1 10 Tf 50 290 Td (A separate paragraph below the figure.) Tj ET
"""
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
]
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
