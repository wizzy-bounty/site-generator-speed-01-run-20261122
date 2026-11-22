# site-generator-speed-01-run-20261122

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wizzy-bounty/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wizzy-bounty/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 — an entry for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
competition ("Build a static site faster").

## What it does

`solve.js` reimplements makefun-site 1.0.0's build from its stated rules —
front matter, its own Markdown subset, its template dialect, slug rule and
build report — and returns the same output tree, byte for byte, for every
site. It is a single dependency-free ES module; `main.ts` is the driver the
harness runs (reads `/input/cases.json`, writes `/output/answers.json`).

## How it is faster

- Markdown inline rendering finds the next markup character with C++ scans
  and escapes plain-text runs in bulk, instead of one regex call per
  character.
- The block lexer renders in a single pass with cheap first-character
  dispatch instead of a regex per line.
- `slugify` / `longDate` / template parses are memoised (pure functions of
  their inputs).
- The template renderer appends into one shared chunk array instead of
  building a string per node.
- Front matter returns the body as a substring instead of split + re-join.

## Verification

- Practice set: all 3 cases byte-identical to the oracle's expected output.
- Differential fuzz: 141 freshly drawn generator cases (47 seeds), all
  identical to the oracle.
- Fresh-process CPU on the practice set: ~2.3× faster than the house
  baseline (interleaved A/B, median of 7 runs each).

## License

MIT — see [LICENSE](LICENSE).
