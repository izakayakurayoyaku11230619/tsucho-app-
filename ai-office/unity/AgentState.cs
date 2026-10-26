using System;

public enum AgentState
{
    Idle,
    Meeting,
    Working,
}

[Serializable]
public class AgentDto
{
    public string id;
    public string name;
    public string state;
    public string target;
    public string project_id;
    public string project;
}

[Serializable]
public class StateResponse
{
    public AgentDto[] agents;
}
