# WP3.5 デバッグ要件一覧

> 更新メモ（2026-03-19）
> - ローカルライブラリの登録・スキャンは、現在は設定画面（Content > ローカルライブラリ）から実行可能です。
> - 以前の「DevTools Consoleで手動スキャン実行」手順は補助的な確認方法として扱ってください。

## 実装概要

Phase 3: WP3.5 - ソースフィルター統合が完了しました。

### 変更されたファイル
1. `src/utils/albumsFilter.ts` - SourceFilter enumを追加
2. `src/app/components/search/source-filter.tsx` - 新規作成（ドロップダウンコンポーネント）
3. `src/app/pages/songs/songlist.tsx` - SourceFilterComponentを統合
4. `src/queries/songs.ts` - sourceパラメータ対応
5. `src/local-library/index.ts` - repositoryエクスポートを追加
6. `src/i18n/locales/en.json` - 翻訳キーを追加

## デバッグ要件

### 1. 基本機能テスト

#### 1.1 UI表示確認
- [ ] Songsページ（`/songs`）を開く
- [ ] 検索バーの左側に「All Sources」ドロップダウンが表示されること
- [ ] ドロップダウンをクリックして「All Sources」「Navidrome」「Local Library」の3項目が表示されること
- [ ] 各項目を選択したときにUIが即座に更新されること

#### 1.2 URLパラメータ連携
- [ ] 「Navidrome」を選択するとURLが `?source=navidrome` に変更されること
- [ ] 「Local」を選択するとURLが `?source=local` に変更されること
- [ ] 「All」を選択するとURLから `source` パラメータが削除されること（または `?source=all`）
- [ ] ページをリロードしても選択したフィルターが維持されること

#### 1.3 Navidromeフィルタリング
- [ ] `?source=navidrome` を選択したとき、Navidromeからのみ曲が表示されること
- [ ] 曲リストが正常に読み込まれること（無限スクロール動作確認）
- [ ] 曲数カウントがNavidromeのみの件数を表示すること

### 2. ローカルライブラリ統合テスト

#### 2.1 IndexedDB準備
- [ ] ブラウザのDevTools → Application → IndexedDB で `AonsokuLocalLibrary` データベースが存在することを確認
- [ ] 初回アクセス時にデータベースが自動作成されること（バージョン1）

#### 2.2 ローカルファイルスキャン（手動テスト用）
```typescript
// DevTools Consoleで実行
import { getDefaultScanner } from '@/local-library'

const scanner = getDefaultScanner()
const dirHandle = await window.showDirectoryPicker()

await scanner.scanDirectory(dirHandle, {
  chunkSize: 10,
  onProgress: (progress) => {
    console.log('Progress:', progress)
  },
  onComplete: (result) => {
    console.log('Complete:', result)
  }
})
```

#### 2.3 Localフィルタリング
- [ ] ローカルファイルをスキャン後、`?source=local` を選択
- [ ] スキャンしたローカルファイルのみが表示されること
- [ ] 曲のタイトル、アーティスト、アルバム情報が正しく表示されること
- [ ] 曲の再生が可能であること（クリックで再生）

### 3. データ統合テスト

#### 3.1 All Sourcesフィルタリング
- [ ] `?source=all` を選択したとき、NavidromeとLocalの両方の曲がマージされて表示されること
- [ ] 重複がないこと（同一曲がNavidromeとLocalの両方に存在しないか、または重複表示されないこと）
- [ ] ソート順が適切であること（タイトル、アーティストなど）

#### 3.2 検索機能
- [ ] 検索バーにキーワードを入力
- [ ] 「All Sources」選択時：NavidromeとLocal両方から検索結果が表示されること
- [ ] 「Navidrome」選択時：Navidromeのみから検索結果が表示されること
- [ ] 「Local」選択時：Localのみから検索結果が表示されること

### 4. パフォーマンステスト

#### 4.1 大規模ライブラリ対応
- [ ] Localに100曲以上登録した状態でページを開く
- [ ] スクロール時の無限スクロールが正常に動作すること
- [ ] メモリ使用量が過剰に増加しないこと（DevTools Performanceタブで確認）

#### 4.2 フィルター切り替え
- [ ] All ↔ Navidrome ↔ Local を素早く切り替えたとき、UIがフリーズしないこと
- [ ] ローディング状態が適切に表示されること

### 5. エラーハンドリングテスト

#### 5.1 空の状態
- [ ] Localに曲が登録されていない状態で `?source=local` を選択
- [ ] 「No results」または適切な空のメッセージが表示されること

#### 5.2 IndexedDBエラー
- [ ] ブラウザのプライベートモードでアクセス（IndexedDBが無効化される）
- [ ] エラーメッセージが表示され、アプリがクラッシュしないこと

### 6. 追加確認事項

#### 6.1 型安全性
```bash
npm run typecheck
```
- [ ] 型エラーがないこと

#### 6.2 Lint
```bash
npm run lint
```
- [ ] Lintエラーがないこと

#### 6.3 ビルドテスト
```bash
npm run build:win
```
- [ ] エラーなくビルドが完了すること
- [ ] 生成されたexeファイルが実行可能であること

### 7. 既知の制限事項

1. **LocalTrack → ISong変換**: `src/queries/songs.ts` の `convertLocalTrackToISong` は簡易的な実装です。完全なマッピング（albumId, artistIdなど）が必要です。

2. **ローカル曲の詳細情報**: 一部のフィールド（playCount, lastPlayedなど）はNavidrome固有のため、ローカル曲では表示されません。

3. **カバーアート**: ローカル曲のカバーアート表示は、実装済みのメタデータ抽出機能に依存します。

## ビルド・テスト手順

```bash
# 1. 依存関係のインストール
npm install

# 2. 型チェック
npm run typecheck

# 3. Lintチェック
npm run lint

# 4. 開発ビルド
npm run build -- --emptyOutDir false

# 5. インストーラー作成（管理者権限が必要）
npm run build:win

# 6. インストーラー実行
# dist/aonsoku-{version}-setup.exe
```

## 問題発生時の対処

### IndexedDBが見つからない
- DevTools → Application → Storage → Clear site data
- ページをリロード

### ローカル曲が表示されない
1. DevTools Consoleでエラーを確認
2. IndexedDBにデータが存在するか確認: `indexedDB.open('AonsokuLocalLibrary')`
3. LocalTrack → ISong変換のエラーを確認

### ビルドエラー
- `node_modules` を削除して再インストール: `rm -rf node_modules && npm install`
- Windowsの場合、開発者モードが有効か確認

## 完了報告

テスト完了後、以下の項目を確認してください：

1. [ ] 全ての「デバッグ要件」チェックボックスにチェックを入れる
2. [ ] 発見したバグや改善点をissueとして記録
3. [ ] WP3.6（仮想スクロール）の実装に進むか、Phase 3を完了とするかを判断

---

**実装日**: 2026-03-18
**実装者**: kimi k2.5
