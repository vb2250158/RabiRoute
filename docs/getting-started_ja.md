<!-- docs-language-switch -->
<div align="center">
<a href="./getting-started_en.md">English</a> | <a href="./getting-started.md">简体中文</a> | 日本語
</div>
<!-- /docs-language-switch -->

# はじめに

> ステータス: 現在のガイド。現在の Manager、RibiWebGUI、Codex Desktop 所有者、および NapCat セットアップ フローに対してチェックされました。参照 [現在の能力](current-capabilities_ja.md) 実験的な統合を可能にする前。

## 要件

- Node.js 20以降。
- QQ用のNapCat/OneBot環境。 RibiWebGUI を検査するか、ハートビート/手動イベントをテストするだけの場合は、QQ をスキップできます。
- オプションだが推奨される:Codex、検証済みハンドラー統合。

## インストールして開始します

Windows インストーラーは、[スタート] メニューから RabiRoute Host を起動します。ホストは、同じ世代のマネージャーとトレイの子を作成し、オペレーティング システムによって割り当てられたマネージャー URL をトレイに渡します。トレイから RibiWebGUI を開きます。繰り返し起動すると、既存のホストがアクティブになります。
リポジトリルート内の

完全な Windows ソース ビルドの場合は、ダブルクリックします。 `Start-RabiRoute-FromSource.bat` 。既存の Windows RabiRoute インストール、Node.js/npm、および .NET 9 SDK が必要です。マネージャー、WebGUI、プラグイン、ホスト、トレイをビルドし、インストールされた設定とデータを保持しながら、ホストを通じてソース ビルドをアクティブ化します。最初のビルドでは、Python/Qt の依存関係がダウンロードされます。コマンド ウィンドウを閉じてもホストは停止しません。トレイから離れます。失敗ログが入っています `logs/source-start/`。依存関係ロックがインストールされているパッケージと異なる場合は、最初に完全なインストールを更新してください。

### Linuxホスト

Linux には Node.js 22.13+、npm、および util-linux が必要です `flock`;インストールする `xdg-utils` ホスト使用時 `open` ブラウザを起動します。既存の WebGUI を起動するには:

1. チェックアウトを入力し、最初のビルド/開始スクリプトを実行します。

   ```bash
   cd /path/to/RabiRoute
   bash Start-RabiRoute-FromSource.sh
   ```

2. その後 `npm ci` 完全なビルドでは、ホストはバックグラウンドで実行されます。ステータスをクエリし、返されたものを開きます `managerBaseUrl`:

   ```bash
   npm run status:linux -- --json
   node scripts/linux-host.mjs --command open
   ```

3. 自動統合を行わずにページを検査するには、既存のホストを終了してから次のコマンドを実行します。 `npm run start:linux -- --foreground --read-only`。通常の書き込み可能な起動では、ローカル デバイス ID が作成されます。読み取り専用モードでは、永続的なトンネル キーは作成されませんが、ランタイム ログとリースが書き込まれます。
4. 既存のビルドの場合は、次を使用します。 `npm run start:linux`;シャットダウンをリクエストする `npm run stop:linux`。ログは次の場所にあります `<stateRoot>/logs/linux-host/host.log`;リポジトリはデフォルトの状態のルートです。代替ステート ルートは絶対パスである必要があります。

このLinuxパスには、Windows/Qtトレイ機能、スクリーンショット、またはグローバルホットキーが含まれず、サービスもインストールされない。手動で指定した検証済みのリレー URL と再利用可能なアプリケーション トークンを使用して、既存のページから RabiLink を構成します。保存すると接続が維持されます。同じアプリケーション内の認証されたデバイスは、このコンピュータによって実際に提供されるすべてのサービスを使用できます。参照 [Linuxホスト](linux-host_en.md) 完全なコマンド、セキュリティ、およびプロセスクリーンアップ境界について。 Real Relay、2 デバイス、および耐久性の受け入れは保留中です。

### バックエンドのみの開発

以下のエントリ ポイントは、トレイを使用しない Windows/macOS バックエンドのみの開発用です。日常の Linux 操作には上記のホストを使用してください。

Windows PowerShell:

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

macOS:

```bash
cd /path/to/RabiRoute
npm install
npm run build
npm run start:manager
```

マネージャは、実際のアドレスを stdout に出力します。たとえば、次のようになります。

```text
RabiRoute manager listening at <managerBaseUrl>
```

そのランを使用してください `<managerBaseUrl>` 1つのポートを永続的なデフォルトとして保存する代わりに。他の統合では、独自に構成されたエンドポイントが保持されます。

- NapCatリバースWebソケット: `ws://127.0.0.1:8789`
- NapCat OneBot HTTP: `http://127.0.0.1:3000`

## 最初のルート

