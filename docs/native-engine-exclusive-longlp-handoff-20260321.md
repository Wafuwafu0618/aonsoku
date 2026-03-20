# Native Engine Exclusive Long-LP 引き継ぎメモ

最終更新: 2026-03-21 (JST)
担当引き継ぎ対象: 次の AI エージェント
状態: 未解決（音は出るケースもあるが、`poly-sinc-long-lp` + 高倍率で途切れ/無音化が残る）

## 1. 目的

- WASAPI 排他モードでの HQ リサンプラ + Parametric EQ を安定動作させる。
- 特に `poly-sinc-long-lp`（重い設定）でも実用的に再生できるようにする。

## 2. ユーザー報告の現象（重要）

- 「鳴るけど音の途切れがひどい」
- 再生UIのシークバーは進むのに、実際の音が出ないケースがある。
- 対象条件は主に `source=44.1kHz` + `target=384kHz`（実際は 352800Hz へ正規化） + `poly-sinc-long-lp`。

## 3. ここまでに確認できたこと

- Parametric EQ 自体は効いている（0dBFS超え対策の減衰もユーザー確認済み）。
- Offline 検証CLI（`offline-oversampling-lab`）で比較・自己null・インパルス解析は動作。
- Stopband 計測は測定開始周波数依存で値が変わるため、22.05kHz開始時に妥当な結果が出ることを確認済み。

## 4. 直近の実装変更（途切れ対策）

対象ファイル:
- `native/engine/src/audio/wasapi_exclusive.rs`

主な変更:
- heavy long-lp 向けに秒ベース深バッファを導入
  - `HEAVY_LONG_LP_TARGET_BUFFER_SECONDS = 10.0`
  - `HEAVY_LONG_LP_PRIME_BUFFER_SECONDS = 6.0`
  - `HEAVY_LONG_LP_REFILL_TRIGGER_SECONDS = 4.0`
  - `HEAVY_LONG_LP_REFILL_BUDGET_SECONDS = 0.08`
- バッファ計算ログを秒換算付きで出力
  - `hq-sinc buffering ... targetPending=... (~Xs) ...`
- 起動時プリフェッチ目標ログを追加
  - `exclusive startup prefill target=... (~Xs)`
- 起動時プリフェッチ中にも stop 命令を処理する分岐を追加

関連の既存ログ強化（前段階で実装済み）:
- `native/engine/src/commands/mod.rs`: commandログ
- `native/engine/src/runtime/audio_runtime.rs`: `stop_exclusive_playback reason=...`

## 5. 直近ログの読み取りポイント

ユーザー失敗ケースでは、以下が出ることがある:
- `exclusive conversion path: hq-sinc-resample+parametric-eq (poly-sinc-long-lp)`
- `hq-sinc params profile=poly-sinc-long-lp ratio=8.000 sinc_len=512 cutoff=0.968 osf=64`
- `hq-sinc buffering ...`

ただし、ケースによってはこの後の
- `exclusive startup prime wrote ...`
が出る前後で停止/無音化している疑いがある。

## 6. 未解決課題

- `poly-sinc-long-lp` の実時間再生で、CPU余力があっても音が途切れる/無音になるケースが残る。
- 大型バッファ化だけでは再生安定性が十分でない可能性がある。

## 7. 次エージェントの優先タスク

1. 現状の再現確認（最優先）
- まず heavy long-lp で再生し、以下ログが出るか確認:
  - `hq-sinc buffering ... (~seconds)`
  - `exclusive startup prefill target=...`
  - `exclusive startup prime wrote ...`
  - `exclusive-render-summary ... underrunCount=...`

2. 起動前/起動直後のボトルネック可視化
- prefillループに進捗ログ（1秒ごと等）を入れて、`fill_samples` が止まっているのか、追いつかないのかを切り分ける。

3. WASAPI 排他の駆動方式改善（本命）
- 現在のポーリング + `yield_now` 依存を見直し、イベント駆動（`AUDCLNT_STREAMFLAGS_EVENTCALLBACK` + `SetEventHandle`）へ移行検討。
- heavyフィルタ時は producer / render の役割分離（先読みスレッド + リングバッファ）も検討。

4. 安全弁
- underrun継続時に自動で `poly-sinc-lp` へ段階フォールバックする運用可否を検討（ユーザー選択制が望ましい）。

## 8. 受け入れ基準（暫定）

- 条件: 44.1kHzソース、排他、target 384000指定（実効352800Hz）、`poly-sinc-long-lp` + EQ
- 5分以上連続再生で、聴感上の途切れが実用上問題ないレベル
- `exclusive-render-summary` の `underrunCount` が著しく増加しない

## 9. ユーザー環境・運用上の注意

- ユーザーは Windows 実機で検証する。
- コマンド提示は PowerShell 1行で渡す（改行すると別コマンド扱いになる）。
- リポジトリは dirty worktree。無関係差分は絶対に戻さない。

## 10. 参考コマンド（PowerShell / 1行）

- ネイティブエンジンのビルド:
`cd C:\aonsoku\native\engine; cargo build --release`

- offline検証（例）:
`cd C:\aonsoku\native\engine; cargo run --release --bin offline-oversampling-lab -- --src "C:\aonsoku\cypress\fixtures\song.mp3" --filters "poly-sinc-long-lp" --target-sample-rate 384000 --output-dir "C:\aonsoku\native\engine\offline-lab-eq-3528" --self-null --analyze-impulse --stopband-start-hz 22050`

## 11. 備考

- このセッション環境（WSL側）では `cargo` が無く、最終ビルド確認は未実施。
- 実機Windowsでの再生ログ収集が次フェーズの前提。
