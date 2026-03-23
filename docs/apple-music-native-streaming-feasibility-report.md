# Apple Music Nativeストリーミング再生 feasibility レポート（wrapper活用）

作成日: 2026-03-24  
対象: `tools/apple-music-downloader-main` / `tools/wrapper-main`

## 1. 結論（先出し）

- **技術的には可能（PoCは現実的）**。
- ただし、現状コードは **「ダウンロード＋復号＋ファイル保存」中心** で、
  **低遅延・安定再生の native パイプラインとしては未完成**。
- そのため判断は **「可能だが追加実装コストは高い」**。
  最短でも「再生専用 sidecar（m3u8取得/復号/デコード供給）」の新規実装が必要。

---

## 2. 実装事実（コード確認結果）

### 2.1 `apple-music-downloader-main` の実態

- メインフローは `main.go` で URL から楽曲/アルバム/プレイリストを処理し、最終的にファイルへ保存する構成。
- 復号経路は主に2系統:
  - `utils/runv2`:
    - wrapper の decrypt socket（既定 `127.0.0.1:10020`）へ sample 単位送信して復号。
    - mp4ff で fragment を再構成し、出力は最終的にファイル（`.m4a` 等）。
  - `utils/runv3`:
    - `acquireWebPlaybackLicense` を使う経路＋`DecryptMP4` or `mp4decrypt` で復号。
    - こちらも結果はファイル化前提。
- `checkM3u8()` は wrapper の m3u8 socket（既定 `127.0.0.1:20020`）から URL を受け取る設計。

要点: **ストリーミング再生向け API ではなく、ダウンロード処理を主目的にした実装**。

### 2.2 `wrapper-main` の実態

- 3つのソケットサービスを提供:
  - `decrypt-port` (`10020`): sample 復号サービス
  - `m3u8-port` (`20020`): adamId から m3u8 URL返却
  - `account-port` (`30020`): storefront/dev_token/music_token をHTTP JSONで返却
- `main.c` の復号は「adamId + key URI を受け、サイズ付き sample を受けて復号結果を返す」プロトコル。
- `SVPlaybackLeaseManager` を利用して lease を取り、`requestAsset` / `PurchaseRequest` で m3u8 を取得可能。
- ただし `main.cpp` の callback は
  - lease終了
  - playback error
  で **`exit(1)`** を呼ぶ設計（長時間運用で再起動管理が必要）。
- `README.md` / `wrapper.c` / `CMakeLists.txt` から、実行前提は **Linux(x86_64/arm64) + rootfs/chroot + Android由来バイナリ**。

要点: **復号プリミティブはあるが、オーディオ出力パイプラインそのものは持っていない**。

---

## 3. Nativeストリーミング再生への適合性

## 3.1 できること（強み）

- wrapper だけで以下を取得できる:
  - 再生可能 m3u8 URL（20020）
  - 復号器（10020）
  - アカウント関連情報（30020）
- つまり、**「再生データ取得＋復号」の最低限の部品は揃っている**。

## 3.2 そのままでは足りない点

- 既存は「保存前提」で、以下が不足:
  - 低遅延バッファ制御（先読み・アンダーラン回避）
  - 再生クロック同期（pause/resume/seek）
  - 連続再生での lease/鍵更新ハンドリング
  - ネットワーク変動時のリカバリ
- decrypt socket は sample 単位の往復I/Oなので、
  **リアルタイム再生には送受信設計の最適化（バッチ化・並列化・リングバッファ）が必須**。

---

## 4. 主要リスク

1. **OS/配布リスク**
- wrapper は Linux 前提。Minato が Windows/macOS でネイティブ再生するなら、
  同梱運用は難しく、WSL/Docker依存は運用負荷が高い。

2. **安定運用リスク**
- lease end / playback error で wrapper が `exit(1)`。
- 常用するならプロセス監視・自動再接続・状態復元が必須。

3. **レイテンシ/ジッターリスク**
- 復号が外部プロセスTCP往復のため、再生遅延や瞬断対策が必要。

4. **保守リスク**
- Apple側仕様変更（lease/m3u8/トークン周辺）で壊れやすい。

5. **法務/コンプライアンスリスク**
- DRM/利用規約に関わる領域。製品適用前に法務判断が必要。

---

## 5. 実装方針（現実的な進め方）

### Phase A: 再生専用 sidecar の PoC

- downloader の「保存処理」を使わず、以下を新規実装:
  - `m3u8 fetcher`（20020経由）
  - `segment fetcher`（HLS断片取得）
  - `decrypt bridge`（10020へまとめ送信）
  - `decoder feed`（native engine に PCM を供給）
- 完了条件:
  - 1曲を stopなしで最後まで再生できる
  - 初回再生開始までの時間が許容範囲内

### Phase B: 再生制御と安定化

- seek / pause / resume / track-skip
- lease切れ時の再初期化
- バッファ指標（埋まり率、復号待ち時間、再生遅延）を可視化

### Phase C: 製品化判断

- OS対応戦略（Linux限定か、別実装を持つか）
- 法務/運用要件を満たすかで Go/No-Go を決定

---

## 6. Go/No-Go 判定基準（提案）

- Go（継続）条件:
  - 連続再生60分でクラッシュなし
  - 3回連続で再生開始成功
  - seek/pause/resume が体感破綻しない
- No-Go（方針転換）条件:
  - wrapper の lease/互換問題で常時再接続が必要
  - OS制約がプロダクト要件と衝突
  - 法務要件を満たせない

---

## 7. 最終評価

- **「nativeパイプラインでのストリーミング再生」は実装可能**。
- ただし現状資産は「復号部品」であって「再生システム」ではないため、
  **PoC成功後に安定運用層を積む前提で進めるべき**。
- 現時点の最適戦略は、
  **wrapper を“復号サイドカー”として限定利用し、再生制御は Minato 側で主導する構成**。

