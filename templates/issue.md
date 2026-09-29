<!--
piHarness の Issue 本文テンプレート。harness_create_issues が {{名前}} を埋めて登録する。
プロジェクトで変えたいときは <workDir>/templates/issue.md（既定 .pi/harness/templates/issue.md）にコピーして編集する。
使える値: title background inScope outOfScope acceptanceCriteria testNormal testEdge dependencies references notes size
値が空のときは「なし」になる（{{名前?}} と書くと空欄）。受け入れ条件の見出しは Issue の大きさの検査と実装フローで使うので残すこと。
-->
## 背景・目的

{{background}}

## スコープ

**やること**

{{inScope}}

**やらないこと**

{{outOfScope}}

## 受け入れ条件

{{acceptanceCriteria}}

## テスト観点

**正常系**

{{testNormal}}

**異常系・境界値**

{{testEdge}}

## 依存関係

{{dependencies}}

## 参照

{{references}}

## 補足

{{notes}}

---

規模: {{size}}（piHarness で作成）
