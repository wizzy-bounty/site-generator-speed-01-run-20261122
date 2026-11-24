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

- Templates are compiled to native JS functions (codegen over the parsed
  node tree): loops and branches become real JS, path lookups become direct
  property reads on a prototype-chained scope object, and output accumulates
  in one shared chunk array per render — no tree-walking interpreter.
- Markdown renders in a single fused pass: every line is classified once by
  char codes, plain inline runs are found with native scans and escaped in
  bulk, and only markup characters are visited one by one.
- `slugify` skips Unicode normalisation for pure-ASCII text (NFKD is the
  identity there); pure helpers are memoised within each case.
- Front matter is parsed by line offsets; the body is one slice, never a
  split-and-rejoin.

## Verification

- Practice set: all 3 cases byte-identical to the oracle's expected output
  (also reproduced byte for byte by the kit's local grader).
- Differential fuzz against the reference build: 1,300+ mutated practice
  inputs plus a hand-built edge-case suite (template errors, front-matter
  refusals, slug collisions, link resolution, shadowing, include depth) —
  all identical.
- Fresh-process CPU on the practice set (the dev-phase timing method):
  about 1.9× faster than the house baseline measured beside it.

## License

MIT — see [LICENSE](LICENSE).
