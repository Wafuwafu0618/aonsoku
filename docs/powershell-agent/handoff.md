# PowerShell Build Agent Handoff

最終更新: 2026-03-19
目的: WSL 側 AI と PowerShell 側 AI のビルド作業連携を、1ファイルで明確に運用する。

## 1. 役割分担

- WSL 側 AI
  - 実装、リファクタ、差分作成
  - ビルド依頼の作成
- PowerShell 側 AI
  - Windows 環境での lint/build/package 実行
  - 結果の記録（成功/失敗、エラー要約、成果物）

## 2. 前提ルール

- Windows 向け最終ビルド（`build:unpack` / `build:win`）は PowerShell 側で実行する。
- 失敗時は「どのコマンドで」「何が原因で」失敗したかを必ず書く。
- ログは長文貼り付けを避け、要点を要約し、必要な抜粋だけ載せる。
- WSL 側はこのファイルの `Request` を更新し、PowerShell 側は `Response` を更新する。

## 3. 運用手順

1. WSL 側が `Request` セクションを更新
2. PowerShell 側が `Command Queue` を上から実行
3. PowerShell 側が `Response` セクションを更新
4. WSL 側が結果を見て次アクション（修正 or リトライ）を判断

## 4. Request Template (WSL -> PowerShell)

```md
## Request

- Request ID: <YYYYMMDD-HHMM-xxx>
- Branch: <branch name>
- Commit/Ref: <short sha or working tree>
- Goal: <何を確認したいか>
- Scope: <影響範囲>
- Notes:
  - <注意点1>
  - <注意点2>

### Command Queue

1. npm run lint
2. npm run build -- --emptyOutDir false
3. npm run electron:build
4. npm run build:unpack
5. npm run build:win
```

## 5. Response Template (PowerShell -> WSL)

```md
## Response

- Request ID: <YYYYMMDD-HHMM-xxx>
- Environment: Windows PowerShell
- Result: PASS | FAIL

### Command Results

1. <command>: PASS/FAIL
2. <command>: PASS/FAIL
3. <command>: PASS/FAIL

### Error Summary (if FAIL)

- Failed Command: <command>
- Root Cause (summary): <短い要約>
- Key Log Snippet:
  - <抜粋1>
  - <抜粋2>

### Artifacts

- <path or not generated>
```

## 6. Live Section

このセクションだけを都度更新して運用する。

### Request

- Request ID: 20260319-1646-init
- Branch: working tree
- Commit/Ref: local changes
- Goal: native output まわり修正後の Windows ビルド検証
- Scope: oversampling capability 表示 / sidecar output mode 制御
- Notes:
  - `wasapi-shared` 以外は未実装前提
  - `setOutputMode` で非 shared を即時エラー化済み

#### Command Queue

1. npm run lint
2. npm run build -- --emptyOutDir false
3. npm run electron:build
4. cd native/engine && cargo build
5. npm run build:unpack

### Response

- Request ID: (pending)
- Environment: (pending)
- Result: (pending)

