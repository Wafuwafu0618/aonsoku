# Apple Music 受け入れテスト手動チェックリスト（Phase 6）

更新日: 2026-03-24  
対象: Apple Music 連携（Session実行方式）

## 0. 目的

以下の受け入れ観点を **手動で固定化** し、3連続で同じ結果を得られることを確認する。

- Sign-In 成功
- Library 取得（複数回）
- Search 結果表示
- Browse 表示
- 再起動後の継続性

## 1. 前提

- [ ] Desktop(Electron) 環境で実施
- [ ] Apple Music サブスクリプション有効な Apple ID を使用
- [ ] `npm run electron:dev` で起動できる
- [ ] 実施中は同一ネットワーク・同一Apple IDで通す

## 2. 実施ルール（固定）

- 1回の実施単位を「Run 1 / Run 2 / Run 3」とし、同一手順を繰り返す。
- 各 Run はアプリ起動直後から開始する（Run間で必ずアプリ再起動）。
- 失敗時はその場で `Diagnostics` の `Collect Debug Log` を取得して記録する。

## 3. 1Runあたりのチェック手順

### 3.1 Sign-In 成功

- [ ] Settings > Content > Apple Music を開く
- [ ] `Apple Music にサインイン` を押し、Apple IDで認証完了できる
- [ ] `Sign-In -> Initialize: 完了` まで進行状態が遷移する
- [ ] Connection が `Authorized` になる

### 3.2 Library 取得（複数回）

- [ ] `Account Library Check > Check` を3回連続で実行
- [ ] 3回ともエラートーストなしで完了
- [ ] Songs / Albums / Playlists が表示される（0固定にならない）

### 3.3 Search 結果表示

- [ ] Apple Musicページで検索を実行（推奨キーワード: `YOASOBI`, `Ado`, `Beatles` のいずれか）
- [ ] Songs セクションに結果が表示される
- [ ] Albums セクションに結果が表示される
- [ ] Playlists セクションに結果が表示される

### 3.4 Browse 表示

- [ ] `Load Browse` を実行
- [ ] New Releases が表示される
- [ ] Top Songs が表示される
- [ ] Top Albums が表示される
- [ ] Top Playlists が表示される

### 3.5 再起動後の継続性

- [ ] アプリを完全終了して再起動
- [ ] Connection が再確認できる（Initializeで成功する）
- [ ] Library Check が再取得できる
- [ ] Search / Browse が再度動作する

## 4. 記録テンプレート（Run別）

### 4.1 Run結果サマリ

| Check | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Sign-In 成功 |  |  |  |
| Library 3回連続成功 |  |  |  |
| Search 結果表示 |  |  |  |
| Browse 表示 |  |  |  |
| 再起動後の継続性 |  |  |  |

### 4.2 Run詳細（必要時）

| Run | 実施日時 | 失敗項目 | トースト文言 | Debug Log 取得有無 | 備考 |
|---|---|---|---|---|---|
| Run 1 |  |  |  |  |  |
| Run 2 |  |  |  |  |  |
| Run 3 |  |  |  |  |  |

## 5. 完了条件

- [ ] Run 1〜Run 3 の全チェックが PASS
- [ ] 3連続で同じ手順・同じ判定基準で再現できる

## 6. 失敗時の扱い

- [ ] 失敗したRun番号と手順番号を記録
- [ ] `Diagnostics > Collect Debug Log` を取得
- [ ] トースト文言と進行状態文言を記録
- [ ] 修正後は Run 1 からやり直し（3連続性を担保）
