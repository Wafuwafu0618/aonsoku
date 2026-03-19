# WP4 Native Output 手動確認チェックリスト

更新日: 2026-03-19
対象: WP4 Native Output（暫定: `wasapi-shared` のみ）

## 0. 前提

- [ ] Windows 環境で確認する
- [ ] 最新コードを取得済み
- [ ] `npm run win:build:all` が通る

## 1. ビルド確認

- [ ] `npm run lint` が通る
- [ ] `npm run build -- --emptyOutDir false` が通る
- [ ] `cd native/engine && cargo build` が通る
- [ ] `npm run electron:build` が通る
- [ ] `npm run build:unpack` が通る

## 2. Capability 表示確認

- [ ] Settings > Audio > Oversampling を開く
- [ ] Capability の Engine 表示が `CPU` のみ
- [ ] Capability の Output API 表示が `WASAPI 共有` のみ

## 3. 再生確認（shared）

- [ ] Oversampling を ON にする
- [ ] Output API を `WASAPI 共有` に設定
- [ ] Song 再生開始でエラーなく再生できる
- [ ] 再生中の Pause/Resume/Seek が動く

## 4. 未実装モード確認（exclusive/asio）

- [ ] Output API を `WASAPI 排他` に変更したとき、即時にエラー扱いになる
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
