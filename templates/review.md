<!--
piHarness のレビュー記録テンプレート（review-N.md）。harness_record_review が {{名前}} を埋めて保存する。
プロジェクトで変えたいときは <workDir>/templates/review.md にコピーして編集する。
使える値: round mode target date verdict counts summary perspectives findings
指摘修正のセッションはこのファイルだけを見て直すので、findings は残すこと。
-->
# レビュー {{round}} 周目（{{mode}}）

| 項目 | 内容 |
|---|---|
| 対象 | {{target}} |
| 日時 | {{date}} |
| 判定 | {{verdict}} |
| 指摘数 | {{counts}} |

## 所見

{{summary}}

## 観点別の結果

{{perspectives}}

## 指摘

{{findings}}
