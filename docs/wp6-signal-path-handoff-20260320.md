# WP6 Signal Path 引き継ぎメモ

最終更新: 2026-03-20

## 1. 目的

- Roon の Signal Path 相当UIを Aonsoku に追加する
- まず M1（静的UI）を実装し、次に M2（実データ接続）へ進む

参照:
- Roon Help: https://help.roonlabs.com/portal/en/kb/articles/signal-path#Lossless_Signal_Path_Example
- ユーザー共有スクリーンショット（Signal path: Lossless / 縦パイプライン）

## 2. 現在の実装状況

### M1（完了）

- メディアコントロール群の左側に Signal Path ボタン（Sparkles アイコン）を追加
- ボタン押下で Popover 表示（縦パイプライン）
- ステージは静的4段:
  - Source
  - Engine
  - DSP
  - Output
- 表示テキストは i18n キー経由（日本語辞書に追加済み）
- Cypress コンポーネントテストを1本追加

## 3. 変更ファイル（Signal Path M1）

- `src/app/components/player/signal-path-button.tsx`（新規）
- `src/app/components/player/controls.tsx`（Signal Pathボタンを左側へ差し込み）
- `src/i18n/locales/ja.json`（`player.tooltips.signalPath` + `player.signalPath.*`）
- `src/app/components/player/player.cy.tsx`（popover表示テスト追加）

## 4. Cypress 周辺（今回の論点）

このセッション中に `Failed to fetch dynamically imported module: /__cypress/src/cypress/support/component.tsx` が継続発生。

その対策として、以下の調整が入っている:

- `cypress.config.ts`
  - `supportFile: 'src/cypress/support/component.tsx'`
  - `devServer.viteConfig` を `mergeConfig(viteConfig, { base: '/' })` で上書き
- `src/cypress/support/component.tsx` / `src/cypress/support/commands.ts` を新設
- 既存 `cypress/support/component.tsx` / `cypress/support/commands.ts` も相対import化

ユーザー報告:
- 「こっちで治した」とのこと（ローカルで修正済み）

注意:
- Cypress設定は揺れた経緯があるため、新ウィンドウで最初に現在の実ファイル内容を再確認すること

## 5. 次タスク（M2: 実データ接続）

### 5.1 目標

静的表示をやめて、現在の再生状態から Signal Path を組み立てる。

### 5.2 実装方針

- `buildSignalPath`（または同等の selector/helper）を追加
- 最低限この情報を接続:
  - Source: 曲フォーマット（sample rate / bit depth / channels / source）
  - Engine: native / internal などの backend
  - DSP: oversampling有効/無効、preset、target sample rate
  - Output: wasapi-exclusive / wasapi-shared、fallback有無
- Signal Path ヘッダの `Lossless / Enhanced / Lossy / Warning` を状態で切替

### 5.3 仕様メモ（現時点の合意）

- `wasapi-shared` は OS ミキサー経由のため lossless 経路扱いにしない
- `wasapi-exclusive` を主経路として表示
- oversampling 有効時は DSP ステージに反映

## 6. 推奨作業順（新ウィンドウ）

1. Cypress設定の現物確認（`cypress.config.ts`, `cypress/support/*`, `src/cypress/support/*`）
2. M1表示が現状崩れていないかを確認
3. `buildSignalPath` 実装
4. `signal-path-button.tsx` を静的配列から動的入力へ差し替え
5. テスト追加/更新（ステージ内容の動的表示）

## 7. 実行コマンド（Windows PowerShell）

```powershell
Set-Location C:\aonsoku
npm run lint -- src/app/components/player/controls.tsx src/app/components/player/signal-path-button.tsx src/app/components/player/player.cy.tsx src/i18n/locales/ja.json cypress.config.ts cypress/support/component.tsx cypress/support/commands.ts src/cypress/support/component.tsx src/cypress/support/commands.ts
npm run test -- --spec src/app/components/player/player.cy.tsx
```

キャッシュクリアが必要な場合:

```powershell
Remove-Item -Recurse -Force .\node_modules\.vite -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\node_modules\.cache -ErrorAction SilentlyContinue
```

## 8. 補足

- リポジトリ全体は他タスクの差分が非常に多い。Signal Path 作業では対象ファイルを限定して扱うこと。
- この引き継ぎ時点ではコミット未実施。
