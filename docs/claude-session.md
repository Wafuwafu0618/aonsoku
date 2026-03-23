
いい問いですね。Apple Music と Navidrome/ローカルライブラリは根本的に性質が違うので、同じ「ライブラリ一覧」UX を目指すと破綻します。

なぜ「全部乗せ」が無理か
Navidrome/Local	Apple Music
データの所在	サーバー/ローカルに全量ある	Apple のサーバーにある
一覧取得	全曲一括取得可能	ページネーション必須（limit + offset）、レート制限あり
インデックス	DB クエリでフィルタ/ソート自在	Apple の API のクエリパラメータに依存
カタログ	自分が持ってるものだけ	1億曲以上のカタログ + 自分のライブラリ
現在の limit: 25 ハードコードでもわかる通り、全量フェッチしてフロントエンドで管理する設計は成り立たない。

考えられるアプローチ
A. 「検索ファースト」UI（Spotify 型）
Apple Music セクションは 検索が入口で、ブラウズは補助。

┌─────────────────────────────┐
│ 🔍 Search Apple Music       │  ← メイン入口
├─────────────────────────────┤
│ 📚 My Library               │  ← 自分のライブラリ（遅延読み込み）
│   Recent Albums  [→ more]   │
│   Playlists      [→ more]   │
├─────────────────────────────┤
│ 🔥 Browse                   │  ← カタログのキュレーション
│   New Releases   [→ more]   │
│   Top Charts     [→ more]   │
└─────────────────────────────┘
ライブラリは 最初に 25〜50 件だけ取得 + 「もっと見る」で追加ロード（infinite scroll or pagination）
カタログ検索は常にオンデマンド
Navidrome のライブラリ画面とは完全に別のセクション
B. 「統合キュー」だけ共通化する
ライブラリ UI は分離するが、再生キューだけは統一する：

Navidrome の曲と Apple Music の曲が同じキューに混在可能
player の currentList に ISong（or 将来的に 

MediaTrack
）として統一的に入る
ユーザーからは「ソースが違う曲を連続再生できる」体験
これは 今の 

toPlayerSong()
 ハックがまさにやろうとしていること で、方向性としては正しい。

C. 「プロキシライブラリ」パターン
Apple Music のライブラリをローカルにキャッシュ DB として持つ：

初回同期で全ライブラリをフェッチ（バックグラウンドで段階的に）
IndexedDB or SQLite に保存
以降はローカル DB からクエリ、差分だけ Apple API から更新
メリット: Navidrome と同じ UX が実現できる デメリット: 初回同期が重い、Apple API の変更に弱い、実装コスト大

推奨: A + B の組み合わせ
フロントエンドの構造としては：

サイドバーに「Apple Music」セクションを独立で追加 — Navidrome の Library とは完全に分離
Apple Music セクションの中身は「検索ファースト」 — 検索、My Library（遅延読み込み）、Browse
再生キューだけ shared — Apple Music の曲も Navidrome の曲も同じ player で再生
ライブラリの全量管理はしない — 表示するのは常に「最新N件」or「検索結果」
今の 

apple-music/index.tsx
 は基本的にこの方向に向かっているので、大きな方針転換は不要。足りないのは：

My Library の遅延読み込み/ページネーション
Browse セクション（New Releases, Top Charts など — MusicKit API で取れる）
UI のポリッシュ（既存の Navidrome ページと同じデザイン言語に揃える）
この方向で良さそうですか？ 

OK