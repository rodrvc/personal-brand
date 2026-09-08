# Script normalization

A TTS engine reads what it is given. Left raw, it spells out what should be
spoken, speaks what should be spelled, or silently drops a token — and the last
one is the dangerous one, because the audio still sounds fine.

Normalize in the script file itself, not in a synthesis wrapper, so what you
read is what gets spoken.

## Token shapes that break a TTS

Examples are **invented**; substitute the real ones. The third column is the
point — match the shape, not the literal.

| Raw | Written for the ear | The shape it stands for |
|---|---|---|
| `1.500.000` | `un millón quinientos mil` | large number with thousand separators |
| `12,5 %` | `doce coma cinco por ciento` | decimal and symbol |
| `ACME` | `a ce eme e` (or the expansion, if the audience needs it) | acronym read letter by letter |
| `v2.3.1` | `versión dos punto tres punto uno` | dotted identifier |
| `ref. 1.234-A` | `referencia mil doscientos treinta y cuatro A` | reference code with a suffix |
| `2019-2024` | `entre dos mil diecinueve y dos mil veinticuatro` | range, not a subtraction |
| `24/7` | `veinticuatro siete` | slash that is not a date |
| `3 m²` | `tres metros cuadrados` | unit with a superscript |

## Then listen to those passages specifically

Reading the audio's transcript back is not enough: the failure is in the
pronunciation, and only ears catch it. A dropped token is the worst case —
the sentence still scans, so nothing looks wrong.

A suspiciously short duration in the measure step is usually this: the engine
skipped a block it could not pronounce. Normalize, re-synthesize, re-measure.

## Where this bites twice

The casting samples are generated from a real script paragraph, so normalize
**before** casting. A candidate judged on un-normalized text is being judged
on how it fails, not on how it reads.
