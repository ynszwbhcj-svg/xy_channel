#!/bin/bash
# Test Case 2: Subagent News + Steer (时政新闻)
#
# 1. Send first message requesting 2 subagents (体育+娱乐新闻)
# 2. After 15s delay, send a steer message (时政新闻) via the steer API
# 3. Wait for test to complete and analyze results

MOCK_URL="${MOCK_URL:-http://localhost:8768}"
LOG_FILE="${LOG_FILE:-/tmp/openclaw/xiaoyi-channel-20260709.log}"
SESSION_ID="steer-test-$(date +%s)-$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)"

echo "===== Test Case 2: Subagent + Steer ====="
echo "SessionId: $SESSION_ID"
echo "Start time: $(date)"
echo ""

# Check channel is connected
STATUS=$(curl -s "$MOCK_URL/api/status" 2>/dev/null)
CONNECTED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('channelConnected', False))" 2>/dev/null)
if [ "$CONNECTED" != "True" ]; then
  echo "ERROR: Channel not connected. Status: $STATUS"
  exit 1
fi

# Start test case 1 (subagent-news) in background
echo "[1/3] Starting subagent-news test (background)..."
RESPONSE_FILE=$(mktemp)
curl -s -X POST "$MOCK_URL/api/test/subagent-news" \
  -d "{\"text\": \"帮我启动两个subagent，第一个用webfetch去搜索今日新浪体育新闻，第二个用webfetch去搜索新浪娱乐新闻，最终整理成一个txt文件\", \"sessionId\": \"$SESSION_ID\"}" \
  > "$RESPONSE_FILE" 2>/dev/null &
TEST_PID=$!

# Wait for model to start streaming (~10s for file download + model init)
echo "[2/3] Waiting 15s before sending steer..."
sleep 15

# Check if channel is still connected
STILL_CONNECTED=$(curl -s "$MOCK_URL/api/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('channelConnected', False))" 2>/dev/null)
if [ "$STILL_CONNECTED" != "True" ]; then
  echo "ERROR: Channel disconnected before steer"
else
  # Send steer message
  echo "[2/3] Sending steer message (时政新闻)..."
  STEER_RESULT=$(curl -s -X POST "$MOCK_URL/api/steer/$SESSION_ID" \
    -d '{"text": "用webfetch去搜索今日新浪时政新闻", "delayMs": 1000}' 2>/dev/null)
  echo "Steer API response: $STEER_RESULT"
fi

# Wait for test to complete
echo "[3/3] Waiting for test completion (up to 5 min)..."
wait $TEST_PID 2>/dev/null || true

# Analyze results
echo ""
echo "===== Results ====="
if [ -f "$RESPONSE_FILE" ]; then
  python3 -c "
import sys, json
try:
    data = json.load(open('$RESPONSE_FILE'))
except:
    print('ERROR: Could not parse response file')
    sys.exit(1)

print(f'Status: {data.get(\"status\")}')
print(f'Duration: {data.get(\"duration\")}ms')
print(f'Error: {data.get(\"error\", \"none\")}')
print(f'Response chunks: {len(data.get(\"responses\", []))}')
print(f'Final text length: {len(data.get(\"finalText\", \"\"))}')
print()

# Analyze each chunk
task_ids_seen = set()
has_status_working = False
has_status_completed = False
has_final_true = False
has_heartbeat = False  # '子任务正在处理中' status

for i, r in enumerate(data.get('responses', [])):
    try:
        d = json.loads(r['msgDetail'])
        results = d.get('result', {})
        status = results.get('status', {}).get('state', '')
        final = results.get('final', '')
        parts = results.get('artifact', {}).get('parts', [])
        texts = [p.get('text','')[:80] for p in parts if p.get('kind')=='text']
        task_id = r.get('taskId', '')
        task_ids_seen.add(task_id)

        if status == 'working':
            has_status_working = True
        if status == 'completed':
            has_status_completed = True
        if final is True:
            has_final_true = True

        # Check for heartbeat text
        for t in texts:
            if '子任务' in t:
                has_heartbeat = True

        print(f'  Chunk {i}: taskId={task_id[:30]}... state={status}, final={final}, text={\" | \".join(texts)}')
    except Exception as e:
        print(f'  Chunk {i}: parse error: {e}')

print()
print('--- Analysis ---')
print(f'Task IDs seen: {len(task_ids_seen)}')
print(f'Has working status: {has_status_working}')
print(f'Has completed status: {has_status_completed}')
print(f'Has final=true: {has_final_true}')
print(f'Has subagent heartbeat text: {has_heartbeat}')

# Check final text for expected topics
final_text = data.get('finalText', '')
sports = '体育' in final_text
entertainment = '娱乐' in final_text
politics = '时政' in final_text
print(f'Topics found - Sports: {sports}, Entertainment: {entertainment}, Politics: {politics}')
print(f'All topics found: {sports and entertainment and politics}')

# Validate
issues = []
if not has_final_true:
    issues.append('No final=true received')
if not has_status_completed:
    issues.append('No completed status received')
if data.get('status') != 'pass':
    issues.append(f'Test status is {data.get(\"status\")}')
if issues:
    print(f'ISSUES: {\" | \".join(issues)}')
else:
    print('Basic flow: OK')

print()
print(f'Full response saved to: $RESPONSE_FILE')
"
else
  echo "ERROR: Response file not found"
fi

echo ""
echo "===== Channel Log Analysis ====="
# Check log for subagent-related messages
grep -i "SUBAGENT-WAIT\|XY-SUBAGENT\|STEER-QUEUE\|subagent_spawned\|subagent_ended\|deliverSubagent\|子任务" "$LOG_FILE" 2>/dev/null | tail -30

echo ""
echo "===== Test Complete ====="
