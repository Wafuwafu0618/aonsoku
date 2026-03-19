# WP5 実装土台ハンドオフ（2026-03-19）

## 1. 背景

- ローカル統合が進んだため、次段として高音質化（poly-sinc系）に着手する方針。
- 自動フォールバックは採用せず、失敗時は「停止 + ログ + UIアナウンス」に統一することで合意済み。

## 2. このセッションで確定した方針

- 初期プリセットは `poly-sinc-short-mp` / `poly-sinc-mp` / `poly-sinc-ext2`
- フィルタ命名は HQPlayer 互換（`poly-sinc-*`）
- 拡張性のため、`FilterSpec` と `PresetSpec` と `Capability` を分離
- 失敗時は自動降格しない（手動切替）

## 3. ここまでの反映済みドキュメント

- `docs/project-overall-flow.md`
  - フェーズ5の方針を更新済み（停止/通知/ログ）
- `docs/wp5-oversampling-architecture-plan.md`
  - 実装方針、初期プリセット、失敗時方針を記載済み

## 4. 実装の進捗（コード）

- 追加済み:
  - `src/oversampling/types.ts`
- 内容:
  - `OversamplingFilterId` / `OversamplingPresetId` / `OversamplingOutputApi`
  - `OversamplingEngine` / `OversamplingEnginePreference`
  - `OversamplingFilterSpec` / `OversamplingPresetSpec` / `OversamplingCapability`
  - `OversamplingSettingsValues`
  - `OversamplingResolveFailureCode` / `OversamplingResolveResult`
- 状態:
  - 「型定義のみ」追加済み
  - `registry` / `resolver` / `store統合` / `UI接続` は未着手

## 5. 次の実装タスク（再開用チェックリスト）

1. `src/oversampling/defaults.ts` を追加  
   - `DEFAULT_OVERSAMPLING_SETTINGS`（`enabled=false`, `presetId=poly-sinc-mp` など）
   - `DEFAULT_OVERSAMPLING_CAPABILITY`

2. `src/oversampling/registry.ts` を追加  
   - 初期3プリセットと対応フィルタ定義

3. `src/oversampling/resolver.ts` を追加  
   - `Preset + Capability -> ResolvedConfig`  
   - 失敗時は `ok: false`（自動降格なし）

4. `src/oversampling/index.ts` を追加  
   - 外部公開用エクスポート

5. `src/types/playerContext.ts` 更新  
   - oversampling 設定型を `IPlayerSettings` へ追加

6. `src/store/player.store.ts` 更新  
   - oversampling の初期値・setter追加
   - hooks追加（`useOversamplingState` / `useOversamplingActions` 想定）

7. 検証  
   - `npm run build`
   - `npm run lint`

## 6. 注意点

- `apply_patch` ツール呼び出しで以下エラーが断続発生:
  - `windows sandbox: setup refresh failed with status exit code: 1`
- そのため本セッションでは型定義の追加以降の編集を一時中断。
- ユーザーコメントどおり、ウィンドウ再作成後に再開する前提。
