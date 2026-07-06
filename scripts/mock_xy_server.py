#!/usr/bin/env python3
"""
Mock XY WebSocket Server for testing steer functionality.

This server simulates the XY device/app server:
- Accepts WebSocket connections from xy_channel plugin
- Sends simulated A2A messages (user queries)
- Receives and displays responses (status-update, artifact-update, reasoningText)
- Supports steer testing: sends second query while first is still processing

Protocol:
- Inbound (from device): Wrapped format {msgType, agentId, sessionId, taskId, msgDetail}
- Outbound (to device): OutboundWebSocketMessage with A2A JSON-RPC events

Usage:
  python scripts/mock_xy_server.py [--port 8768] [--steer-delay 3]
"""

import asyncio
import json
import os
import sys
import uuid
import argparse
import time
import signal
import threading
from datetime import datetime

try:
    import websockets
except ImportError:
    print("Please install websockets: pip install websockets")
    sys.exit(1)

# ============================================================
# Configuration
# ============================================================
parser = argparse.ArgumentParser(description="Mock XY WebSocket Server")
parser.add_argument("--port", type=int, default=8768, help="WebSocket server port")
parser.add_argument("--steer-delay", type=float, default=3.0,
                    help="Seconds to wait after first response before sending steer query")
parser.add_argument("--test", choices=["steer", "normal", "manual", "multi-steer", "cancel"], default="steer",
                    help="Test scenario: steer (send second while first processes), normal (single query), manual (interactive)")
args = parser.parse_args()

WS_PORT = args.port
STEER_DELAY = args.steer_delay

# Test queries
FIRST_QUERY = "帮我用web_fetch搜索新浪新闻今日财经"
SECOND_QUERY = "另外也加上今日体育新闻"
THIRD_QUERY = "再查一下今天的科技新闻"
CANCEL_QUERY = "先用webfetch查询新浪的今日财经新闻，然后再把内容整理一下生成一个ppt"
CANCEL_STEER = "终止所有操作"

# Session IDs (must be consistent)
SESSION_ID = f"steer-test-{uuid.uuid4().hex[:8]}"

# ============================================================
# State
# ============================================================
connected_clients: dict = {}  # sessionId -> websocket
first_response_received = asyncio.Event()
steer_sent = False
response_log = []
LOG_FILE = "/tmp/mock_xy_server.log"

