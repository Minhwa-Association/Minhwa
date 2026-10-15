# Fonts for the receipt PDF (v17)

`MinhwaSansKR-Regular.ttf` / `MinhwaSansKR-Bold.ttf` are **Noto Sans KR** (SIL Open Font License 1.1,
© Google / Adobe — https://github.com/notofonts/noto-cjk), cut down to what a receipt needs and converted
to TrueType so pdf-lib can subset them into each PDF:

* kept: ASCII, Latin-1 and Latin Extended-A (Swedish å ä ö, French é …), general punctuation, currency,
  every Hangul syllable (U+AC00–D7A3) and jamo, CJK punctuation
* dropped: Hanja, kana, symbols, hinting, and all OpenType layout features (GSUB/GPOS) — pdf-lib only
  writes widths for glyphs reachable from the character map, so a feature that swaps in another glyph
  would print with the wrong width

Made with fontTools: `pyftsubset … --layout-features='' --drop-tables+=GSUB,GPOS,GDEF,BASE,vhea,vmtx,VORG`,
then CFF → TrueType with cu2qu, glyph records padded to 4 bytes (a short `loca` needs even lengths).