通常の書き込み可能なクリーンスタートでは、マネージャは完全なパブリックファイルをコピーすることを好みます。 `examples/data` にパッケージ化 `data/`。のみ `main` ルートはデフォルトで有効になっています。実験的な例は、認証情報、ポート、ワークスペースが設定されるまで無効のままです。サンプルが利用できない場合でも、マネージャーは最小限の QQ/NapCat-to-Codex セットアップを作成できます。

RibiWebGUI で、次を確認します。

- **メッセージアダプター**: NapCat/OneBot とハートビートが通常の開始時の選択肢です。
- **ハンドラー**: Codex、固定スレッド名、およびプロジェクト ワークスペースを選択します。
- **ルート**:WebSocket/HTTPポート、Webhook設定、ハンドラーCWD、およびロールバインディングを検証します。
- **ペルソナ**: パブリックなどのペルソナを選択または作成します `Rabi` 例。
- **ペルソナの自動化**: 使用します **メッセージの到着時 / スケジュールされたタスク** トリガーを選択し、エージェントに通知するか、ペルソナスクリプトを実行します。

マニュアル用 `personaConfig.json` 編集、参照 [ルーティング構成](routing-configuration_en.md).

例を手動でコピーするには:

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

QQフリーのスモークテストの場合、スケジュールされたタスクを有効にする。構成されたスクリプト アクションは、所有者のペルソナのスクリプト ディレクトリ内のファイルを実行します。

## Codexのセットアップ

Codexは、検証されたハンドラパスである。設定:

- `agentAdapters: ["codex"]`.
- `codexThreadId`:RibiWebGUIによって保存された不透明なデスクトップタスクID。
- `codexThreadName`: 表示されるタスク名 (例: `QQ message listener`.
- `codexCwd`:Codexが動作するプロジェクトディレクトリ。

有効な保存済み Codex ID は安定したタスク ID ですが、設定された作業ディレクトリが次のターンを制御します。別の保存済みデフォルト cwd、デスクトップの名前変更、古い SQLite タイトル、または完了した目標は重複を作成しません。新しい名前を入力すると、古い ID が明示的にクリアされます。その場合のみ、RabiRoute は名前とワークスペースで検索するか、空のタスクを作成できます。

実際の配信には、Codex/ChatGPT デスクトップが実行されている必要があります。 RabiRoute はデスクトップ IPC を使用し、再試行する前にアンロードされたタスクをディープリンクする場合があります。プロジェクトに固定されたアプリサーバーは、空のタスクを作成して名前を付けるためにのみ使用されます。ルーティングされたプロンプトは決して実行されません。

## NapCat のセットアップ

NapCat WebUI で次のように設定します。

- WebSocketクライアント: `ws://127.0.0.1:8789`
- HTTPサーバー:ホスト `127.0.0.1`、ポート `3000`

WebSocketは、インバウンドQQイベントを搬送する。 OneBot HTTP は、返信とプロアクティブな送信に使用されます。必要に応じてプラグイン/ネットワーク設定を変更した後、NapCat ネットワークを再起動またはリロードします。

起動とクイックログインの動作については、以下を参照してください。 [NapCat 無人起動](napcat-unattended_en.md)。 QQ 資格情報と検証は、RabiRoute ゲートウェイ定義には決して属しません。

## Windows 上の中国語テキスト

PowerShell を使用して中国語の JSON を手動で構築することを避ける `Invoke-WebRequest`;リクエストのエンコードが一貫していない可能性があります。プロジェクト スクリプトを使用します。

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "Unicode test\nSecond line"
```

以下を使用してルート/ペルソナ JSON を検証します。

```powershell
npm run check:config
```

WebUI テキスト領域では実際の改行を使用します。保存時に JSON シリアル化を一度エスケープさせます。

## パスを確認します

1. Windows ホストまたは Linux ホストを起動し、現在のホストを取得します。 `managerBaseUrl` ホストから。バックエンドのみの開発の場合は、現在の Manager 起動出力を記録します。
2. トレイから RibiWebGUI を開くか、 `<managerBaseUrl>` ルートが実行されていることを確認します。
3. NapCat がポート 8789 に接続されていることを確認します。
4. QQグループ内のボットに言及し、プライベートメッセージを送信し、またはハートビート/手動トリガを実行する。
5. 検査する `data/route/<configName>/` メッセージと `agent-packets.jsonl` レコード。
6. Codex の場合、設定されたスレッドがパケットを受信することを確認します。

## 開発コマンドとエントリ ポイント

```powershell
npm run build
npm run start:manager
npm run manager
```

- `src/manager.ts`: 設定、ルートプロセスのライフサイクル、および RibiWebGUI API。
- `src/index.ts`: 1 つのゲートウェイ サブプロセス。
- `src/adapters/`:メッセージプロトコルアダプタ。
- `src/forwarding.ts`: ルールの評価、パケットの構築、およびハンドラーの配信。
- `src/history.ts`: JSONL レコード。
