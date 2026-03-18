# プロジェクト全体フロー（Spotifyは終盤）

## 目的

このドキュメントは、Aonsoku の大規模改造を「どの順番で進めるか」を全体視点で整理したものです。  
方針として、Spotify 統合は終盤フェーズに配置します。

## 前提

- 現行は Electron + React + Zustand の構成
- まず既存の Navidrome 体験を壊さない
- 先に土台を固め、後から機能を積み上げる
- Spotify は依存・制約が大きいため後半で扱う

## フェーズ全体像

1. 土台フェーズ（完了）
2. 再生基盤フェーズ（完了）
3. ローカルライブラリ共存フェーズ（進行中: WP3.5まで実装）
4. 高音質出力フェーズ（排他モード）
5. HQPlayer 連携フェーズ
6. UI/UX 洗練フェーズ
7. 品質・運用フェーズ
8. Spotify 統合フェーズ（終盤）

## フェーズ詳細

## 1. 土台フェーズ（完了）

**完了日**: 2025年3月18日

狙い:
- source-aware なドメインモデル導入
- 再生バックエンド抽象化の準備
- `player.store` の責務分割方針を確立

成果物:
- `docs/foundation-phase-tasklist.md`
- `docs/foundation-phase-baseline.md`
- `src/domain/**` の初期レイヤ

完了条件:
- ✅ Navidrome 単体の挙動を維持
- ✅ 次フェーズで再生基盤を分離できる状態

実績:
- `src/domain/**` - source-aware domain model
- `src/playback/**` - PlaybackBackend abstraction
- `src/store/playback-*.ts` - store責務分割
- `src/platform/**` - Desktop API adapter
- バグ修正: 2曲目以降の再生問題

## 2. 再生基盤フェーズ（完了）

**完了日**: 2025年3月18日

狙い:
- 再生エンジンを差し替え可能にする
- UI 状態と再生副作用を分離する

主作業:
- ✅ PlaybackBackend interface 導入
- ✅ internal backend（現行再生経路）実装
- ✅ store 分割（UI / session / controller）

完了条件:
- ✅ Navidrome 再生が新基盤上で end-to-end 動作
- ✅ queue / shuffle / loop / progress に回帰なし

実績:
- `src/playback/backend.ts` - PlaybackBackend interface
- `src/playback/backends/internal-backend.ts` - Navidrome再生実装
- `src/store/player-controller.ts` - 副作用分離
- `src/store/playback-session.store.ts` - session state分離

## 3. ローカルライブラリ共存フェーズ（進行中）

**開始日**: 2025年3月18日（予定）
**最新更新**: 2026年3月19日

狙い:
- Navidrome とローカル音源を同一体験で扱う
- 巨大なローカルライブラリ（500GB+）に対応
- source別検索・フィルタ・ソート機能を提供

主作業:
- ローカルディレクトリ設定と自動スキャン
- Web Workerでのメタデータ抽出（チャンク処理）
- IndexedDB設計（全文検索インデックス含む）
- スキャン進捗UI・目視確認ダッシュボード
- source別検索（All/Navidrome/Local）
- source別ソート（タイトル/アーティスト/アルバム/追加日時）
- 仮想スクロール対応

技術的工夫:
- **チャンク処理**: 100ファイルずつ処理しUIブロック回避
- **Web Worker**: メタデータ抽出をバックグラウンドで実行
- **IndexedDB**: tracks/filePaths/searchIndexの3ストア構成
- **仮想スクロール**: 10,000曲以上でもDOM負荷を抑制
- **増分更新**: ファイル変更検知による差分スキャン

検索・フィルタ仕様:
- **グローバル検索**: 検索バー横にSourceセレクター（All/Navidrome/Local）
- **ライブラリ別フィルタ**: アルバム/アーティスト/曲画面にSourceフィルタ追加
- **ソート項目**: タイトル/アーティスト/アルバム/追加日時/再生回数
- **URL状態保持**: ?source=local&sort=addedAt&order=desc

完了条件:
- ローカルディレクトリを設定画面で選択可能
- 起動時に自動スキャン（バックグラウンド）
- 手動再スキャンが可能
- メタデータ不完全ファイルもリストに表示
- `navidrome + local` の混在再生と検索が成立
- 巨大ライブラリ（10,000曲以上）でもパフォーマンス維持

