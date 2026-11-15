[![competition](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ruri08219/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ruri08219/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# Make Markdown rendering faster

A fast, dependency-free Markdown renderer written from scratch in plain
JavaScript. `parse(markdown)` returns exactly the HTML that marked 18.1.3
renders with its default options (GFM on, breaks off) — byte for byte on
every CommonMark 0.31.2 and GFM 0.29 spec example — while spending less CPU
than marked itself.

Built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02).

## Layout

- `parse.js` — the renderer: a line-based block parser (open-container
  stack, leaf blocks) plus a single-pass inline parser on a delimiter
  stack. No dependencies, no state kept between calls.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  renders each case alone with `parse`, writes `/output/html.json`.
