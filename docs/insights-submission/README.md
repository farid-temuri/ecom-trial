# Insights submission (staging)

This folder stages the BitGN architecture write-up before it is sent as a pull
request to [`bitgn/bitgn-architectures`](https://github.com/bitgn/bitgn-architectures).

## The file

- [`9QjKSV_ecom-agent-cited-sandbox.md`](9QjKSV_ecom-agent-cited-sandbox.md) — the
  post. Filename follows the repo convention `ACCOUNTID_architecture-name.md`
  (account `9QjKSV`).

## How to file the PR

1. Fork `bitgn/bitgn-architectures`.
2. Copy `9QjKSV_ecom-agent-cited-sandbox.md` into the `2026-05-30-ecom1/` folder of
   the fork (do **not** rename it).
3. Commit, push, open a PR against `bitgn/bitgn-architectures:main`, and notify
   Rinat for review.

On merge, the post appears under [Insights](https://bitgn.com/insights/) and the
leaderboard entry links to it.

## Frontmatter facts (verified from logs)

| Field | Value | Source |
|---|---|---|
| `run_ids` | `run-22RxPyYQ4dtnsaeKdXpRsJ6ce` | top-20 `bitgn/ecom1-prod` run = local `20260530-114102-65eb5b` |
| `model_names` | `xiaomi/mimo-v2.5-pro` | `run:start.modelId` |
| open-weights | eligible | only model is open-weight → badge derives from `model_names` |
| `source_code` | `https://github.com/farid-temuri/ecom-trial` | git remote |

## Notes / open items

- **Open-weights badge** is claimed on the basis that `xiaomi/mimo-v2.5-pro` is an
  approved open-weight model. If BitGN's approved-list says otherwise, drop the
  open-weight framing in the post (the model_names list is what the badge derives
  from).
- No `res/` images are included — the architecture diagram is an inline Mermaid
  block (renders on GitHub and the Insights site). Add a `res/` PNG if a static
  image is preferred.