def log(msg: str):
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)
    response_log.append(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass

# ============================================================
# WebSocket Handler
# ============================================================
async def handle_client(websocket):
    """Handle a single WebSocket connection from xy_channel."""
    client_id = str(uuid.uuid4())[:8]
    log(f"[CONNECT] Client={client_id} connected from {websocket.remote_address}")

    # Register this websocket as the session connection
    connected_clients[client_id] = websocket

    try:
        # Wait for init message from xy_channel
        init_msg_raw = await asyncio.wait_for(websocket.recv(), timeout=10.0)
        init_msg = json.loads(init_msg_raw)
        log(f"[INIT] Received init from channel: msgType={init_msg.get('msgType')}, agentId={init_msg.get('agentId')}")

        if args.test == "manual":
            # Interactive mode: read input from stdin and send as user messages
            await manual_mode(websocket, client_id)
        elif args.test == "steer":
            await steer_test_scenario(websocket, client_id)
        elif args.test == "multi-steer":
            await multi_steer_test_scenario(websocket, client_id)
        elif args.test == "cancel":
            await cancel_test_scenario(websocket, client_id)
        else:
            await normal_test_scenario(websocket, client_id)

    except asyncio.TimeoutError:
        log(f"[TIMEOUT] Client={client_id}: No init message received within 10s")
    except websockets.exceptions.ConnectionClosed as e:
        log(f"[DISCONNECT] Client={client_id}: Connection closed: {e}")
    except Exception as e:
        log(f"[ERROR] Client={client_id}: {type(e).__name__}: {e}")
    finally:
        connected_clients.pop(client_id, None)
        log(f"[CLEANUP] Client={client_id} removed")


async def send_a2a_message(websocket, session_id: str, task_id: str, text: str, msg_id: str = None):
    """Send a simulated A2A user message to the xy_channel (direct JSON-RPC format)."""
    if msg_id is None:
        msg_id = f"msg-{uuid.uuid4().hex[:8]}"

    # Use direct A2A JSON-RPC format (not wrapped) — the xy_channel
    # websocket.ts handleMessage() tries this format first.
    a2a_msg = {
        "jsonrpc": "2.0",
        "method": "tasks/send",
        "id": msg_id,
        "params": {
            "sessionId": session_id,
            "id": task_id,
            "agentLoginSessionId": "",
            "message": {
                "role": "user",
                "parts": [{"kind": "text", "text": text}]
            }
        }
    }

    payload = json.dumps(a2a_msg, ensure_ascii=False)
    log(f"[SEND] >>> {text[:80]}... (sessionId={session_id}, taskId={task_id}, msgId={msg_id})")
    await websocket.send(payload)


async def receive_responses(websocket, stop_event: asyncio.Event):
    """Receive and log all responses from xy_channel. Returns collected response info."""
    collected = {"texts": [], "statuses": [], "reasonings": [], "total": 0}

    while not stop_event.is_set():
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=0.5)
            msg = json.loads(raw)
            collected["total"] += 1

            # Parse the response
            msg_detail_raw = msg.get("msgDetail", "{}")
            if isinstance(msg_detail_raw, str):
                try:
                    detail = json.loads(msg_detail_raw)
                except json.JSONDecodeError:
                    detail = {}
            else:
                detail = msg_detail_raw

            result = detail.get("result", detail)

            # artifact-update (streaming text)
            if result.get("kind") == "artifact-update":
                parts = result.get("artifact", {}).get("parts", [])
                for part in parts:
                    if part.get("kind") == "text":
                        text = part.get("text", "")
                        if text:
                            collected["texts"].append(text)
                            log(f"[RECV-TEXT] <<< {text[:200]}{'...' if len(text) > 200 else ''}")

            # status-update
            elif result.get("kind") == "status-update":
                status = result.get("status", result.get("state", "unknown"))
                status_text = result.get("status", {}).get("message", result.get("text", ""))
                if isinstance(status, dict):
                    status = status.get("state", "unknown")
                collected["statuses"].append({"state": status, "text": str(status_text)[:100]})
                log(f"[RECV-STATUS] state={status} text={str(status_text)[:100]}")

            # reasoningText
            elif result.get("kind") == "reasoningText":
                text = result.get("text", "")
                if text:
                    collected["reasonings"].append(text)
                    log(f"[RECV-REASONING] <<< {text[:200]}{'...' if len(text) > 200 else ''}")

            # final
            if detail.get("final"):
                log(f"[RECV-FINAL] Final response marker received")

            # Check if first response has started coming in
            if collected["total"] == 1 or collected["texts"] or collected["reasonings"]:
                first_response_received.set()

        except asyncio.TimeoutError:
            continue
        except websockets.exceptions.ConnectionClosed:
            log("[RECV] Connection closed")
            break
        except Exception as e:
            log(f"[RECV-ERROR] {type(e).__name__}: {e}")

    return collected


# ============================================================
# Test Scenarios
# ============================================================
async def steer_test_scenario(websocket, client_id):
    """Steer test: send second query while first is still processing."""
    global steer_sent
    log(f"\n{'='*60}")
    log(f"[TEST:STEER] Starting steer test scenario")
    log(f"[TEST:STEER] SessionId={SESSION_ID}")
    log(f"[TEST:STEER] Query1: {FIRST_QUERY}")
    log(f"[TEST:STEER] Query2: {SECOND_QUERY}")
    log(f"[TEST:STEER] Steer delay: {STEER_DELAY}s")
    log(f"{'='*60}\n")

    stop_recv = asyncio.Event()
    recv_task = asyncio.create_task(receive_responses(websocket, stop_recv))

    # Send first query
    task_id_1 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_1, FIRST_QUERY)

    # Wait for first response to arrive (agent starts thinking/processing)
    log(f"[TEST:STEER] Waiting for first response (agent processing)...")
    try:
        await asyncio.wait_for(first_response_received.wait(), timeout=60.0)
        log(f"[TEST:STEER] First response detected — waiting {STEER_DELAY}s before sending steer query...")
    except asyncio.TimeoutError:
        log(f"[TEST:STEER] WARNING: No response received within 60s, sending steer query anyway...")

    # Wait the configured delay, then send steer query
    await asyncio.sleep(STEER_DELAY)

    task_id_2 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_2, SECOND_QUERY)
    steer_sent = True

    # Wait for all responses
    log(f"[TEST:STEER] Waiting for all responses to complete (max 300s)...")
    await asyncio.sleep(300)  # Max wait for agent to finish

    stop_recv.set()
    recv_task.cancel()
    try:
        collected = await recv_task
    except asyncio.CancelledError:
        collected = {"texts": [], "statuses": [], "reasonings": [], "total": 0}

    # Summary
    log(f"\n{'='*60}")
    log(f"[TEST:STEER] Scenario Complete")
    log(f"[TEST:STEER] Total messages received: {collected['total']}")
    log(f"[TEST:STEER] Text chunks: {len(collected['texts'])}")
    log(f"[TEST:STEER] Status updates: {len(collected['statuses'])}")
    log(f"[TEST:STEER] Reasoning chunks: {len(collected['reasonings'])}")
    log(f"[TEST:STEER] Combined text length: {sum(len(t) for t in collected['texts'])}")
    log(f"\n[RESULT] All text content:")
    full_text = "".join(collected["texts"])
    log(full_text[:5000])
    if len(full_text) > 5000:
        log(f"... (truncated, total {len(full_text)} chars)")
    log(f"{'='*60}\n")


