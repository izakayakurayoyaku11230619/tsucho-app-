# AI Office

AI社員が会議室・デスクを歩き回る様子をUnityで表示するプロトタイプ。

- `server/` FastAPI。`POST /start_project`(JSON `{"prompt": "..."}`)で開始、`GET /state` で各AIの状態を返す。
- `unity/` Unityのスクリプト。`AIApiClient` が1秒ごとに `/state` を取得し、`AICharacterController` を動かす。

## サーバー

    cd server
    pip install -r requirements.txt
    uvicorn main:app --reload

    curl -X POST localhost:8000/start_project -H 'Content-Type: application/json' -d '{"prompt":"LPを作る"}'
    curl localhost:8000/state

役割は8人で1人ずつ(CEO / Secretary / PM / Designer / Illustrator / Editor / Programmer / DataScientist)。流れは、最初の5秒は全員で会議、5〜10秒は社長が指示、そのあと各担当が作業(秘書とマネージャーは長め)、20〜25秒は会議室でレビュー。各AIの動きは `AGENTS` の `timeline` で変える。`POST /start_project` の `members` で参加する役割を絞れる(省略すると全員。画面からは外せない)。プロジェクトは `project_id` ごとに複数持てて、重なった場合は最後に始めたものを優先する。`GET /projects` で一覧を返す。タスク分解(`decompose_task`)は、環境変数 `ANTHROPIC_API_KEY` があれば Claude API で行い、なければ(または失敗したら)固定のタスクを返す。モデルは `AI_OFFICE_MODEL` で変えられる(既定 `claude-sonnet-5-5`)。

## ブラウザで見る(Unity不要)

サーバーを起動して http://localhost:8000/ を開く。キャラ選択画面(`server/static/select.jpg` の絵にボタンを重ねてある)で8人全員が参加することを確認し(外せない)、社長への指示を入れて「開始」を押すと、AIが会議室と自席を歩き回る。

## Unity

1. `unity/` の4つの `.cs` を `Assets/` に入れる。
2. キャラに `AICharacterController` を付け、`agentId`(上の8つのid)、Animator、デスクと会議室のTransformを設定する。
3. Animatorに bool `IsWalking` / `IsTyping` / `IsTalking` を作る。
4. 空のGameObjectに `AIApiClient` を付け、`characters` に全キャラを登録する。
5. ボタンから `AIApiClient.StartProject("...")` を呼ぶ。
