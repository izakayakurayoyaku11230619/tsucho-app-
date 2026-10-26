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

開始から5秒は全員 Meeting、その後20秒 Working、その後 Idle。Engineer は会議のあと8秒待ってから Working(`AGENTS` の `work_delay`)。プロジェクトは `project_id` ごとに複数持てて、重なった場合は最後に始めたものを優先する。`GET /projects` で一覧を返す。タスク分解は `decompose_task` にLLM呼び出しを入れる。

## Unity

1. `unity/` の4つの `.cs` を `Assets/` に入れる。
2. キャラに `AICharacterController` を付け、`agentId`(`CEO` / `Designer` / `Engineer`)、Animator、デスクと会議室のTransformを設定する。
3. Animatorに bool `IsWalking` / `IsTyping` / `IsTalking` を作る。
4. 空のGameObjectに `AIApiClient` を付け、`characters` に全キャラを登録する。
5. ボタンから `AIApiClient.StartProject("...")` を呼ぶ。
