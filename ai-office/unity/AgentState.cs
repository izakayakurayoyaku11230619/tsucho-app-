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
}

[Serializable]
public class StateResponse
{
    public string project;
    public AgentDto[] agents;
}
