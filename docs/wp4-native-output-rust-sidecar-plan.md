# WP4 ネイティブ出力実装計画（Rust sidecar）

最終更新: 2026-03-19

## 1. 目的

- Aonsoku の再生経路を WebAudio 依存から分離し、Windows ネイティブ出力（WASAPI 共有/排他）へ移行する
- 排他時に OS レベルで他アプリ音を混在させない
- 後続の DSP（オーバーサンプリング）をネイティブ経路へ接続できる土台を作る

## 2. 現在の状態（できる/できない）

### できる

- `HTMLAudioElement + WebAudio` による再生
- WebAudio 上での FIR フィルタ挿入（Convolver）
- UI で `outputApi` を選択し、resolver で整合性チェック

### できない

- WASAPI 共有/排他/ASIO への実出力切替
- 排他モード時の他アプリ音遮断
- ネイティブ出力経路での DSP チェーン

## 3. 採用方針

- 再生エンジンは **Rust sidecar（別プロセス）** で実装する
- Electron main が sidecar を管理し、renderer とは IPC で接続する
- 既存 `PlaybackBackend` 抽象は維持し、`internal` と `native` を切替可能にする

## 4. 目標アーキテクチャ

`Renderer(AudioPlayer) -> PlaybackBackend(native) -> preload IPC -> Electron main -> Rust sidecar -> WASAPI`

責務:

- renderer: UI 状態・再生操作・エラー表示
- preload/main: プロセス管理、IPC ルーティング、イベント中継
- sidecar: decode / resample / output / device 制御

## 5. IPC 契約（v1）

コマンド:

- `initialize`（起動確認・バージョン）
- `listDevices`
- `setOutputMode`（`wasapi-shared` / `wasapi-exclusive`）
- `load`（source URL/path, metadata）
- `play`
- `pause`
- `seek`
- `setVolume`
- `setLoop`
- `setPlaybackRate`（v1 で未対応なら `unsupported` を返す）
- `dispose`

イベント:

- `ready`
- `loadedmetadata`（duration）
- `timeupdate`（currentTime）
- `play`
- `pause`
- `ended`
- `error`（code, message, details）
- `deviceChanged`

エラー方針:

- 失敗は必ず `error` イベントで返す
- 自動降格はしない（停止 + 通知 + ログ）

## 6. マイルストン

### M1. 契約固定（1-2日）

- `desktop-contract` / `preload/types` / `preload/index` に native audio API 追加
- Electron main に IPC チャネル追加
- 完了条件: renderer から呼べる型付き API が確定

### M2. Sidecar 基盤（2-3日）

- `native/engine`（Rust crate）新規作成
- JSON line protocol（stdin/stdout）実装
- Electron main で sidecar spawn/再起動/終了処理
- 完了条件: `initialize` と `listDevices` 往復成功

### M3. NativePlaybackBackend 導入（2-3日）

- `src/playback/backends/native-backend.ts` 追加
- `AudioPlayer` の backend 生成を factory 化して `internal/native` 切替
- 完了条件: 既存 UI 操作で native backend 経由呼び出しが通る

### M4. WASAPI 共有（4-7日）

- sidecar で decode + shared output 実装
- `load/play/pause/seek/volume` の基本再生完了
- 完了条件: 共有モードで安定再生、既存 player 回帰なし

### M5. WASAPI 排他（3-5日）

- device lock と排他初期化
- 失敗時は `error` で停止（自動降格なし）
- 完了条件: 排他時に他アプリ音が混在しない

### M6. DSP 接続ポイント（3-5日）

- `decode -> dsp slot -> output` を sidecar 内で構成
- 現在の WebAudio DSP は fallback 経路へ限定
- 完了条件: ネイティブ経路で DSP 有効化/無効化が可能

### M7. ASIO（任意後続、3-6日）

- ドライバ依存が強いため別マイルストンとして分離
- 完了条件: 対応デバイスで再生と安定停止が可能

## 7. 実装順序のガード

- `WASAPI排他` UI を有効化するのは M5 完了後
- `ASIO` UI を有効化するのは M7 完了後
- 未実装モードは UI 選択不可（表示もしくは disabled）にする

## 8. テスト計画

自動:

- unit: IPC message validation, backend state machine
- integration: main <-> sidecar command/event round trip

手動（Windows 実機）:

- 共有: 再生/シーク/曲送り/連続再生
- 排他: 他アプリ同時再生時のミキシング有無
- 排他: デバイス切替/再接続時の復帰
- 失敗時: 停止 + UI 通知 + ログ

## 9. 主要リスクと対策

- sidecar クラッシュ
  - 対策: main 側 watchdog + 再起動 + renderer へ状態通知
- 排他初期化失敗（デバイス占有）
  - 対策: 明示エラー返却、手動再試行導線
- ASIO 依存差異
  - 対策: M7 分離、WASAPI を先に完成

## 10. 直近の着手タスク（この計画の次）

1. M1 の IPC 型とチャネル追加
2. sidecar 起動管理クラス（main）追加
3. `native-backend.ts` の最小骨組み追加（ダミー実装）

