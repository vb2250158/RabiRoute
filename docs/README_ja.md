<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | <a href="./README.md">简体中文</a> | 日本語
</div>
<!-- /docs-language-switch -->

# RabiRoute ドキュメント

[コントローラおよびリモート コンピュータ クライアント](remote-computer-client_en.md):端末、ファイル転送、ウィンドウクエリおよびスクリーンショットを使用して、ホストから複数のコンピュータを操作する。

[接続と API アクセス](connection-access_en.md):一度認証し、提供された API を使用します。

このディレクトリには、現在のガイド、実験的統合、設計、研究、および過去の引き継ぎが含まれる。ファイルの存在は、その機能が完全であることを意味するものではありません。依存する前にステータスを確認してください。

## ここから始めましょう

- [デスクトップペットコンパニオンモード](companion-mode_en.md) — **実験的**。ペットのコンテキスト メニューから開始して、適応、見守る、遊ぶ、仕事、または静かな仲間を選択します。

- [デバイスを検査し、アクションをテストする](user-guide/home-devices_ja.md) −デバイスカード、機能および状態を検査し、次にアドバタイズされたアクションをテストする。
- [ワークスペースプランのクエリ](workspace-plan-query_en.md) -ホストセッションおよびワークスペースを範囲とするページ分割された検索。

- [ペルソナの終日録画](persona-all-day-recording_en.md) — **新しい実装**。コンピュータと選択した電話イベントを日付ごとに確認し、明示的なキャプチャ ソース、一時停止状態、カバレッジ ギャップを確認します。

- [RibiWebGUI ユーザーガイド](user-guide/README_ja.md) — **現在のガイド**。初めて使用するときにここから開始して、実際の配信を完了し、ステータスを読み取り、ルールを変更し、一般的な障害から回復します。
- [はじめに](getting-started_ja.md) — **現在のガイド**。 RabiRoute をインストールし、Manager を起動し、コンソールが開くことを確認します。
- [インターフェースとステータス](user-guide/interface-and-status_ja.md) — **現在のガイド**。現在のルート、マネージャー接続、保存されていない変更、実行時の状態、設定ページのスクリーンショット、選択されたテキスト メニュー、ログインの起動を理解します。
- [インターフェーステーマ](user-guide/interface-theme_ja.md) — **現在のガイド**。 WebGUI と Windows トレイの共有のライト、ダーク、フォローシステム、および境界付きカスタム テーマ。
- [ランタイム、ログ、トラブルシューティング](user-guide/operations-and-troubleshooting_ja.md) — **現在のガイド**。メッセージが到着しない場合は、診断の概要から始めて、破損箇所を特定します。
- [安全性、応答、およびデータ](user-guide/safety-and-data_ja.md) — **現在のガイド**。外部からの返信や診断の共有を有効にする前に、権限とプライバシーを確​​認してください。
- [現在の能力と成熟度](current-capabilities_ja.md) — **現在の事実**。何が検証済みで、実際のアカウント、ネットワーク、またはデバイスの受け入れ実行がまだ必要なものを確認してください。

## ローカルでのインストール、構成、およびリカバリ

- [PC オンボーディング プロンプト](rabilink-pc-pairing_en.md) - ターゲットエージェントがワンタイムコードを使用して接続をインストール、構成、検証できるように、完全なプロンプトをコピーします。サーバー展開後に利用可能となり、各クラウド環境で個別にアクセスと永続性が検証されます。

