import json
import logging
import os
import time
import uuid
from enum import Enum

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="AI Office")

MEETING_SECONDS = 5
WORKING_SECONDS = 20


class State(str, Enum):
    IDLE = "Idle"
    MEETING = "Meeting"
    WORKING = "Working"


class StartRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)


class Agent:
    def __init__(self, id: str, name: str, role: str, work_delay: float = 0):
        self.id = id
        self.name = name
        self.role = role
        # 会議のあと、この秒数だけ待ってから作業を始める(デザイン完了待ちなど)
        self.work_delay = work_delay


AGENTS = [
    Agent("CEO", "社長AI", "CEO"),
    Agent("Designer", "デザイナーAI", "Designer"),
    Agent("Engineer", "エンジニアAI", "Engineer", work_delay=8),
]

# project_id -> {"prompt", "tasks", "started_at"}
projects: dict[str, dict] = {}


MODEL = os.environ.get("AI_OFFICE_MODEL", "claude-sonnet-5-5")

SYSTEM_PROMPT = (
    "あなたは小さな会社の社長AIです。ユーザーの依頼を、デザイナーAIとエンジニアAIが"
    "進められる3〜5個のタスクに分解してください。"
    "出力は日本語の短い文字列のJSON配列のみ(前置きやコードブロックは不要)。"
)


def fallback_tasks(prompt: str) -> list[str]:
    return [f"『{prompt}』の要件を整理する", "デザイン案を作る", "実装する"]


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
    elapsed = now - project["started_at"]
    if elapsed < MEETING_SECONDS:
        return State.MEETING
    work_start = MEETING_SECONDS + agent.work_delay
    if work_start <= elapsed < work_start + WORKING_SECONDS:
        return State.WORKING
    return State.IDLE


def agent_state(agent: Agent, now: float) -> tuple[State, str | None]:
    """複数プロジェクトが重なったら、最後に始まった(動いている)ものを優先する。"""
    for pid, project in sorted(projects.items(), key=lambda kv: -kv[1]["started_at"]):
        state = state_in_project(agent, project, now)
        if state != State.IDLE or now - project["started_at"] < MEETING_SECONDS + agent.work_delay:
            return state, pid
    return State.IDLE, None


def target_for(state: State) -> str:
    return {
        State.MEETING: "MeetingRoom",
        State.WORKING: "Desk",
        State.IDLE: "Desk",
    }[state]


@app.post("/start_project")
def start_project(req: StartRequest):
    project_id = uuid.uuid4().hex[:8]
    projects[project_id] = {
        "prompt": req.prompt,
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
    return [{"project_id": pid, "prompt": p["prompt"], "tasks": p["tasks"]} for pid, p in projects.items()]


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
