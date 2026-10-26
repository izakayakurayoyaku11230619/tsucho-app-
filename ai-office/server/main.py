import json
import logging
import os
import time
import uuid
from enum import Enum
from pathlib import Path

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


def fallback_tasks(prompt: str) -> list[str]:
    return [f"『{prompt}』の要件を整理する", "デザイン案を作る", "文章を整えてレビューする"]


def decompose_task(prompt: str) -> list[str]:
    """社長AIがタスクを分解する。ANTHROPIC_API_KEY がないか失敗したら固定のタスクを返す。"""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return fallback_tasks(prompt)
    try:
        import anthropic

        res = anthropic.Anthropic().messages.create(
            model=MODEL,
            max_tokens=500,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        tasks = json.loads(res.content[0].text)
        if isinstance(tasks, list) and tasks and all(isinstance(t, str) for t in tasks):
            return tasks[:5]
    except Exception:
        logging.exception("タスク分解に失敗したので固定のタスクを使います")
    return fallback_tasks(prompt)


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
        "started_at": time.time(),
    }
    return {
        "project_id": project_id,
        "message": f"社長が『{req.prompt}』のプロジェクトを開始しました。",
        "tasks": projects[project_id]["tasks"],
    }


@app.get("/projects")
def list_projects():
    now = time.time()
    return [
        {
            "project_id": pid,
            "prompt": p["prompt"],
            "tasks": p["tasks"],
            "members": sorted(p["members"]),
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