- [DSHセッションモード](dsh-session-modes_en.md) −セッションモードを選択し、モードを切り替えることができない会話を処理する。
- [DSH Webセッションブリッジ認証](dsh-browser-auth_en.md) — **往復配送を承ります**。セキュリティを無効にしたり書き込みを再実行したりせずに、現在の所有者の起動認証を通じて接続します。
- [構成](configuration_en.md) — **現在のガイド**。メッセージ入力、ハンドラー、ローカル ディレクトリ、およびオプションのプラグイン権限を構成します。
- [居住者のパフォーマンスの記録と検査](performance-monitoring_en.md) — **現在のガイド** オプションの継続的なマネージャー、ゲートウェイ、およびWebGUIのメトリクス、傾向、遅い操作、および独立したJSONLファイル用。
- [トラブルシューティング](troubleshooting_en.md) NapCat、エンコーディング、Codex Desktopタスクの所有権、モデル、および承認境界。
- [Windows ランチャーとパッケージング](windows-launcher-and-packaging_en.md) - Windowsのインストール、起動、およびパッケージ化。
- [Linuxホスト](linux-host_en.md) — **新しい実装**。 Linux 上で WebGUI を構築して開き、現在のアドレスを検出し、安全に停止し、RabiLink のセットアップと保留中の受け入れを理解します。
- [PC ID とインスタンス ID のリセット](user-guide/instance-identity_ja.md) - コピーされたアイデンティティを修復して、個別の PC がペルソナソースとして独立して表示されるようにします。
- [NapCat 無人起動](napcat-unattended_en.md) −QQログイン状態、クイックログイン、マネージャ回復、および監視境界。

## 開発者: ルーティング、ペルソナ、およびエージェント インターフェイス

- [ホームデバイスおよびスピーカーエージェントAPI](home-device-agent-api_en.md) - インポートされたすべてのエンティティをクエリし、そのボタン/設定/デバイスアクションを発見して呼び出し、音声をバインドし、永続的なレシートをクエリする。
- [真空雲地図接続](vacuum-cloud-map_en.md) - QR ログイン、生ファイル、バージョン 2 のデコード。ライブローカライゼーションとナビゲーションには個別の承認が必要です。

