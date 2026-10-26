import time
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
    def __init__(self, id: str, name: str, role: str):
        self.id = id
        self.name = name
        self.role = role


AGENTS = [
    Agent("CEO", "社長AI", "CEO"),
    Agent("Designer", "デザイナーAI", "Designer"),
]

# 単一プロジェクトのみ保持する簡易版。複数対応するならproject_idをキーにする。
project: dict | None = None


def decompose_task(prompt: str) -> list[str]:
    """社長AIがタスクを分解する。LLM APIに差し替える場所。"""
    return [f"『{prompt}』の要件を整理する", "デザイン案を作る"]


def current_state(now: float) -> State:
    if project is None:
        return State.IDLE
    elapsed = now - project["started_at"]
    if elapsed < MEETING_SECONDS:
        return State.MEETING
    if elapsed < MEETING_SECONDS + WORKING_SECONDS:
        return State.WORKING
    return State.IDLE


def target_for(state: State) -> str:
    return {
        State.MEETING: "MeetingRoom",
        State.WORKING: "Desk",
        State.IDLE: "Desk",
    }[state]


@app.post("/start_project")
def start_project(req: StartRequest):
    global project
    project = {
        "prompt": req.prompt,
        "tasks": decompose_task(req.prompt),
        "started_at": time.time(),
    }
    return {
        "message": f"社長が『{req.prompt}』のプロジェクトを開始しました。",
        "tasks": project["tasks"],
    }


@app.get("/state")
def get_state():
    """Unityが定期的に取得する。JsonUtilityが辞書を読めないので配列で返す。"""
    state = current_state(time.time())
    return {
        "project": project["prompt"] if project else None,
        "agents": [
            {"id": a.id, "name": a.name, "state": state.value, "target": target_for(state)}
            for a in AGENTS
        ],
    }
