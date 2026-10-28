"""Two-column PDF reproducing bullet items and indented paragraphs from the reported layouts."""
from pathlib import Path

out = Path(__file__).parent / "fixtures" / "reading" / "paragraph-layout.pdf"
out.parent.mkdir(parents=True, exist_ok=True)
stream = br"""BT /F2 14 Tf 48 752 Td (Paragraph and list layout regression) Tj ET
BT /F1 10 Tf 48 710 Td (\225) Tj /F2 10 Tf 12 0 Td (Closed-loop action sequences.) Tj /F1 10 Tf ( We combine) Tj ET
BT /F1 10 Tf 60 697 Td (the policy with ) Tj /F3 10 Tf (receding-horizon control) Tj ET
BT /F1 10 Tf 60 684 Td (to execute robust actions and preserve consistency.) Tj ET
BT /F1 10 Tf 48 666 Td (\225) Tj /F2 10 Tf 12 0 Td (Visual conditioning.) Tj /F1 10 Tf ( We encode observations) Tj ET
BT /F1 10 Tf 60 653 Td (as conditions instead of generating them jointly.) Tj ET
BT /F1 10 Tf 60 640 Td (This enables real-time action inference.) Tj ET
BT /F1 10 Tf 60 565 Td (Sequence prediction is often avoided in policy) Tj ET
BT /F1 10 Tf 50 552 Td (learning because high-dimensional sampling is hard.) Tj ET
BT /F1 10 Tf 50 539 Td (It is difficult to specify the number of modes.) Tj ET
BT /F1 10 Tf 60 520 Td (In contrast, DDPM scales well with dimensions) Tj ET
BT /F1 10 Tf 50 507 Td (without losing model expressiveness. It represents) Tj ET
BT /F1 10 Tf 50 494 Td (actions as a sequence and addresses these issues.) Tj ET
BT /F1 10 Tf 330 710 Td (Right column reference text for layout testing.) Tj ET
BT /F1 10 Tf 330 697 Td (The translation appears alongside the original.) Tj ET
BT /F1 10 Tf 330 684 Td (Paragraph boundaries should remain visible.) Tj ET
BT /F1 10 Tf 330 565 Td (Another right column paragraph for testing.) Tj ET
BT /F1 10 Tf 330 552 Td (Source indentation is preserved independently.) Tj ET
BT /F1 10 Tf 330 539 Td (List markers are restored by the renderer.) Tj ET
"""
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
]
pdf = bytearray(b"%PDF-1.4\n"); offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]: pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
out.write_bytes(pdf)
print(out)