- [配信テンプレートと所有権](message-delivery-templates_en.md): レンダラーの所有権、シナリオの相違点、および開発者向けの履歴レシートの廃止。
- [計画と記憶の要約検索](knowledge-search_en.md)
- [自動化エージェントの配信](automation-agent-delivery_en.md) - 受信者の参照、セッションの選択、移行および再試行。
- [ルーティング設定](routing-configuration_en.md) — **現在のガイド** 用 `personaConfig.json`、ルートの種類、正規表現、パイプライン、およびテンプレート変数。
- [ルーティングとペルソナ](routing-and-personas_en.md) — **現在のガイド** ルート/ペルソナ境界およびペルソナ決定テンプレートの場合。
- [ローカル ルートからリモート ペルソナを使用する](remote-persona-reference_en.md) — **0.3.19 で実験中**。同じ RabiLink アプリケーション内のソース PC とペルソナを選択し、読み取り専用アクセスに自動ハンドシェイクを使用して、ローカル メッセージ入力と処理エージェントを保持します。実際の 2 台の PC の配信は承認待ちのままです。
- [エージェントコンテキストインジェクション](agent-context-injection_en.md) — **現在のガイド** ペルソナスコープの双方向台帳、エンドポイントごと/会話の最近のメッセージバジェット、アーカイブ境界、ペルソナディレクトリおよびクロスペルソナ資格情報、パス、および内部の応答コンテキストの場合 `AgentPacket`.
- [デスクトップペットモーションAPI](desktop-pet-agent-motion_en.md) ペットを移動させ、到着、中断、および不確実な受信を読み取る。
- [デスクトップのペットの泡とスピーチ](desktop-pet-bubbles_en.md) — 読み上げられたペルソナテキストを表示し、足の皮、フォント、色、寿命をカスタマイズします。
- [Rabi エージェント インターフェイス](rabi-agent-interfaces_en.md) — **現在の契約** ハンドラ応答、ペルソナ発見、冪等の一方向クロスペルソナ配信、受信、スレッドブリッジ、計画、メモリ、リモートエージェント、およびペルソナスキル。
- [計画と記憶](plan-and-memory-model_en.md) — **現在のガイド** ペルソナ知識ソース、想起、明示的統合、および副作用について。
- [統合された動的レコードのライフサイクル](dynamic-record-lifecycle_en.md) — **現在のガイド** アーカイブ、メモリ統合、物理的シャーディング、保持、および24/72時間の動的ウィンドウ用。
- [パイプラインプリセット](pipeline-presets_en.md) - エージェント セッションのデフォルト、明示的な外部ターゲット、および送信トレイのステータス。 FenneNote の出力はアーカイブ互換性のみです。
- [エージェント アダプタ統合のレッスン](agent-adapter-integration-lessons_en.md) — **現在のガイド** 重複セッション、不足しているツール、反転された所有権、デスクトップ起動の依存関係、および検証。
- [標準エージェントアダプター要件](agent-adapter-standard-requirements_en.md) — **現在のガイド** 発見、認証、タスク、冪等の作成、配信、結果、ツール、ライフサイクル、UI、セキュリティ、および受け入れ。
- [Grok ボット エージェント アダプター](grok-bot-agent-adapter_en.md) — **実験的**。既存のクラウド所有者の正確なボット セッションに配信し、ソース ID、冪等性、QQ/Codex 応答を検証します。
- [デバイスエージェントアダプターコントラクト](device-agent-adapter_en.md) — **実験的**。メガネをルート ハンドラーとして構成し、メガネ モデル上で実行し、PC キュー、元の配信、および応答の受信を確認します。
- [メガネ接続を電話に委任する](device-peer-connection_en.md) — **実験的**。デバイスの資格情報、独立したキー、および転送された要求がメガネの ID を保持するための短い接続リースを確認します。
- [正確なエージェントの配信と正式な応答](agent-endpoint-delivery_en.md) — **実験的**。ソースとターゲットの所有者、元の配送受領書、および必要な返信を確認します。タイムアウトと取り消された ID を処理します。
- [Codex Desktop Agentの統合および受諾契約](codex-desktop-agent-acceptance_en.md) — **現在の事実** 安定したID、副作用のないスキャン、自動初期化、デスクトップ所有者境界、およびメタデータブートストラップゲート用。
- [Rabi Codex Contextプラグイン](rabi-codex-context-plugin_en.md) — **Unified Managerのバージョン** ここで、フックは実際のCodexセッションイベントを転送するだけであり、Rabi PCが所有するペルソナ、プラン、メモリ、およびスキルコンテキストを注入する。
- [ロールデータ同期の廃止](persona-data-sync_en.md) — **退職しました**。自動/手動同期および同期 API は提供されなくなりました。既存の RabiLink リモート ペルソナ、エージェント、およびデータ アクセスをレプリケーションなしで使用します。履歴データは保持されます。


## メンテナ: アーキテクチャ、ビルド、および診断

- [RabiLinkモバイルステート契約](rabilink-mobile-owner-api_en.md) — ASR の優先順位、バッテリー レポート、プルーフ、およびネイティブ冪等再生に関するメンテナー リファレンス。
- [ルート制御契約](route-control-api-contract_en.md) - ID、構成、バインディング、メッセージ処理、およびネイティブ CAS 受信に関する開発者向けリファレンス。
- [デバイスとエージェントの実行契約](device-agent-api-contracts_en.md) - デバイスセッション、ウェイク、クレーム、元の配信、および永続的な受領書に関する開発者向けリファレンス。
- [ゲートウェイ制御契約](gateway-control-api-contract_en.md) - 永続化された構成、ランタイムアクティベーション、およびネイティブ CAS トランザクションに関するメンテナーリファレンス。
- [エージェントスレッドコントラクト](agent-thread-api-contracts_en.md) - オリジナルのホストアクション、来歴および冪等台帳に関する開発者リファレンス。
- [メッセージ処理コントラクト](message-processing-api-contract_en.md) - 元の理事会、送信コンテキストのレビュー、ファクトフェンシング、および受領書の管理者参照。

- [Bilibili ブラウザ履歴ブリッジ](bilibili-history-bridge_en.md) −固定拡張機能、個人プライベートデータシャード、および実行可能なAPIコントラクトのためのメンテナセットアップ。