実装タスク:
- ✅ WP3.1: 基本スキャナー（チャンク処理）
- ✅ WP3.2: Web Workerメタデータ抽出
- ✅ WP3.3: IndexedDB設計・保存
- ✅ WP3.4: スキャン進捗UI（設定画面統合版）
- ✅ WP3.5: Sourceフィルタ・検索統合（All/Navidrome/Local）
- ⏳ WP3.6: 仮想スクロール対応

進捗メモ（2026-03-19）:
- 設定画面からローカルライブラリのフォルダを追加・削除できるように実装済み
- フォルダ選択はElectron IPC経由でOSネイティブダイアログを使用
- 手動スキャン（要件どおり）で、ファイル列挙 → メタデータ抽出 → IndexedDB保存まで接続済み
- Songs画面にSourceフィルタを統合し、`source=local` と `source=all` が機能
- ローカル曲は `file:///` 経由で再生する経路を追加

## 4. 高音質出力フェーズ（排他モード）

狙い:
- 音質重視ユーザー向けに排他モードを提供

主作業:
- デバイス選択と排他設定
- サンプルレート/ビット深度管理
- 既存再生との切替制御

完了条件:
- 排他モードで安定再生できる
- 通常モードとの切替が破綻しない

## 5. HQPlayer 連携フェーズ

狙い:
- HQPlayer を再生バックエンドとして扱う

主作業:
- 通信アダプタ実装
- 再生状態同期
- キュー連携と制御導線の整備

完了条件:
- HQPlayer 経由で再生/停止/次曲が機能
- UI 側の現在再生情報が同期される

## 6. UI/UX 洗練フェーズ

狙い:
- 多ソース・多バックエンド時代に耐える情報設計へ更新

主作業:
- プレイヤー情報設計の再構築
- 設定画面の再編
- 視覚トーン、余白、タイポ、モーション整備

完了条件:
- 見た目だけでなく操作の理解コストが下がる
- source と backend の判別が直感的

## 7. 品質・運用フェーズ

狙い:
- 終盤の大型統合に備え、品質の下地を固める

主作業:
- テスト拡張（回帰、統合、E2E）
- ログ/エラー可観測性強化
- リリースフロー整備

完了条件:
- 大規模機能追加後の回帰検知が可能

## 8. Spotify 統合フェーズ（終盤）

**認証方式**: Zeroconf/mDNS（Spotify Connect）
**制御**: 双方向制御（Aonsoku ↔ Spotify）
**ユーザー**: 単一ユーザー

狙い:
- 既存基盤を使って Spotify を安全に統合
- Spotify Connect 機能を活用したシームレスな連携

主作業:
- **Zeroconfサーバー実装**: AonsokuをSpotify Connectデバイスとして公開
- **認証フロー**: Spotifyアプリから「このデバイスで再生」でリンク
- **デバイス登録**: "Aonsoku"としてSpotify Connectデバイスとして認識
- **状態同期**: 現在再生曲、再生状態、進捗の取得
- **双方向制御**: Aonsoku UIから再生/停止/スキップ制御
- **カタログ統合**: 検索結果にSpotify曲を表示（source判別）
- **Sourceバッジ統合**: Spotify Connect用バッジ表示

技術的アプローチ:
- **librespot参考**: Python/Rust実装のプロトコル処理を参考
- **mDNS/Zeroconf**: ローカルネットワーク内でのデバイス発見
- **WebSocket/Dealer**: Spotifyとのリアルタイム通信
- **セッション管理**: トークン更新・再接続処理

制限事項:
- **音質**: 最大320kbps OGG Vorbis（Spotify HiFi非対応）
- **認証**: 同一WiFi内にSpotifyアプリが必要（Zeroconf制限）
- **Premium**: フル機能にはSpotify Premium必須

完了条件:
- ✅ Spotify 曲と Navidrome/Local 曲が同一 UI で共存
- ✅ Spotify 再生は Spotify 側クライアント制御で成立
- ✅ Aonsoku UIからSpotifyの再生を制御可能
- ✅ SourceバッジでSpotify曲を視覚的に判別可能

## Spotify を終盤に置く理由

- 制約が外部サービス依存で変動しやすい
- 再生仕様の主導権が部分的に Spotify 側へ寄る
- 先に土台を作らないと後戻りコストが高い

## 今の優先順位（運用ルール）

1. 既存 Navidrome 体験を守る
2. 再生基盤を抽象化する
3. ローカル・高音質・HQPlayer を先に成立させる
4. Spotify は最終フェーズで統合する

## 関連ドキュメント

- `docs/foundation-phase-tasklist.md`
- `docs/foundation-phase-baseline.md`
- `docs/tool-switch-handoff.md`
