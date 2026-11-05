"""Deterministic PDF with citation and figure references for local lookup tests."""
from pathlib import Path

out = Path(__file__).parent / "fixtures" / "reading" / "lookup.pdf"
out.parent.mkdir(parents=True, exist_ok=True)
stream = b"""BT /F2 16 Tf 50 740 Td (Reference lookup regression) Tj ET
BT /F1 12 Tf 50 690 Td (See [1] and Fig. 1 for the supporting experiment.) Tj ET
BT /F1 12 Tf 50 670 Td (Return to the original claim after checking the evidence.) Tj ET
0.9 0.93 0.96 rg 50 350 230 230 re f
0 0 0 rg BT /F1 10 Tf 70 460 Td (EXPERIMENT) Tj ET
BT /F2 9 Tf 50 330 Td (Figure 1:) Tj /F1 9 Tf ( Measured performance.) Tj ET
BT /F1 10 Tf 50 280 Td ([1] Author. A complete title for exact verification. 2026.) Tj ET
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