- [APIコントラクト発見およびリモート呼び出しのためのターゲットアーキテクチャ](api-contract-discovery-target-architecture_en.md) — **進行中。ランタイム受け入れが不完全**。登録と更新の基盤が存在します。完全なパブリックエントリーの移行、廃止、および 2 台のコンピュータの受け入れを追跡します。
- [API移行実施記録](api-contract-discovery-implementation-progress_en.md) 保守者は、ソース配線、コンパイルされたプロファイル、および残りのライフサイクルの受け入れを比較する。
- ペルソナ API コントラクト: [個のリソース](persona-resource-api-contracts_en.md), [の歴史](persona-history-api-contracts_en.md), [計画制御](persona-plan-api-contracts_en.md), [スキル](persona-skill-api-contracts_en.md), [の知識](persona-knowledge-api-contracts_en.md), [アイデンティティ](persona-identity-api-contracts_en.md), [健康](persona-health-api-contracts_en.md).
- [ペルソナの構成とライフサイクル](role-configuration-api-contracts_en.md), [コア公共サービス](core-public-api-operations_en.md) そして [プラグイン カタログ契約](plugin-catalog-api-contract_en.md) - ネイティブの改訂、受領書、準備状況および出版境界。
- [プラグイン公開ライフサイクル](plugin-publication-lifecycle_en.md) ポインタ候補の変更、ロールバック、以前の所有者のリタイア、および実行モードの制限。
- [WebGUI 静的リソース コントラクト](webgui-static-api-contracts_en.md) - ネイティブ ファイル、不変リビジョン、最終フォールバック、および記述子のクリーンアップ。共有統合ステータスはドキュメントに記載されています。
- [独立リスナー契約](external-listener-contracts_en.md) そして [プラットフォームネイティブのリスナー](platform-native-listeners_en.md) - ネイティブ アドレス、オリジナルの認証、信頼できるライフサイクル公開、および個別に検証されたリモート到達可能性。
- [ピア LAN リスナーの検出](peer-lan-listener-discovery_en.md) - 実際のバインドされたアドレス、元の暗号化されたプロトコル、メタデータのハンドオフと停止時の引き出しを確認します。
- [Webhook HTTP contract](webhook-http-contract_en.md) - Webhook、FenneNote、および RabiLink リスナーのネイティブ メソッド、パス、入力およびシャットダウン動作をチェックします。
- [Long-term maintenance and self-repair](rabi-maintenance_en.md) — **Maintenance workflow** 安定した取り込みタスク、元の問題の所有権、回復検証、および定期的なコード品質作業のため。
- [Rabi ナレッジ検索をインストールします](../skills/rabi-knowledge-search/README_en.md) プロジェクト管理者は、オンラインの場合は最初に計画と思い出を検索し、オフラインの場合は通常の検索を使用するスキルをインストールできます。
- [ID関係スキルをインストールします](../skills/manage-rabiroute-identity-relations/README_en.md) エンドポイントアカウントが誰であるかを解決し、所有権を確認または修正し、同時競合および共有アカウントを処理し、エージェントを現場に常駐させて候補者の観察を行う。
- [インストールされた Web ホット パッチ](web-hot-patches_en.md) - 互換性のある Web バンドルを構築、アクティブ化、ピン留め、およびロールバックする。
- [アーキテクチャ](architecture_en.md) — **現在の事実**。製品の境界、Codex Desktop の所有者、現在の送信トレイ、および将来のアクション キューは分離されます。
- [DSHから学ぶプラグインアーキテクチャの教訓](dsh-plugin-architecture-lessons_en.md) — **研究と実施の概要**.組み込みマネージャー プラグイン、WebGUI/デスクトップの最小限の拡張ホスト、コントリビューション ポイント、プロセス分離境界、および将来のサードパーティ プレゼンテーション拡張ホストの完全な移行について説明します。
- [DSH が Cordis を使用する方法](dsh-cordis-runtime-analysis_en.md) — **実装調査**。プロファイル、ローダー、ファイバー、サービス レルム、ブラウザ プラグイン ツリー、動的コード、プロセスとサンドボックスの境界について説明します。
- [RabiRouteプラグインプラットフォームのターゲットアーキテクチャ](manager-plugin-implementation-hot-swap_en.md) — **現在のアーキテクチャ**。最小限のプラグイン カーネル、独立した機能パッケージ、1 つの SDK、マルチホスト拡張機能、アトミック生成切り替え、ツリー外プラグインの受け入れ、および古いランタイムの 1 つの完全な削除を定義します。
- [プラグイン バンドルとホット リプレース](plugin-bundles_en.md) — **現在の実装ガイド**。 1 つのプロファイル、独立したパッケージ、共有 SDK、世代別ホット リプレース、ブラウザ リビジョン ロールバック。
- [ソースホットパッチ](source-hot-patches_en.md) — **開発中**。ソース モードは、コードと宣言されたリソースを監視し、変更をコンパイルして検証し、状態を保存し、サービスを停止することなく切り替えます。この文書には、インストールされたランタイムの許容境界が記載されています。
- [コードアーキテクチャ](code-architecture_en.md) — **現在の事実**。バックエンド、マネージャー、エンドポイント、ペルソナ ナレッジ、WebGUI、およびデスクトップ モジュール マップ。
- [メッセージ検索のインデックス作成と待ち時間のバジェット](message-history-search_en.md) 開発者メンテナンス: インデックスの更新、凍結されたスナップショット、3 秒間のクライアント期限、リカバリおよび容量の受け入れ範囲。
- [プロジェクト機能マップ](project-function-map_en.md) — **現在の事実**。成熟度、副作用、API、コード所有者ごとに動作を特定します。
- [パスとディレクトリの規則](path-and-directory-conventions_en.md) — **現在のメンテナーガイド**。ソフトウェア、パブリック サンプル、ローカル ランタイム データ、ログを分離し、相対パスとビジネス ID インターフェイスを定義します。
- [プロジェクトのスキル分布とドリフト検出](project-skill-distribution_en.md) — **現在のメンテナーガイド** プロジェクトの下で RabiRoute が所有するスキルのローカライズされたコピーの場合 `.agents/skills/`、記録されたベースライン、および移植前に上流のドリフトを報告するためにエージェントが実行する読み取り専用コマンド。
- [プル リクエスト セキュリティ ゲート](maintainer-security-gates_en.md) — **現在のメンテナーガイド** シークレットスキャン、プロダクション依存関係監査、CodeQL、最小特権、およびマージ保護用。
- [マネージャーのランタイム復元力とインシデントの証拠](manager-runtime-resilience_en.md) — **現在のガイド** クラッシュログ、単一インスタンス保護、非致命的ペルソナインデックス永続性、ウォッチドッグバックオフ、およびソーク受け入れ。

