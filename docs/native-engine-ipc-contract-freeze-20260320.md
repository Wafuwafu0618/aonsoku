# Native Engine IPC 契約凍結（M0）

最終更新: 2026-03-20  
対象: `native/engine` (`rust-sidecar`)

## 1. 目的

- `symphonia + cpal` 移行中に IPC 契約を壊さないための基準点を固定する
- M0 の「型・イベント順序の凍結」を docs で追跡可能にする

## 2. Envelope 契約

- Request: `SidecarRequest`
  - `kind: "request"`
  - `id: string | number`（内部では文字列化）
  - `command: string`
  - `params?: object`
- Response: `SidecarResponse`
  - `kind: "response"`
  - `id: string`
  - `ok: boolean`
  - `result?: object`
  - `error?: { code, message, details? }`
- Event: `SidecarEventEnvelope`
  - `kind: "event"`
  - `event: { type, currentTimeSeconds?, durationSeconds?, error? }`

## 3. コマンド契約（凍結）

- `initialize`
- `listDevices`
- `setOutputMode`
  - params: `{ mode: "wasapi-shared" | "wasapi-exclusive" | "asio" }`
- `load`
  - params:
    - `src: string`
    - `autoplay?: boolean`
    - `loop?: boolean`
    - `startAtSeconds?: number`
    - `playbackRate?: number`
    - `durationSeconds?: number`
    - `targetSampleRateHz?: number`
    - `oversamplingFilterId?: string`
- `play`
- `pause`
- `seek`
  - params: `{ positionSeconds: number }`
- `setVolume`
  - params: `{ volume: number }`
- `setLoop`
  - params: `{ loop: boolean }`
- `setPlaybackRate`
  - params: `{ playbackRate: number }`
- `stop`
- `getState`
- `dispose`

## 4. イベント契約（凍結）

- `ready`
- `loadedmetadata`
- `play`
- `pause`
- `timeupdate`
- `ended`
- `error`
- `deviceChanged`

## 5. 順序ルール（現行運用）

- コマンド失敗時は `error` event を先に emit し、その後 `ok:false` response を返す
- `load` 成功時は `loadedmetadata` event を emit し、その後 response を返す
- `load(autoplay=true)` 成功時は `loadedmetadata` 後に `play` event を emit して response を返す

## 6. 互換ポリシー

- 上記コマンド名・payload キー・event type は M2 以降も維持する
- error `code` は既存値を優先維持し、追加時は後方互換で拡張のみ行う
