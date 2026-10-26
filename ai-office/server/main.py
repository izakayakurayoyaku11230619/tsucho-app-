import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from enum import Enum
from pathlib import Path

from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

app = FastAPI(title="AI Office")

PROJECT_SECONDS = 25


class State(str, Enum):
    IDLE = "Idle"
    MEETING = "Meeting"
    WORKING = "Working"


M, W = State.MEETING, State.WORKING


class StartRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    # 参加させる役割のid。省略すると全員参加。社長(CEO)は常に参加する。
    members: list[str] | None = None


class Agent:
    def __init__(self, id: str, name: str, role: str, timeline: list[tuple[float, float, State]]):
        self.id = id
        self.name = name
        self.role = role
        # (開始秒, 終了秒, 状態)。どこにも当てはまらない間は Idle(自分の席で待機)。
        self.timeline = timeline


# 流れ: 全員で会議 → 社長が指示 → 各担当が作業 → 会議室でレビュー
AGENTS = [
    Agent("CEO", "社長AI", "CEO", [(0, 5, M), (5, 10, W), (20, 25, M)]),
    Agent("Secretary", "秘書AI", "Secretary", [(0, 5, M), (5, 25, W)]),
    Agent("PM", "マネージャーAI", "PM", [(0, 5, M), (5, 20, W), (20, 25, M)]),
    Agent("Designer", "デザイナーAI", "Designer", [(0, 5, M), (10, 20, W), (20, 25, M)]),
    Agent("Illustrator", "イラストAI", "Illustrator", [(0, 5, M), (10, 20, W), (20, 25, M)]),
    Agent("Editor", "編集者AI", "Editor", [(0, 5, M), (10, 20, W), (20, 25, M)]),
    Agent("Programmer", "プログラマーAI", "Programmer", [(0, 5, M), (8, 20, W), (20, 25, M)]),
    Agent("DataScientist", "データ分析AI", "DataScientist", [(0, 5, M), (10, 18, W), (20, 25, M)]),
]
AGENT_IDS = {a.id for a in AGENTS}

# project_id -> {"prompt", "tasks", "members", "started_at"}
projects: dict[str, dict] = {}


MODEL = os.environ.get("AI_OFFICE_MODEL", "claude-sonnet-5-5")

SYSTEM_PROMPT = (
    "あなたは小さな会社の社長AIです。ユーザーの依頼を、マネージャーAI・デザイナーAI・イラストAI・編集者AI・プログラマーAI・データ分析AIが"
    "進められる3〜5個のタスクに分解してください。"
    "出力は日本語の短い文字列のJSON配列のみ(前置きやコードブロックは不要)。"
)


# 画面から入れたAPIキー。サーバーのメモリにだけ置き、ファイルやログには書かない。
_api_key: str | None = None
_pool = ThreadPoolExecutor(max_workers=4)

ROLE_PROMPTS = {
    "CEO": "社長AIとして、プロジェクトの方針と成功の基準を3行でまとめる",
    "Secretary": "秘書AIとして、進行スケジュール(日程の目安)と必要な資料の一覧を作る",
    "PM": "マネージャーAIとして、作業の順番・担当・リスクを短い表形式でまとめる",
    "Designer": "デザイナーAIとして、コンセプトを2つ出し、それぞれ色・雰囲気・レイアウトを説明する",
    "Illustrator": "イラストAIとして、必要なイラストの一覧と、それぞれの描き方の指示を書く",
    "Editor": "編集者AIとして、キャッチコピー案を3つと、本文の構成案を書く",
    "Programmer": "プログラマーAIとして、実装の方針と主なファイル構成を書く",
    "DataScientist": "データ分析AIとして、見るべき指標と、効果の測り方を書く",
}


def get_client():
    key = _api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    import anthropic

    return anthropic.Anthropic(api_key=key)


def engine() -> str | None:
    """使うAIの種類。APIキーがあれば "api"、なければ PC の Claude Code(`claude` コマンド)を使う。"""
    if _api_key or os.environ.get("ANTHROPIC_API_KEY"):
        return "api"
    if shutil.which("claude"):
        return "claude_code"
    return None


def llm(system: str, user: str, max_tokens: int) -> str:
    """文章を1つ返す。どちらの方式でも同じ呼び方で使える。"""
    kind = engine()
    if kind == "api":
        res = get_client().messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return res.content[0].text
    if kind == "claude_code":
        # ログイン済みの Claude Code に1回だけ質問する。入力は標準入力で渡し、
        # 作業フォルダは空の一時フォルダにして、手元のファイルを読ませない。
        prompt = f"{system}\n\nツールやファイルは使わず、文章だけで答えてください。\n\n{user}"
        with tempfile.TemporaryDirectory() as tmp:
            res = subprocess.run(
                ["claude", "-p"], input=prompt, capture_output=True, text=True, timeout=180, cwd=tmp
            )
        if res.returncode != 0:
            raise RuntimeError(f"claude コマンドが失敗しました (code {res.returncode})")
        return res.stdout.strip()
    raise RuntimeError("AIが使えません")


