using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

// 空のGameObjectに付けて、シーン上の全キャラを登録する。
public class AIApiClient : MonoBehaviour
{
    [SerializeField] private string baseUrl = "http://localhost:8000";
    [SerializeField] private float pollInterval = 1.0f;
    [SerializeField] private AICharacterController[] characters;

    private readonly Dictionary<string, AICharacterController> byId = new Dictionary<string, AICharacterController>();

    void Start()
    {
        foreach (var c in characters)
        {
            if (c != null) byId[c.AgentId] = c;
        }
        StartCoroutine(PollLoop());
    }

    // 画面のボタンなどから呼ぶ
    public void StartProject(string prompt)
    {
        StartCoroutine(PostStart(prompt));
    }

    private IEnumerator PostStart(string prompt)
    {
        string json = JsonUtility.ToJson(new StartBody { prompt = prompt });
        using (var req = new UnityWebRequest(baseUrl + "/start_project", "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(json));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            yield return req.SendWebRequest();
            if (req.result != UnityWebRequest.Result.Success)
                Debug.LogWarning("start_project failed: " + req.error);
        }
    }

    private IEnumerator PollLoop()
    {
        var wait = new WaitForSeconds(pollInterval);
        while (true)
        {
            using (var req = UnityWebRequest.Get(baseUrl + "/state"))
            {
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                    Apply(JsonUtility.FromJson<StateResponse>(req.downloadHandler.text));
                else
                    Debug.LogWarning("state poll failed: " + req.error);
            }
            yield return wait;
        }
    }

    private void Apply(StateResponse res)
    {
        if (res == null || res.agents == null) return;
        foreach (var a in res.agents)
        {
            if (byId.TryGetValue(a.id, out var c) && System.Enum.TryParse(a.state, out AgentState s))
                c.UpdateAIState(s);
        }
    }

    [System.Serializable]
    private class StartBody { public string prompt; }
}
