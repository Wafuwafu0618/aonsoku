# WP3.5 手動デバッグチェックリスト

更新日: 2026-03-19

## 0. 事前準備

- [ ] アプリを起動する（`npm run electron:dev` または開発ビルド）
- [ ] Settings > Content > ローカルライブラリ 画面にアクセスできること
- [ ] 必要なら Local テスト用フォルダ（数十〜数百曲）を用意

## 1. Source フィルタ基本動作（Songs）

- [ ] `/songs` を開く
- [ ] 検索バー左に Source ドロップダウンが表示される
- [ ] `All Sources / Navidrome / Local Library` の3項目が表示される
- [ ] 切り替え時にリスト表示が即時更新される

## 2. URL パラメータ連動

- [ ] `Navidrome` 選択で `?source=navidrome` になる
- [ ] `Local` 選択で `?source=local` になる
- [ ] `All` 選択で `?source=all` もしくは `source` なしになる
- [ ] リロード後も選択状態が維持される

## 3. ローカルライブラリスキャン

- [ ] Settings > Content > ローカルライブラリでフォルダ追加できる
- [ ] 追加したフォルダが一覧表示される
- [ ] 手動スキャン開始で進捗が更新される
- [ ] スキャン完了後、最終スキャン時刻が更新される

## 4. Local フィルタ表示と再生

- [ ] `?source=local` でローカル曲のみ表示される
- [ ] タイトル/アーティスト/アルバムが表示される
- [ ] 曲クリックで再生開始する
- [ ] Next/Prev でキュー遷移できる

## 5. All Sources 統合表示

- [ ] `?source=all` で Navidrome + Local が混在表示される
- [ ] ページングで追加読込しても重複が目立たない
- [ ] 件数表示がフィルタ条件に応じて妥当

## 6. 検索動作

- [ ] キーワード検索時に `All` は両ソースからヒットする
- [ ] `Navidrome` は Navidrome のみヒットする
- [ ] `Local` は Local のみヒットする
- [ ] フィルタ切り替え後も検索語が意図どおり効く

## 7. パフォーマンス観点

- [ ] Local 100曲以上でスクロールが極端に重くならない
- [ ] `All ↔ Navidrome ↔ Local` を素早く切り替えても固まらない
- [ ] 追加読込時のローディングが破綻しない

## 8. エラーハンドリング

- [ ] Local 0曲状態で `?source=local` を開くと空表示が正しく出る
- [ ] 読み取り不能ファイルがあってもスキャン全体が停止しない
- [ ] IndexedDB 初期化失敗時にクラッシュしない

## 9. 回帰確認

- [ ] `npm run lint` が通る
- [ ] `npm run build -- --emptyOutDir false` が通る
- [ ] `npm run test -- --spec src/app/components/player/player.cy.tsx` が通る

## 10. 記録しておく項目

- [ ] 再現した不具合（手順/期待結果/実結果）
- [ ] 体感性能（特に Local 100+、可能なら 1,000+）
- [ ] 次の改善候補（WP3.6以降に送る項目）

## 11. Albums（追加）

- [ ] `/albums` を開き、Source ドロップダウンが表示される
- [ ] `?source=local` でローカル由来アルバムのみ表示される
- [ ] `?source=navidrome` でNavidrome由来アルバムのみ表示される
- [ ] `?source=all` でNavidrome + Local が混在表示される
- [ ] ローカルアルバムカードの再生ボタンで曲キュー再生が開始される
- [ ] ローカルアルバム詳細で曲一覧が表示され、クリック再生できる
- [ ] ローカルアルバム詳細でNavidrome専用操作（Like/Options）が出ない
- [ ] ローカルアルバム詳細から「同アーティスト他アルバム」「同ジャンル」のNavidrome依存ブロックが表示されない
- [ ] Albums検索（filter=search）で `source=local` / `source=all` が意図どおり機能する

## 12. Artists（追加）

- [ ] `/artists` で Source ドロップダウンが表示される
- [ ] `?source=local` でローカル由来アーティストのみ表示される
- [ ] `?source=navidrome` でNavidrome由来アーティストのみ表示される
- [ ] `?source=all` でNavidrome + Local が混在表示される
- [ ] ローカルアーティストカードの再生ボタンで曲キュー再生が開始される
- [ ] ローカルアーティスト詳細で Top Songs が表示され、クリック再生できる
- [ ] ローカルアーティスト詳細でNavidrome専用操作（Like/Options）が出ない
- [ ] ローカルアーティスト詳細の関連アーティスト表示が抑制される
- [ ] ローカルアーティスト詳細から「全曲表示」遷移時に `source=local` が維持される