def fallback_tasks(prompt: str) -> list[str]:
    return [f"『{prompt}』の要件を整理する", "デザイン案を作る", "文章を整えてレビューする"]


def decompose_task(prompt: str) -> list[str]:
    """社長AIがタスクを分解する。AIが使えないか失敗したら固定のタスクを返す。"""
    if engine() is None:
        return fallback_tasks(prompt)
    try:
        text = llm(SYSTEM_PROMPT, prompt, 500)
        found = re.search(r"\[.*\]", text, re.S)  # 前置きがついても配列だけ取り出す
        tasks = json.loads(found.group(0) if found else text)
        if isinstance(tasks, list) and tasks and all(isinstance(t, str) for t in tasks):
            return tasks[:5]
    except Exception:
        logging.exception("タスク分解に失敗したので固定のタスクを使います")
    return fallback_tasks(prompt)


def make_output(project: dict, role: str) -> None:
    """各AIが実際の成果物を書く。結果は project["outputs"][role] に入る。"""
    outputs = project["outputs"]
    try:
        if engine() is None:
            outputs[role] = {"status": "no_key", "text": "APIキーを設定するか、PCで Claude Code を使える状態にすると、ここにこの役割の成果物が出ます。"}
            return
        outputs[role] = {"status": "working", "text": ""}
        text = llm(
            f"あなたは小さな会社の社員AIです。{ROLE_PROMPTS[role]}。日本語で、簡潔に、見出しや箇条書きを使ってください。",
            f"依頼: {project['prompt']}\nタスク: " + " / ".join(project["tasks"]),
            700,
        )
        outputs[role] = {"status": "done", "text": text}
    except Exception:
        logging.exception("成果物の作成に失敗: %s", role)
        outputs[role] = {"status": "error", "text": "成果物を作れませんでした。APIキーかClaude Codeのログインを確かめてください。"}


def state_in_project(agent: Agent, project: dict, now: float) -> State:
    if agent.id not in project["members"]:
        return State.IDLE
    elapsed = now - project["started_at"]
    for start, end, state in agent.timeline:
        if start <= elapsed < end:
            return state
    return State.IDLE


def agent_state(agent: Agent, now: float) -> tuple[State, str | None]:
    """複数プロジェクトが重なったら、最後に始まった(動いている)ものを優先する。"""
    for pid, project in sorted(projects.items(), key=lambda kv: -kv[1]["started_at"]):
        if agent.id in project["members"] and now - project["started_at"] < PROJECT_SECONDS:
            return state_in_project(agent, project, now), pid
    return State.IDLE, None


def target_for(state: State) -> str:
    return {
        State.MEETING: "MeetingRoom",
        State.WORKING: "Desk",
        State.IDLE: "Desk",
    }[state]


@app.post("/start_project")
def start_project(req: StartRequest):
    requested = AGENT_IDS if req.members is None else set(req.members)
    unknown = [m for m in requested if m not in AGENT_IDS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown members: {unknown}")
    members = {"CEO", *requested}
    project_id = uuid.uuid4().hex[:8]
    projects[project_id] = {
        "prompt": req.prompt,
        "members": members,
        "tasks": decompose_task(req.prompt),
        "outputs": {},
        "started_at": time.time(),
    }
    for role in members:
        _pool.submit(make_output, projects[project_id], role)
    return {
        "project_id": project_id,
        "message": f"社長が『{req.prompt}』のプロジェクトを開始しました。",
        "tasks": projects[project_id]["tasks"],
    }


class KeyRequest(BaseModel):
    key: str = Field(min_length=10, max_length=300)


@app.get("/settings")
def get_settings():
    """キー自体は返さない。どのAIを使うかだけ返す。"""
    return {"engine": engine(), "has_key": bool(_api_key or os.environ.get("ANTHROPIC_API_KEY")), "model": MODEL}


@app.post("/settings/api_key")
def set_api_key(req: KeyRequest):
    global _api_key
    _api_key = req.key.strip()
    return {"has_key": True}


@app.delete("/settings/api_key")
def clear_api_key():
    global _api_key
    _api_key = None
    return {"engine": engine()}


@app.get("/projects")
def list_projects():
    now = time.time()
    return [
        {
            "project_id": pid,
            "prompt": p["prompt"],
            "tasks": p["tasks"],
            "members": sorted(p["members"]),
            "outputs": p["outputs"],
            "elapsed": round(now - p["started_at"], 1),
            "duration": PROJECT_SECONDS,
            "done": now - p["started_at"] >= PROJECT_SECONDS,
        }
        for pid, p in sorted(projects.items(), key=lambda kv: -kv[1]["started_at"])
    ]


@app.get("/state")
def get_state():
    """Unityが定期的に取得する。JsonUtilityが辞書を読めないので配列で返す。"""
    now = time.time()
    agents = []
    for a in AGENTS:
        state, pid = agent_state(a, now)
        agents.append({
            "id": a.id,
            "name": a.name,
            "state": state.value,
            "target": target_for(state),
            "project_id": pid or "",
            "project": projects[pid]["prompt"] if pid else "",
        })
    return {"agents": agents}


# ブラウザ用ビューア。API のルートより後に置く。
app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
