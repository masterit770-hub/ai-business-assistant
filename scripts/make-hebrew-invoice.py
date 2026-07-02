#!/usr/bin/env python3
# Generate a REAL Hebrew business document (tax invoice) for the Hebrew-retrieval eval.
# Text is written in LOGICAL order (no bidi visual reshaping) so the PDF text layer that
# unpdf extracts is logical Hebrew — which is what a logical Hebrew query embeds/BM25-matches
# against. (Visual RTL correctness is irrelevant to a *retrieval* eval; the text layer is.)
# DejaVuSans carries Hebrew glyphs + reportlab embeds a ToUnicode map so extraction round-trips.
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from bidi.algorithm import get_display

# pdf.js (unpdf) extractText returns LOGICAL order from a VISUAL-ordered text layer. So we
# draw the bidi VISUAL form (get_display): logical Hebrew → visual → drawn → extraction
# reverses RTL runs back to LOGICAL. Net: a natural logical Hebrew query matches the doc.
def vis(s):
    return get_display(s)

pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
W, H = A4
c = canvas.Canvas("/tmp/hebrew-invoice.pdf", pagesize=A4)
# logical-order Hebrew lines (read right-to-left semantically; stored left-to-right in the stream)
lines = [
    ("חשבונית מס", 18),
    ("ספק: חברת אבן יסמין בעמ", 13),
    ("מספר חשבונית: INV-2026-0418", 13),
    ("תאריך: 18 באפריל 2026", 13),
    ("שירות: ייעוץ משפטי ובדיקת חוזים", 13),
    ("לקוח: מנהל תפעול ראשי", 13),
    ("סכום לפני מעמ: 45,128 שקל", 13),
    ("מעמ 17 אחוז: 7,672 שקל", 13),
    ("סכום לתשלום כולל מעמ: 52,800 שקל", 14),
    ("תנאי תשלום: התשלום יתבצע תוך שלושים יום ממועד קבלת החשבונית.", 11),
    ("חתימה: אבן יסמין, מנהלת כספים", 12),
]
y = H - 80
for text, size in lines:
    c.setFont("DejaVu", size)
    c.drawString(70, y, vis(text))
    y -= 32
c.showPage()
c.save()
print("wrote /tmp/hebrew-invoice.pdf")