## 実験的な統合

- [リモートエージェントのセットアップとアップデート](lan-rabi-agent-bootstrap_en.md) — **実験的統合**。 RabiLink → Remote Agent (中国語では远端智能体) を開き、セットアップ プロンプトをコピーし、別のコンピュータに接続し、そのエージェントを管理し、それらをルート ハンドラとして選択します。
- [モバイルレコーディングインターフェース](rabilink-mobile-recording-ui_en.md) - 4 ページのナビゲーション、キャプチャ モード、オフライン ストレージ、セッション リプレイ、および互換性境界。
- [オフラインのメガネ録画とライブプレビュー](rabilink-offline-recording_en.md): 電話でグラス ストリームを録画し、ローカルで視聴します。デバイスの受け入れが進行中です。
- [Rokid の開発ソースとトラブルシューティング](rokid-development_en.md) - SDK ルート、公式ソースの読み取りステータス、インストールの証拠、および開発スキル。 CXR-Mは除きます。
- [Local YeYu Gamer Manager integration](yeyu-gamer-manager-integration_en.md) — **実験的統合**。ローカル ポート 8877 の修正、型指定されたヘルス/メタ/スナップショット/機能の読み取り、専用のエージェントによるプランのみのエージェント作業項目の作成 `rabiroute.token`;デフォルトでは無効になっており、ライブ インストールの受け入れが保留されています。
- [インストールファイルのリカバリとオフラインダイアログの抽出](yeyu-install-file-recovery_en.md) − メンテナ互換性エントリポイント、スクリプト引数、および候補データ制限。インストール操作はありません。
- [WeCom 統合](wecom-integration_en.md)
- [Feishu エンドポイントの統合](feishu-integration_en.md) - エンタープライズ アプリのイベント コールバック、署名/暗号化チェック、永続的な重複排除、およびソース チャット テキスト応答。
- [ビデオ生成プラグイン](video-generation-plugin_en.md) - このコンピュータまたは接続されているコンピュータ上のモデルを選択し、生成ジョブを送信し、現在のワークスペースで作業を保存、プレビュー、またはダウンロードします。
- [音声対話ワークステーション](voice-interaction-workstation_en.md) - 歴史的な配線。 FenneNote/OumuQ は廃止され、RabiPC + RabiSpeech が使用されます。
- [RabiSpeech ローカル TTS / ASR サービス](rabispeech-plugin_en.md) - 直接 API、ホット/ペルソナ キーワード配信、ペルソナ音声と言語、双方向 ASR/TTS レコード、不透明な声紋/クラスター証拠、RabiPC、および RabiLink リレー。選択テキスト メニューの読み取りサブ機能は、ホスト TTS をキューに入れることができます。
- [TTS および ASR をリモートで呼び出します](user-guide/speech-api_ja.md) - アプリケーション トークン、ターゲット PC、コピー可能なコマンド、受け入れ、およびエラー回復。
- [Rabi 音声クライアント](../desktop/rabi-voice-client/README_en.md) — セグメンテーションとモデルが RabiSpeech ホスト上にある間、会議室の Windows PC を LAN マイクおよびスピーカーとして使用します。
- [ローカル音声モデルのダウンロード](local-speech-model-downloads_en.md) - オンデマンドの重み付けにモデル管理を使用し、各 TTS/ASR モデルのソース、分離されたランタイム、および検証要件をレビューします。
- [RabiSpeechパフォーマンスレポート](rabispeech-performance-report_en.md) −6つのTTSモデルおよび5つの主要なASRモデル、コールド/ウォームタイミング、品質指標、ハードウェア、およびCUDAの問題。
- [音声サーバーと汎用トンネル](rabilink-peer-tunnel_en.md) - リモート音声サーバーを選択し、プレゼンス、実際のトランスポート、および往復遅延を検査します。
- [デバイスの発見と接続のシグナリング](rabilink-peer-rpc_en.md) 同じアプリケーション内のPCを見つけて、接続ハンドシェイクを理解する。使用 [個の一般的なトンネル](rabilink-peer-tunnel_en.md) すべての API 読み取り、書き込み、ストリーミング リクエスト。
- [RabiLink リレー](rabilink-relay-server_en.md)
- [RabiLink Cloudflare ワーカー](rabilink-relay-cloudflare-worker_en.md)
- [RabiLink メガネの 3 ルート比較](rabilink-glasses-route-comparison_en.md) - ホスト、ライフサイクル、デバイス機能、リリース コスト、およびネイティブ Lingzhu エージェント、AIUI、およびネイティブ アプリ ルートの現在のガイダンス。
- [Rabi モバイル メッセージ エンドポイント](mobile-message-endpoint_en.md) — **実験的統合** スタンドアロンの電話チャット、オプションのメガネ、信頼できるキュー、通知、添付ファイル、設定支援、およびデバイスの受け入れ境界用。
- [モバイル音声通話](mobile-voice-call_en.md) — **実験的実施**。チャットから音声会話を開始し、ミュート、ハングアップ、録音の復元、返信の遅さを理解します。
- [RabiLink フォン エッジ ハブ](rabilink-phone-edge-hub_en.md)
- [電話から PC へのダイレクト ビデオ](rabilink-direct-video_en.md) - 実験的シグナル伝達および直接輸送。カメラのキャプチャとクロスネットワークの受け入れは保留中のままです。
- [モバイル録音の所有権](mobile-recording-event-boundary_en.md) — デバイス構成、イベントの記録、レガシーの廃止に関する開発者向けリファレンス。
- [RabiLink ウェアラブル健康エンドポイント](rabilink-wearable-health_en.md) — **実験的統合** 電話設定、構造化された健康履歴、エージェントのクエリ、アラートしきい値、および Xiaomi ADB フォールバック用。
- [AIUI から電話/ネイティブ グラスへのパリティ チェックリスト](rabilink-aiui-native-parity_en.md) −コード、自動化、および実際のデバイスの証拠によって分離された移行ステータス。
- [AIUI 電話/デバイス プロファイル HTTP](aiui-agent-profile-http_en.md) — **実験的** 電話機の設定、デバイスの所有権、リビジョンの競合、およびアプリケーションの受領書。エンドツーエンドの受け入れは保留中です。
- [AIUI プロファイルのライフサイクル](../apps/rabilink-aiui/docs/agent-profile-runtime_en.md) - キャッシュ、現在のターン後の据え置きアプリケーション、およびモデルのステータス。
- [AIUIツール契約のレビュー](../apps/rabilink-aiui/docs/agent-tool-contract_en.md) - モデルとツールのイベント、継続契約、および受け入れ境界。
- [独立した RabiPC ナレッジ MCP](../apps/rabi-mcp/README_en.md) - 独立した MCP クライアント用の HTTP/stdio ツール。 RabiLink は、このサービスを展開せずに、組み込みの Manager 呼び出しを使用します。
- [ローカルナレッジブリッジ設定](user-guide/knowledge-bridge-settings_ja.md) — 接続後に PC ナレッジ ツールを使用し、サービスの準備状況とビジネスの結果を区別します。
- [電話の知識の許可](knowledge-grant-phone-ui_en.md) — 廃止されたKnowledge-Grantエディターから移行します。
- [PCナレッジブリッジ構成](rabilink-knowledge-runtime_en.md) − 既存のマネージャナレッジAPI、アプリケーション認証および準備チェック。
- [ナレッジ書き込みレシートの検索](rabilink-knowledge-operation-receipts_en.md) - 元の操作キーと実際のデバイスの資格情報を使用して、永続化されたレシートを照会します。未知の結果は決して再現されません。
- [新しい AIUI エージェントの受け入れ](aiui-agent-acceptance_en.md) メンテナンス:ビルド、ランタイム、ハードウェアウェイク、および音声インタラクションを新しい契約に対して検証する。保留中の基準を追跡します。
- [AIUI汎用APIトランスポート](../apps/rabilink-aiui/docs/generic-api-transport_en.md) - パブリック API、ターゲット コンピューター、ペルソナの所有権、および検証済みのトランスポート スコープ。
- [RabiLink AIUI の居住境界](rabilink-aiui-residency-plan_en.md)
- [RabiLink プロアクティブ インテリジェンスの要件](rabilink-active-intelligence-requirements_en.md) −ユーザ状態、シナリオ認識、グループメッセージ呼び出し後の計画/記憶の閉鎖、および介入決定のためのターゲット契約および実装追跡装置。
- [RabiLink ネイティブ アプリの設計](rabilink-glasses-app-design_en.md)
- [XiaoAI統合ルート](xiaoai-integration/xiaoai-rabiroute-intercept-route_en.md)
- [IRゲートウェイの研究](xiaoai-integration/ir-remote-gateway-research_en.md)
- [Xiaomi Band心拍数プローブハンドオフ](xiaomi-band-heart-rate-probe-handoff_en.md)