async def multi_steer_test_scenario(websocket, client_id):
    """Multi-steer test: send two steer queries while first is still processing."""
    log(f"\n{'='*60}")
    log(f"[TEST:MULTI-STEER] Starting multi-steer test scenario")
    log(f"[TEST:MULTI-STEER] SessionId={SESSION_ID}")
    log(f"[TEST:MULTI-STEER] Query1: {FIRST_QUERY}")
    log(f"[TEST:MULTI-STEER] Query2: {SECOND_QUERY}")
    log(f"[TEST:MULTI-STEER] Query3: {THIRD_QUERY}")
    log(f"[TEST:MULTI-STEER] Steer delays: {STEER_DELAY}s, {STEER_DELAY}s")
    log(f"{'='*60}\n")

    stop_recv = asyncio.Event()
    recv_task = asyncio.create_task(receive_responses(websocket, stop_recv))

    # Send first query
    task_id_1 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_1, FIRST_QUERY)

    # Wait for first response
    log(f"[TEST:MULTI-STEER] Waiting for first response...")
    try:
        await asyncio.wait_for(first_response_received.wait(), timeout=60.0)
        log(f"[TEST:MULTI-STEER] First response detected — waiting {STEER_DELAY}s before steer #1...")
    except asyncio.TimeoutError:
        log(f"[TEST:MULTI-STEER] WARNING: No response within 60s, sending steer anyway...")

    await asyncio.sleep(STEER_DELAY)

    # Send second query (steer #1)
    first_response_received.clear()  # Reset for second steer
    task_id_2 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_2, SECOND_QUERY)
    log(f"[TEST:MULTI-STEER] Steer #1 sent — waiting {STEER_DELAY}s before steer #2...")

    await asyncio.sleep(STEER_DELAY)

    # Send third query (steer #2)
    task_id_3 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_3, THIRD_QUERY)
    log(f"[TEST:MULTI-STEER] Steer #2 sent — waiting for all responses to complete...")

    # Wait for all responses
    await asyncio.sleep(300)

    stop_recv.set()
    recv_task.cancel()
    try:
        collected = await recv_task
    except asyncio.CancelledError:
        collected = {"texts": [], "statuses": [], "reasonings": [], "total": 0}

    # Summary
    full_text = "".join(collected["texts"])
    has_finance = "财经" in full_text
    has_sports = "体育" in full_text
    has_tech = "科技" in full_text
    log(f"\n{'='*60}")
    log(f"[TEST:MULTI-STEER] Scenario Complete")
    log(f"[TEST:MULTI-STEER] Total messages: {collected['total']}")
    log(f"[TEST:MULTI-STEER] Text chunks: {len(collected['texts'])}")
    log(f"[TEST:MULTI-STEER] Topics found: 财经={has_finance} 体育={has_sports} 科技={has_tech}")
    log(f"\n[RESULT] All text content:")
    log(full_text[:5000])
    log(f"{'='*60}\n")


