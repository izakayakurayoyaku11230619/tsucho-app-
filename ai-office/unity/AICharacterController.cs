using UnityEngine;

public class AICharacterController : MonoBehaviour
{
    [SerializeField] private string agentId = "CEO"; // サーバーのagent idと一致させる
    [SerializeField] private Animator characterAnimator;
    [SerializeField] private Transform deskPosition;
    [SerializeField] private Transform meetingRoom;
    [SerializeField] private float moveSpeed = 2.0f;
    [SerializeField] private float arriveDistance = 0.05f;

    private static readonly int IsWalking = Animator.StringToHash("IsWalking");
    private static readonly int IsTyping = Animator.StringToHash("IsTyping");
    private static readonly int IsTalking = Animator.StringToHash("IsTalking");

    private AgentState currentState = AgentState.Idle;
    private bool arrived = true;

    public string AgentId => agentId;

    void Update()
    {
        Transform target = TargetFor(currentState);
        if (target == null) return;

        Vector3 to = target.position - transform.position;
        to.y = 0f;
        bool wasArrived = arrived;
        arrived = to.magnitude <= arriveDistance;

        if (!arrived)
        {
            transform.rotation = Quaternion.LookRotation(to.normalized);
            transform.position = Vector3.MoveTowards(transform.position, target.position, moveSpeed * Time.deltaTime);
        }

        if (arrived != wasArrived) RefreshAnimation();
    }

    // AIApiClientがサーバーから受け取った状態で呼ぶ
    public void UpdateAIState(AgentState state)
    {
        if (state == currentState) return;
        currentState = state;
        arrived = false;
        RefreshAnimation();
    }

    private Transform TargetFor(AgentState state)
    {
        return state == AgentState.Meeting ? meetingRoom : deskPosition;
    }

    // 移動中は歩き、到着したら状態に応じたアニメにする
    private void RefreshAnimation()
    {
        if (characterAnimator == null) return;
        characterAnimator.SetBool(IsWalking, !arrived);
        characterAnimator.SetBool(IsTyping, arrived && currentState == AgentState.Working);
        characterAnimator.SetBool(IsTalking, arrived && currentState == AgentState.Meeting);
    }
}
