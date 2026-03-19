# Native Output 実装ハンドオフ（タブ再起動用）

最終更新: 2026-03-19
対象: WP4/WP5（Rust sidecar + oversampling 接続）

## 1. いまの現在地（結論）

- ネイティブ再生の土台（Electron main/preload IPC + Rust sidecar + NativePlaybackBackend）は接続済み。
- song再生は条件付きで `native` backend を使うようになっている（`oversampling=true` かつ `outputApi=wasapi-shared`）。
- ただし実装実態はまだ **wasapi-shared 相当の暫定動作** が中心で、排他/ASIOは未実装。
- そのため UI/Capability 表示と sidecar の受け付け挙動にズレが残っている（後述）。

## 2. このセッションで確認できたこと

### ツール/実行環境

- `apply_patch` は成功する時と失敗する時があり不安定。
- 今回は `apply_patch` が2連続失敗（`windows sandbox: setup refresh failed with status exit code: 1`）。
- シェル実行環境は WSL ではなく Windows PowerShell 側。
  - `WSL_DISTRO_NAME=<empty>`
  - `wsl.exe -e ...` は `E_ACCESSDENIED`

### ビルド・静的検証

- `npm.cmd run lint`: 成功
- `npm.cmd run build -- --emptyOutDir false`: 成功（sandbox側は EPERM になりやすく、必要時は権限昇格実行）

## 3. 実装済み（主な変更）

- Electron IPCチャネル追加（native audio 系）
  - `electron/preload/types.ts`
  - `electron/preload/index.ts`
  - `electron/main/core/events.ts`
- sidecar管理クライアント追加
  - `electron/main/core/native-audio-sidecar.ts`
  - `electron/main/index.ts`（終了時 shutdown 呼び出し）
- Rust sidecar 実装（JSONL protocol + load/play/pause/seek/volume/loop/rate/dispose）
  - `native/engine/src/main.rs`
- native backend と backend factory 導入
  - `src/playback/backends/native-backend.ts`
  - `src/playback/backends/song-backend-factory.ts`
  - `src/playback/index.ts`
- AudioPlayer を pipeline/factory 化
  - `src/app/components/player/audio.tsx`
- oversampling の型/registry/resolver/store/UI を接続
  - `src/oversampling/*`
  - `src/store/player.store.ts`
  - `src/types/playerContext.ts`
  - `src/app/components/settings/pages/audio/oversampling.tsx`
  - `src/app/components/settings/pages/audio/index.tsx`
  - `src/i18n/locales/ja.json`

## 4. 残っているズレ（優先修正）

1. **Capability表示のズレ**
- 現状 `src/oversampling/defaults.ts` が `supportedOutputApis` に shared/exclusive/asio、`availableEngines` に cpu/gpu を出している。
- しかし現実の sidecar は shared中心で、exclusive/asio/gpu は未実装。
- 先に capability を実態に合わせる（暫定で shared + cpu）こと。

2. **setOutputMode の挙動ズレ**
- `native/engine/src/main.rs` の `setOutputMode` は exclusive/asio も受理して `ok` を返す。
- その後 `load/play/...` で `ensure_shared_output_mode` により失敗するため、ユーザー視点で不自然。
- 未実装モードは `setOutputMode` 時点で明示エラー返却に統一すること。

3. **listDevices のズレ**
- 現状 dummy で shared/exclusive/asio を全て返している。
- 未実装の間は shared のみ返す（または modeごとに `supported=false` を表現）方針に揃える。

## 5. 次タブでの再開手順（最短）

1. `apply_patch` 可否をテスト（失敗したらすぐ PowerShell 編集へ切替）
2. `src/oversampling/defaults.ts` を実態準拠に修正
   - `supportedOutputApis: ['wasapi-shared']`
   - `availableEngines: ['cpu']`
   - `maxTapCountByEngine` は `cpu` のみ
3. `native/engine/src/main.rs` を修正
   - `setOutputMode` で非sharedは `unsupported-output-mode` を返す
   - `listDevices` を shared実装準拠に整理
4. 検証
   - `npm.cmd run lint`
   - `npm.cmd run build -- --emptyOutDir false`
   - `cd native/engine; cargo build`
5. Windows実機確認（あなた側）
   - shared 再生OK
   - exclusive選択時に即エラー（曖昧に再生失敗しない）

## 6. 既知の運用ルール（このスレで合意済み）

- `apply_patch` が複数回連続失敗したら作業中断し、再起動を依頼する。
- ただし作業継続が必要な場合は PowerShell 直接編集で進める。
- Windows向け最終バイナリ生成は Windows 環境で実施する（`build:unpack` / `build:win`）。

## 7. 補足

- 「排他モードなのに他アプリ音が聞こえる」問題は、現時点では排他経路が未実装であることと整合。
- 本当に解決するには M5（WASAPI排他の実装）まで進める必要がある。

## 8. 追記（2026-03-19）

- 4章で列挙した暫定ズレ（Capability表示 / `setOutputMode` / `listDevices`）は修正済み。
- 実機確認の運用は `docs/wp4-native-output-manual-checklist.md` を使用する。

