<!--
piHarness の PR 本文テンプレート。実装フロー完了時に {{名前}} を埋めて PR を作成する。
プロジェクトで変えたいときは <workDir>/templates/pr.md にコピーして編集する。
使える値: title summary issue acceptance changes tests testChanges reviews specDecisions adrs deviations reviewFocus limitations usage closes
summary / acceptance / changes / deviations / reviewFocus / limitations は実装レポート（implementation.md）の同名の見出しから取る。
-->
## 概要

{{summary}}

## 関連 Issue

{{issue}}

## 受け入れ条件の充足

{{acceptance}}

## 変更内容

{{changes}}

## テスト

{{tests}}

## テストの変更（削除・スキップなど）

{{testChanges}}

## レビュー（piHarness）

{{reviews}}

## 仕様の確認（レビュー中にユーザーが決めたこと）

{{specDecisions}}

## 設計判断（ADR）

{{adrs}}

## プランからの逸脱

{{deviations}}

## レビューで特に見てほしい点

{{reviewFocus}}

## 既知の制約

{{limitations}}

---

{{usage?}}

{{closes?}}