async def cancel_test_scenario(websocket, client_id):
    """Cancel test: send a long task then cancel it mid-execution via steer."""
    log(f"\n{'='*60}")
    log(f"[TEST:CANCEL] Starting cancel test scenario")
    log(f"[TEST:CANCEL] SessionId={SESSION_ID}")
    log(f"[TEST:CANCEL] Query: {CANCEL_QUERY}")
    log(f"[TEST:CANCEL] Steer: {CANCEL_STEER}")
    log(f"[TEST:CANCEL] Steer delay: {STEER_DELAY}s after first response")
    log(f"{'='*60}\n")

    stop_recv = asyncio.Event()
    recv_task = asyncio.create_task(receive_responses(websocket, stop_recv))

    # Send first query (long task: web_fetch + PPT generation)
    task_id_1 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_1, CANCEL_QUERY)

    # Wait for first response (agent starts thinking/processing)
    log(f"[TEST:CANCEL] Waiting for first response (agent thinking)...")
    try:
        await asyncio.wait_for(first_response_received.wait(), timeout=60.0)
        log(f"[TEST:CANCEL] First response detected — waiting {STEER_DELAY}s before sending cancel steer...")
    except asyncio.TimeoutError:
        log(f"[TEST:CANCEL] WARNING: No response within 60s, sending cancel anyway...")

    await asyncio.sleep(STEER_DELAY)

    # Send cancel steer
    task_id_2 = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id_2, CANCEL_STEER)
    log(f"[TEST:CANCEL] Cancel steer sent — waiting for agent to complete (max 120s)...")

    # Wait for responses
    await asyncio.sleep(120)

    stop_recv.set()
    recv_task.cancel()
    try:
        collected = await recv_task
    except asyncio.CancelledError:
        collected = {"texts": [], "statuses": [], "reasonings": [], "total": 0}

    # Analysis
    full_text = "".join(collected["texts"])
    has_ppt = any(kw in full_text.lower() for kw in ["ppt", "pptx", "powerpoint", "幻灯片", "演示文稿", "create_ppt", "generate_ppt"])
    has_finance = "财经" in full_text
    was_cancelled = any(kw in full_text for kw in ["终止", "取消", "停止", "cancel", "abort", "已停止", "已取消"])
    completed_normally = any(s.get("state") == "completed" for s in collected["statuses"])

    log(f"\n{'='*60}")
    log(f"[TEST:CANCEL] Scenario Complete")
    log(f"[TEST:CANCEL] Total messages: {collected['total']}")
    log(f"[TEST:CANCEL] Text chunks: {len(collected['texts'])}")
    log(f"[TEST:CANCEL] Status updates: {len(collected['statuses'])}")
    log(f"[TEST:CANCEL] Final status completed: {completed_normally}")
    log(f"[TEST:CANCEL] Analysis:")
    log(f"  - 财经 content present: {has_finance}")
    log(f"  - PPT generated: {has_ppt}")
    log(f"  - Cancel acknowledged: {was_cancelled}")
    log(f"  - Expected: 财经={has_finance}, PPT=False, Cancelled=True")
    log(f"\n[RESULT] Full text:")
    log(full_text[:3000])
    log(f"{'='*60}\n")


async def normal_test_scenario(websocket, client_id):
    """Normal test: send a single query."""
    global steer_sent
    log(f"\n{'='*60}")
    log(f"[TEST:NORMAL] Starting normal test scenario")
    log(f"[TEST:NORMAL] SessionId={SESSION_ID}")
    log(f"[TEST:NORMAL] Query: {FIRST_QUERY}")
    log(f"{'='*60}\n")

    stop_recv = asyncio.Event()
    recv_task = asyncio.create_task(receive_responses(websocket, stop_recv))

    task_id = f"task-{uuid.uuid4().hex[:8]}"
    await send_a2a_message(websocket, SESSION_ID, task_id, FIRST_QUERY)

    # Wait for all responses
    await asyncio.sleep(300)

    stop_recv.set()
    recv_task.cancel()
    try:
        collected = await recv_task
    except asyncio.CancelledError:
        collected = {"texts": [], "statuses": [], "total": 0}

    log(f"[TEST:NORMAL] Total messages: {collected['total']}")
    log(f"[TEST:NORMAL] Full text: {''.join(collected['texts'])[:3000]}")


async def manual_mode(websocket, client_id):
    """Manual mode: send queries from stdin."""
    global steer_sent
    log(f"[MANUAL] Entering manual mode. Type queries (Ctrl+D to quit):")

    stop_recv = asyncio.Event()
    recv_task = asyncio.create_task(receive_responses(websocket, stop_recv))

    def read_stdin():
        for line in sys.stdin:
            line = line.strip()
            if line:
                task_id = f"task-manual-{uuid.uuid4().hex[:8]}"
                asyncio.run_coroutine_threadsafe(
                    send_a2a_message(websocket, SESSION_ID, task_id, line),
                    asyncio.get_event_loop()
                )

    stdin_thread = threading.Thread(target=read_stdin, daemon=True)
    stdin_thread.start()

    # Keep running until Ctrl+C
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        pass

    stop_recv.set()
    recv_task.cancel()


# ============================================================
# Main
# ============================================================
async def main():
    # Clear log
    open(LOG_FILE, "w").close()

    log(f"Mock XY Server starting on port {WS_PORT}")
    log(f"Test scenario: {args.test}")
    log(f"Log file: {LOG_FILE}")

    server = await websockets.serve(
        handle_client,
        "0.0.0.0",
        WS_PORT,
    )

    log(f"Server listening on ws://0.0.0.0:{WS_PORT}")
    log("Ready for xy_channel connection...")

    try:
        await server.wait_closed()
    except KeyboardInterrupt:
        log("Shutting down...")


if __name__ == "__main__":
    asyncio.run(main())