## デザインと歴史

- [ペルソナ中心の構成アーキテクチャ](role-centric-architecture_en.md) - 独立したペルソナの選択と構成、プランとメモリ、ルート バインディング、アーカイブ/復元、保護された永久削除。ソースの収集と分離された検証。この変更ではインストールは行われません。

- [RabiLink 統合終日録画設計](rabilink-all-day-recording_en.md) — **設計/実装が進行中ですが、エンドツーエンドでは受け入れられません**。携帯電話、メガネ、時計のコーディネート オーナーは 1 人。独立モード/一時停止、通知、永続的な記録/文字起こし、プライバシー境界、ロスレス移行および受け入れ契約。
- [プロアクティブインテリジェンスシステム設計の概要](../主动智能设计思路_en.md) — **計画済み**。ユーザー モデリング、シナリオ、プロアクティブなアクション、メモリ、デバイスの責任について説明します。実装ステータスについては、「現在の機能」を参照してください。
- [会話型メッセージ収集、メッセージグループ、および4つのエージェントによるコラボレーション](group-message-batching-and-triage-plan_en.md) — **実験的**。自然言語トラフィックは即座に記録され、バッチにまとめられ、引用されたメッセージのエージェント セッション、以前のメッセージ グループ、会話、話者、およびエンドポイントの親密度を組み合わせたランキングによって動的 Codex メッセージ エージェントに送信されます。ライブ グループ/DM および 4 人のエージェントによる完全な受け入れは保留中です。
- [ロールルートワークベンチ計画](persona-route-workbench-plan_en.md) — **部分的に実装**。音声キーワードおよびエンドポイントごとのコンテキスト制御はライブです。副作用のない RouteDecision/AgentPacket プレビューは実装されていません。
- [エージェント エンドポイントとしての WorkBuddy](workbuddy-agent-adapter-plan_en.md) — **手動認証ステップ 1 つで実装**。 WorkBuddy タスクをハンドラーとして接続する: セッション プロセス記述子、タスクの真実のソース、ローカル ゲートウェイ API、配信本体の形状、および同一 ID の再配信はすべて測定によって検証されます。ゲートウェイ資格情報はローカルの無視されるファイルに一度記録され、成熟度は維持されます。 `experimental`.
- [Windows トレイのタスク ウィンドウ プラン](rabiroute-windows-tray-task-window-plan_en.md) - 設計記録。使う `desktop/tray-task-window/` および実際の実装のためのパッケージングガイド。
- [UE/UXの監査とリファクタリング](rabiroute-ue-ux-audit-and-refactor_en.md) - フェーズ監査。
- [過去のモバイルアプリ Webhook プラン](mobile-app-webhook-integration_en.md) — **歴史的**。現在の RabiLink パスでは、メイン リレーとして電話ブリッジは必要なくなりました。

