<!-- docs-language-switch -->
<div align="center">
<a href="./speech-api_en.md">English</a> | <a href="./speech-api.md">简体中文</a> | 日本語
</div>
<!-- /docs-language-switch -->

# TTS および ASR をリモートで呼び出します

このガイドを使用して、別のコンピュータ、電話バックエンド、または自動化クライアントから、RabiLink Relayを介して、選択されたRabi PC上でRabiSpeechを呼び出す。通常の TTS およびファイル ASR リクエストは、音声または文字起こしを直接返し、エージェント、ペルソナ、ルート、または会話台帳には入力されません。継続的な Android/メガネ PCM ストリーミングは明示的な例外です。PC ASR の後、自動的にホスト全体の音声ストアに入り、 `rabilink` ルート。

> 成熟度:実験的。運用クライアントを統合する前に、制御された環境でモデル、タイムアウト、およびパブリック リバース プロキシを検証します。

## 正しいエントリ ポイントを選択してください

|発信者の所在地 |ベース URL |認証 |使用例 |
| --- | --- | --- | --- |
| Rabi PC 上 | `http://127.0.0.1:8781` |パブリックトークンがありません |ローカル スクリプトとプラグインのトラブルシューティング |
|任意のリモート クライアント | `https://<RELAY_ORIGIN>/api/rabilink/speech` |RabiLink **アプリケーショントークン** |電話バックエンド、その他のコンピュータ、制御されたサービス |

ループバックアドレスを別のデバイスにコピーしないでください。この API にはメガネ デバイス トークンを使用しないでください。音声通話にはアプリケーション トークンが必要です。

## リモートパスを準備する

1. ターゲットの Rabi PC を Relay に接続します **RabiLink → 設定**.
2. RabiSpeechを開始します **スピーチサービス** ターゲットPCがアドバタイズしていることを確認します `speech`。ローカル音声アドレスを RabiLink の高度な接続パラメータの下に保持します。 `http://127.0.0.1:8781`.
3. アプリケーションのリレー内 `/manage` ページで、オンライン Rabi PC を選択します。
4. アプリケーションのトークンをコピーする。リポジトリ、ログ、URL ではなく、一時的なプロセス変数またはシークレット ストアに保持します。

0.3.22から、同じRabiLinkアプリケーション内の認証されたデバイスは、追加の音声許可スイッチなしで、デフォルトでターゲットPCによって実際に提供されるサービスを使用することができる。 RabiSpeech が実行されている必要があります。マネージャーが宣伝します `speech` 正常に読み取った後にのみ `/v1/capabilities`。接続が成功しても、モデルがインストールされているか、準備ができていることは証明されません。以下のチェックを完了してください。

以下のコマンドは、Windows PowerShell とシステムを使用します。 `curl.exe`。まず 2 つの値を定義します。

```powershell
$RelayOrigin = "https://relay.example.com"
$Token = "<RABILINK_APP_TOKEN>"
$SpeechBase = "$RelayOrigin/api/rabilink/speech"
```

交換する `https://relay.example.com` はリレー HTTPS オリジンであり、 `<RABILINK_APP_TOKEN>` とアプリケーショントークン。

## 1. PC とモデルの在庫を確認します。

```powershell
curl.exe --fail-with-body --silent --show-error `
  "$SpeechBase/health" `
  -H "Authorization: Bearer $Token"

curl.exe --fail-with-body --silent --show-error `
  "$SpeechBase/v1/models" `
  -H "Authorization: Bearer $Token"
```

両方のコマンドは、成功すると JSON を返します。モデル インベントリは、リレー サーバーではなく、選択した PC から取得されます。

## 2. TTSオーディオを生成する

```powershell
curl.exe --fail-with-body --silent --show-error `
  -X POST "$SpeechBase/v1/audio/speech" `
  -H "Authorization: Bearer $Token" `
  -H "Content-Type: application/json" `
  --data-raw '{"input":"Hello from the RabiSpeech API through RabiLink.","voice":"default","response_format":"wav","sample_rate":16000,"speed":1.0}' `
  --output speech.wav

