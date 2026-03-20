# WP4 Native Output 手動確認チェックリスト

更新日: 2026-03-19
対象: WP4/M5 Native Output（shared + exclusive preview）

## 0. 前提

- [ ] Windows 環境で確認する
- [ ] 最新コードを取得済み
- [ ] `npm run win:build:all` が通る
- [ ] 排他プレビュー確認時は `AONSOKU_ENABLE_EXCLUSIVE_PREVIEW=1` を設定して起動する

## 1. ビルド確認

- [ ] `npm run lint` が通る
- [ ] `npm run build -- --emptyOutDir false` が通る
- [ ] `cd native/engine && cargo build` が通る
- [ ] `npm run electron:build` が通る
- [ ] `npm run build:unpack` が通る

## 2. Capability 表示確認

- [ ] Settings > Audio > Oversampling を開く
- [ ] Capability の Engine 表示が `CPU` のみ
- [ ] プレビュー未設定時は Output API 表示が `WASAPI 共有` のみ
- [ ] プレビュー設定時は Output API に `WASAPI 排他` も表示される

## 3. 再生確認（shared）

- [ ] Oversampling を ON にする
- [ ] Output API を `WASAPI 共有` に設定
- [ ] Song 再生開始でエラーなく再生できる
- [ ] 再生中の Pause/Resume/Seek が動く

## 4. モード確認（exclusive/asio）

- [ ] プレビュー未設定時に `WASAPI 排他` は選択不可、または即時エラーになる
- [ ] プレビュー設定時に `WASAPI 排他` は選択できる
- [ ] 排他利用中に別プロセスから排他設定を試すと `exclusive-device-busy` になる
- [ ] Output API を `ASIO` に変更したとき、即時にエラー扱いになる
- [ ] 「再生開始後に曖昧に失敗する」のではなく、モード設定時点で失敗が分かる

## 5. 回帰確認

- [ ] 通常再生（oversampling OFF）で曲再生できる
- [ ] 既存の player 基本操作（play/pause/next/prev）が壊れていない

## 6. 記録する項目

- [ ] 実施日
- [ ] 実施者
- [ ] 失敗した項目とログ抜粋
- [ ] 次アクション（コード修正 or 仕様更新）
