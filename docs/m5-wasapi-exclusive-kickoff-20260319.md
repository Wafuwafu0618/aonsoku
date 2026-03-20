# M5 WASAPI排他 着手メモ（2026-03-19）

## この着手で入れた内容

- Native sidecar の `listDevices` 結果を renderer 側 capability に同期する土台を追加
- oversampling 設定UIで、capability 外の Engine / Output API を選択不可に変更
- `wasapi-exclusive` が有効化された場合に native backend 経路へ乗る条件を追加
- capability 生成ロジックを `src/oversampling/capability.ts` に分離
- 回帰テストを追加（`src/oversampling/capability.cy.ts`）
- sidecar で `wasapi-exclusive` を受け付け、モード切替時に排他ロックファイルで同時利用を防止
- `AONSOKU_ENABLE_EXCLUSIVE_PREVIEW=1` を設定した場合のみ、exclusive モードを有効化
- sidecar の `setOutputMode(wasapi-exclusive)` で Windows WASAPI API を使った exclusive open probe を実行
- exclusive 失敗時のエラー分類を詳細化（`exclusive-device-busy` / `exclusive-not-allowed` / `exclusive-format-unsupported` など）
- sidecar に WASAPI exclusive render path（`IAudioRenderClient`）のMVPを追加
- exclusive 時の `play/pause/seek/setLoop/setPlaybackRate/setVolume` が専用再生ワーカー経由で動作する土台を追加

## 現在の制約（重要）

- WASAPI exclusive 実再生は入ったが、MVPのためフォーマット対応は `PCM16 / Float32` のみ
- 失敗時イベントの詳細化（renderer向け `error` イベント連携）はまだ限定的
- 実機での「他アプリ音が混在しない」「長時間安定再生」の検証が未完了

## まだ未完了のM5本体

- デバイス列挙での mode別サポート精度改善（デバイスID指定を含む）
- exclusive 再生時の失敗イベント伝搬とリカバリ動作の強化
- 実機での「他アプリ音が混在しない」確認

## 次の実装タスク

1. Windows実機で exclusive 再生/停止/seek/loop/rate/volume を回帰確認
2. `listDevices` で mode別の実サポートを返却（必要なら device id 単位）
3. exclusive 失敗時の renderer 表示改善（`error` イベント詳細）
4. 長時間再生とデバイス切替の安定性検証
