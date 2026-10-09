<!--
piHarness のドキュメント作成フローの PR 本文テンプレート。フロー完了時に {{名前}} を埋めて PR を作成する。
プロジェクトで変えたいときは <workDir>/templates/pr-docs.md にコピーして編集する。
使える値: title summary issue files changedFiles sources reviews reviewFocus limitations usage closes
summary / files / sources / reviewFocus / limitations は執筆レポート（doc-report.md）の同名の見出しから取る。changedFiles は git の差分から拡張が作る。
-->
## 概要

{{summary}}

## 対象

{{issue}}

## 作成・更新したドキュメント

{{files}}

**変更したファイル（git）**

{{changedFiles}}

## 確認した情報源

{{sources}}

## レビュー（piHarness）

{{reviews}}

## レビューで特に見てほしい点

{{reviewFocus}}

## 未確定事項・既知の制約

{{limitations}}

---

ドキュメントのみの変更です（piHarness のドキュメント作成フローで作成。テストは対象外）。

{{usage?}}

{{closes?}}