Get-Item .\speech.wav | Select-Object Name, Length
```

成功とは、HTTPリクエストが完了したことを意味し、 `speech.wav` には `Length` ゼロより大きい。ターゲット PC の RabiSpeech は WAV を適用します `sample_rate` ローカルで行われるため、リモート呼び出し元はffmpegを必要としません。 MP3、FLAC、Opus、AAC、および raw-PCM 出力は、ターゲット PC の ffmpeg 設定に依存します。モデルを選択するには、実際のモデル ID をコピーします。 `/v1/models` と追加します `model` を JSON ボディに追加します。

## 3.生成された音声を文字に起こす

上記で作成したファイルを使用します。

```powershell
curl.exe --fail-with-body --silent --show-error `
  -X POST "$SpeechBase/v1/audio/transcriptions" `
  -H "Authorization: Bearer $Token" `
  -F "file=@speech.wav" `
  -F "language=en" `
  -F "response_format=verbose_json"
```

呼び出しが成功すると、転写を含むJSONが返される。 `file` は必須です。 ASR モデルを選択するには、まず現在の ID を次から取得します。 `/v1/models`.

終了したら、現在のPowerShellセッションからトークンをクリアします。

```powershell
$Token = $null
```

## 一般的なエラー

|ステータス |意味 |対処 |
| --- | --- | --- |
| `401` |アプリケーショントークンがない、無効、またはリセット済み |対象アプリから再取得し、リクエストヘッダーを確認します。|
| `403` |デバイストークンなど未対応の資格情報 |アプリケーショントークンを使用します。|
| `404` |公開音声 API の対象外パス |`/api/rabilink/speech/...` の完全なパスを確認します。|
| `409` |利用可能な PC が未選択、または `speech` を提供していない |`/manage` で PC を選び、オンライン状態、RabiSpeech と `/v1/capabilities` を確認します。|
| `413` |音声サイズが現在の制限（既定 25 MiB）を超過 |音声を短縮または圧縮します。|
| `502` |対象 PC または RabiSpeech で処理失敗 |対象 PC のサービス状態とログを確認します。|
| `504` |モデル起動または処理がリレーの待機時間を超過 |ヘルスとウォームアップを確認し、必要に応じて設定可能な待機時間を調整します。|

パブリック許可リストは、マイクの開始/停止、ペルソナディレクトリ、モデルのダウンロード、およびPython拡張機能のロードを除外する。リモート呼び出し元は、ターゲット PC に既にインストールされている許可されたエンドポイントとモデルのみを使用できます。

## ローカル呼び出しに切り替える

対象 PC では `$SpeechBase` を `http://127.0.0.1:8781` に設定し、`Authorization` ヘッダーを外します。他の OpenAI 互換フィールドは同じです。

## ターゲットマシンレポートを開く

開く **音声サービス** ローカルまたはリモートの RibiWebGUI で、次を選択します **ターゲットマシンレポート**。リモート ページでは、レポートは現在の状態のままになります。 `/manage/<account>/<RabiGUID>/` 接頭辞。ここでは、指定されたテスト マシンのみについて説明しており、現在のクライアントのライブ パフォーマンスについては説明しません。

## APIリファレンス

- `GET /api/rabilink/speech/health`
- `GET /api/rabilink/speech/v1/models`
- `GET /api/rabilink/speech/v1/capabilities`
- `POST /api/rabilink/speech/v1/audio/speech`
- `POST /api/rabilink/speech/v1/audio/transcriptions`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/start`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/stop`
- `GET /api/rabilink/speech/openapi.json`

3 つのストリーミング エンドポイントは、連続 Android/メガネ 16 kHz モノラル PCM 用です。 `sequence` は 1 から始まり、連続したままでなければなりません。ターゲット PC RabiSpeech は、VAD、セグメンテーション、ASR、および声紋処理を所有しており、PCM を使用しない場合は 15 秒後にストリームをリタイアします。手動 TTS/ファイル ASR 呼び出し元は、上記の同期エンドポイントを使用し続けます。参照 [RabiSpeech ローカル TTS / ASR サービス](../rabispeech-plugin_en.md) フィールド、互換性エンドポイント、およびローカル拡張境界。
