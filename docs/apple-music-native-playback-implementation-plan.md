# Apple Music Native Playback 実装計画（WSL wrapper + Rust sidecar）

作成日: 2026-03-24

## 1. 目的

Apple Music ライブラリ/検索からユーザーが楽曲を選択したとき、既存の Minato プレイヤー体験を維持したまま、以下のネイティブ経路で実再生できるようにする。

- WSL 上の `wrapper` を復号サービスとして利用
- Minato 側で分割DL -> 復号 -> デコード -> 高品質リサンプル -> ネイティブ出力をパイプライン化
- 「曲全体DL完了待ち」ではなく、先読みバッファ到達で再生開始

## 2. 現状前提（2026-03-24時点）

- Apple Music サインイン/認証状態取得は BrowserWindow セッション方式で動作中
- ライブラリ取得（songs/albums/playlists）および選曲UIは仮実装済み
- `wrapper-main` / `apple-music-downloader-main` は downloader 寄り実装で、再生用の安定化層は未実装

## 3. スコープ

### In Scope

1. Apple Music 選曲からネイティブ再生開始までの最短経路実装
2. 実運用を見据えた最低限の安定化（再接続、バッファ制御、失敗分類）
3. 既存 Rust sidecar（高品質リサンプラー経路）への統合
4. 手動受け入れテストの固定化

### Out of Scope

1. Apple Music 楽曲の恒久保存機能
2. DRM/規約解釈の確定（法務判断そのもの）
3. マルチOS完全同等対応（まずは開発ターゲット環境優先）

## 4. 目標KPI（実用判定）

1. 再生開始時間: p95 で 2〜4秒以内
2. 30分連続再生でアンダーラン: 0〜1回以下
3. 復号スループット: 実時間の3倍以上（>= 3x realtime）
4. シーク応答: 1.5秒以内（キャッシュヒット時は 500ms 以内目標）

## 5. アーキテクチャ（計画）

1. Renderer（Apple Music UI）
2. Electron Main（Apple Music Browser API + Playback Coordinator）
3. Native Bridge（Minato <-> Rust sidecar IPC）
4. Rust sidecar（Fetch/Decrypt/Decode/Resample/Output）
5. WSL wrapper（10020 decrypt / 20020 m3u8 / 30020 account）

データフロー:

1. ユーザーが Apple Music で曲を選択
2. Main が `play-intent` を Rust sidecar へ送信（adamId, storefront, qualityHint）
3. Rust sidecar が wrapper 20020 から m3u8 URL を取得
4. HLS セグメント取得を並列実行
5. 必要なサンプルを wrapper 10020 で復号
6. デコーダへ投入して PCM 化
7. 既存高品質リサンプラーへ通してネイティブ出力
8. 低水位バッファ割れ時は先読み強化、必要なら再バッファ

## 6. 実装フェーズ

## Phase 1: 再生パイプライン PoC（最短再生）

目的: 選曲した1曲を停止なしで最後まで鳴らす

実装項目:

1. Rust sidecar に `appleMusicStartPlayback` コマンド追加
2. wrapper 20020 連携で m3u8 取得
3. HLS セグメント fetcher（逐次でも可）
4. wrapper 10020 復号ブリッジ
5. デコード -> 既存リサンプラ -> 出力まで接続

完了条件:

1. 任意の1曲が再生開始できる
2. 曲終端までクラッシュせず再生できる

## Phase 2: 先読み/並列化で速度改善

目的: 実用開始速度を達成

実装項目:

1. 再生開始条件を「先頭5〜10秒ぶんの復号完了」に変更
2. fetch/decrypt/decode をパイプライン並列化
3. セグメント単位で復号依頼をバッチ化（小粒往復を削減）
4. バッファ水位管理（high/low watermark）実装

完了条件:

1. p95 再生開始 4秒以内
2. 10曲連続試験で再生開始失敗 0件

## Phase 3: 安定化（止まって見える状態の排除）

