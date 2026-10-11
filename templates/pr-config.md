<!--
piHarness の設定変更フローの PR 本文テンプレート。フロー完了時に {{名前}} を埋めて PR を作成する。
プロジェクトで変えたいときは <workDir>/templates/pr-config.md にコピーして編集する。
使える値: title summary issue changes approvedFiles changedFiles impact rollback approval usage closes
summary / changes / impact / rollback は変更の計画（change-plan.md）の「目的」「変更内容」「影響範囲」「戻し方」から取る。
-->
## 目的

{{summary}}

## 対象

{{issue}}

## 変更内容

{{changes}}

## 変更したファイル

**計画で承認したファイル**

{{approvedFiles}}

**実際に変更したファイル（git）**

{{changedFiles}}

## 影響範囲

{{impact}}

## 戻し方

{{rollback}}

## 承認

{{approval}}

---

設定ファイルだけの変更です（piHarness の設定変更フローで作成。テスト・レビューは行わず、変更の計画をユーザーが承認しています）。

{{usage?}}

{{closes?}}
