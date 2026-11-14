# Model comparison: ours (1164473) vs Aarne's (1164426)

Run on the UNO Q board, 14 Nov 2026, through each model's own ei-models-runner (`POST /api/image`).
Test set: 23 new warn_animal pictures (moose 7, roe deer 7, white-tailed deer 7, wild boar 2).
None of them is in `ei_upload/` or `raw/` (SHA-256 check). They are also in the untracked
`dataset/synthetic/warn_animal/`: don't train on them, or they stop being a test set.

Beacon rule: ours fires at warn_animal >= 0.70; Aarne's fires on any "Warn" box >= 0.5.

| | Ours (classifier, 160 px) | Aarne's (object detection, 320 px) | Ours on 4 crops |
|---|---|---|---|
| Deer/moose caught | 5 / 23 | 5 / 23 (4 at his app's 0.55) | 10 / 23 |
| Time per frame (median) | 67 ms | 342 ms | 318 ms |
| What the misses look like | mostly "no_animal" | 11 no box, 7 boxed as "Small" | |

- Both models catch animals that fill a good part of the frame and miss far-off ones. At 160 or
  320 px, a deer 100 m away is only a few pixels tall.
- False alarms are not measured: the test set has no small_animal or no_animal pictures.
- 23 pictures is a small sample: one picture is about 4 points.

Raw outputs: `out/ours`, `out/aarne`, `out/ours_tiles` (one JSON per picture).
