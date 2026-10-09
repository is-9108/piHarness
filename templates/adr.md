<!--
piHarness の ADR（重要な設計判断の記録）テンプレート。harness_record_decision が {{名前}} を埋めて <adrDir>/NNNN-<タイトル>.md に保存する。
プロジェクトで変えたいときは <workDir>/templates/adr.md（既定 .pi/harness/templates/adr.md）にコピーして編集する。
使える値: number title status date process workItem related supersedes context decision options positive negative revisit
値が空のときは「なし」になる（{{名前?}} と書くと空欄）。
-->
# ADR-{{number}}: {{title}}

| 項目 | 内容 |
|---|---|
| ステータス | {{status}} |
| 日付 | {{date}} |
| 記録したプロセス | {{process}} |
| 作業 | {{workItem}} |
| 関連 | {{related}} |
| 置き換え | {{supersedes}} |

## 背景・課題

{{context}}

## 決定

{{decision}}

## 検討した選択肢

{{options}}

## 結果・影響

**良い影響**

{{positive}}

**悪い影響・トレードオフ**

{{negative}}

## 見直す条件

{{revisit}}