ビルド可能なクライアントは以下に存在します [`apps/`](../apps/README_en.md)、以下の再利用可能な SDK [`packages/`](../packages/README_en.md)、および以下のコピー可能なサンプル [`examples/`](../examples/README_en.md).

## ステータスの定義

|ステータス |意味 |
| --- | --- |
|現在の事実 |コード、スキーマ、WebGUI、およびテストに対してチェックされます。現在のバージョンの公開位置としては安全です。 |
|現在のガイド |実装された動作をカバーしますが、コードの進化に応じて継続的にレビューする必要があります。 |
|実験的な統合 |コード エントリは存在しますが、外部システムまたはハードウェア パスは依然として環境固有の受け入れを必要とします。 |
|更新が必要 |有用な内容が含まれていますが、古い記述や矛盾する記述が含まれていることが知られています。現在の機能を優先します。 |
|計画中 |実装されたループではなく、提案、要件、またはロードマップ。 |
|歴史 |現在のプライマリ パスではなく、置き換えられたパス、調査記録、またはハンドオフ。 |


## 文書の保守

1. 中国のファクトソースを更新する前に、コード、スキーマ、API、WebGUI、およびテストをチェックする。
2. 動作が正確になった後でのみ、英語版を手動で保守してください。古い文書をバッチ翻訳しないでください。
3. 設計文書は、現在の機能リストに表示されるのではなく、「計画」または「履歴」とラベル付けされなければなりません。
4. ランタイムセマンティックマークダウン (`AGENTS.md`, `SKILL.md`、ペルソナ、プロンプト、記憶、計画など)を機械的に翻訳してはなりません。