目的: 不安定要因の抑制

実装項目:

1. wrapper supervisor（ヘルスチェック、自動再起動、再接続）
2. timeout/retry/backoff（segment fetch / decrypt request）
3. 失敗分類を統一
4. UI進行状態を明示

失敗分類:

1. `wrapper-unreachable`
2. `m3u8-fetch-failed`
3. `decrypt-timeout`
4. `buffer-underrun`
5. `decode-failed`
6. `invoke-failed`

完了条件:

1. 30分連続再生でアンダーラン 1回以下
2. エラー時に原因分類がUIへ表示される

## Phase 4: シーク/スキップ/キュー統合

目的: 日常利用に必要な操作性を揃える

実装項目:

1. シーク時の部分再バッファ戦略
2. 次曲先読み（current + next 1）
3. Apple Music 曲を既存キューへ統合
4. 停止/再開/スキップの状態機械を統一

完了条件:

1. シーク 10回連続でハングなし
2. スキップ連打時も sidecar が整合状態を維持

## Phase 5: ローカルキャッシュ導入

目的: 体感速度と再試行耐性を上げる

実装項目:

1. 復号済み断片の短期キャッシュ（LRU）
2. 同一曲の再生再開時にキャッシュ優先
3. キャッシュ統計（hit/miss）を debug report へ出力

完了条件:

1. 同一曲の再再生開始が初回より短縮
2. シーク体感が改善（キャッシュヒット時 500ms 以内目標）

## Phase 6: 受け入れテスト固定化

目的: 再現性ある合否判断

テスト項目:

1. Sign-In済み状態で Apple Music 曲を選択 -> 再生開始
2. 連続10曲再生（スキップ含む）
3. 30分連続再生
4. シーク往復（先頭/中盤/終盤）
5. wrapper 再起動を挟んだ自動復帰
6. Minato 再起動後の再生再開

完了条件:

1. 上記一式を連続3回で再現可能

## 7. IPC/インターフェース計画（案）

Electron -> Rust sidecar:

1. `appleMusicPlayTrack` (adamId, storefrontId, qualityHint)
2. `appleMusicPause`
3. `appleMusicResume`
4. `appleMusicSeek` (positionMs)
5. `appleMusicStop`
6. `appleMusicGetPlaybackDebug`

Rust sidecar -> Electron:

1. `state` (`idle|buffering|playing|rebuffering|error`)
2. `buffer` (secondsBuffered)
3. `error` (classified code + message)
4. `stats` (startupMs, underrunCount, decryptThroughput)

## 8. 安定運用ルール

1. wrapper 通信断は即失敗ではなく再接続猶予を取る
2. 再生中にバッファ低水位を下回ったら `rebuffering` へ遷移
3. 連続失敗閾値超過時のみユーザーに手動再試行を要求
4. 通常UIは簡潔、詳細トレースは debug report のみ

## 9. リスクと対策

1. WSL ネットワークジッター
対策: バッチ復号、先読み長さ拡張、短期キャッシュ

2. wrapper 側プロセス終了
対策: supervisor + 自動再起動 + セッション再確立

3. Apple 側仕様変化
対策: 失敗分類・ログ拡充、代替経路を feature flag で切替

4. 実装複雑化
対策: フェーズごとに Done 条件を固定し、PoC合格後に段階拡張

## 10. マイルストーン提案

1. M1（Phase 1完了）: 1曲実再生PoC
2. M2（Phase 2-3完了）: 実用速度 + 最低安定性
3. M3（Phase 4-5完了）: 日常利用操作 + 体感速度向上
4. M4（Phase 6完了）: 受け入れ固定化

## 11. 最終判断基準

継続 Go:

1. KPIを満たし、連続試験で再現性がある
2. 主要障害が自動復旧可能

方針転換 No-Go:

1. wrapper 側制約により安定再生が繰り返し破綻
2. 要求レイテンシを満たせない
3. 運用コストが許容を超える

