"""Three pages for facing-page rendering: columns/list, rotated crop, OCR-only scan."""
from pathlib import Path

out = Path(__file__).parent / 'fixtures' / 'reading' / 'parallel.pdf'
out.parent.mkdir(parents=True, exist_ok=True)
streams = [br'''BT /B 16 Tf 44 742 Td (Layout comparison) Tj ET
BT /R 11 Tf 44 698 Td (\225 ) Tj /B 11 Tf (Closed-loop actions.) Tj /R 11 Tf ( Keep ) Tj /I 11 Tf (local feedback.) Tj ET
BT /R 11 Tf 55 682 Td (Measure how it changes predictions.) Tj ET
BT /R 11 Tf 44 657 Td (\225 ) Tj /B 11 Tf (Visual inputs.) Tj /R 11 Tf ( Encode each view.) Tj ET
BT /R 11 Tf 55 641 Td (Keep the image in its original position.) Tj ET
BT /R 11 Tf 333 698 Td (A separate control tests the assumptions.) Tj ET
BT /R 11 Tf 325 682 Td (The experiment compares two settings.) Tj ET
0.65 0.78 0.91 rg 44 380 218 160 re f
0 0 0 rg BT /R 12 Tf 57 450 Td (A / B) Tj ET
BT /R 9 Tf 44 365 Td (Figure 1: Comparison across two trials.) Tj ET
BT /I 15 Tf 332 439 Td (x = a + b) Tj ET
BT /R 11 Tf 44 84 Td (The estimate also depends on the) Tj ET
''', b'''BT /R 11 Tf 50 549 Td (sampling interval used in the experiment.) Tj ET
BT /R 11 Tf 50 457 Td (Errors are reported independently.) Tj ET
''', b'''0.92 0.92 0.92 rg 40 600 230 24 re f
0.10 0.13 0.17 rg 42 605 160 3 re f 42 612 121 3 re f
0.65 0.78 0.91 rg 42 350 200 170 re f
''']
fonts = b'/Resources << /Font << /R 6 0 R /B 7 0 R /I 8 0 R >> >>'
objs = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>']
for i in range(3):
    box = b'/MediaBox [0 0 612 792]' if i != 1 else b'/MediaBox [0 0 552 612] /CropBox [20 30 532 590] /Rotate 90'
    annots = [b' /Annots [12 0 R 13 0 R]', b'', b' /Annots [14 0 R]'][i]
    objs.append(b'<< /Type /Page /Parent 2 0 R ' + box + b' ' + fonts + annots + f' /Contents {9+i} 0 R >>'.encode())
for font in ['Times-Roman', 'Times-Bold', 'Times-Italic']:
    objs.append(f'<< /Type /Font /Subtype /Type1 /BaseFont /{font} /Encoding /WinAnsiEncoding >>'.encode())
for content in streams:
    objs.append(f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'endstream')
objs.extend([
    b'<< /Type /Annot /Subtype /Link /Rect [44 738 178 758] /Border [0 0 0] /Dest [4 0 R /XYZ 50 549 null] >>',
    b'<< /Type /Annot /Subtype /Link /Rect [333 696 450 709] /Border [0 0 0] /A << /S /URI /URI (https://example.org/reading) >> >>',
    b'<< /Type /Annot /Subtype /Square /Rect [250 700 271 714] /Border [0 0 1] /C [1 0 0] /F 4 >>'
])
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for i, obj in enumerate(objs, 1):
    offsets.append(len(pdf)); pdf.extend(f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n')
xref = len(pdf); pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
for off in offsets[1:]: pdf.extend(f'{off:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()); out.write_bytes(pdf)
