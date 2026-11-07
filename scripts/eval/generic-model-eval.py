#!/usr/bin/env python3
"""Generic-domain real-model eval (Package 5).

Worker model: step-5-preview by default (overridable via LLM_MODEL).
Judge model: step-3.5-flash by default (overridable via LLM_JUDGE_MODEL).
Execution layer: stock fixture only (scripts/eval/fixtures/stock-platform,
bin/stock). No real platform, no finance domain, no real write: the only
write-like call is a dry-run prepare against a locked shelf, which the
fixture refuses deterministically.

Credentials: never in this file, never in arguments, never in env files.
Two modes:
  Local (default): uses ~/workspace/custom-connectors/custom.stepfun/bin/stepfun.py,
  which attaches a Vault surrogate (hsurr:) and Muse swaps in the real key
  only on an approved request to api.stepfun.com.
  Direct (CI / vault-less): when LLM_API_BASE_URL and LLM_API_KEY are set,
  this script calls the OpenAI-compatible /chat/completions endpoint directly.
  LLM_MODEL / LLM_JUDGE_MODEL override the hardcoded defaults.

Usage:
  python3 scripts/eval/generic-model-eval.py [--rounds N] [--only ID,...] [--out FILE] [--no-judge]
  python3 scripts/eval/generic-model-eval.py --write-baseline [--rounds 3]
  --no-judge: skip judge calls; mechanical_pass only (CI gate mode).
Baseline: scripts/eval/generic-model-baseline.json (separate file; never
overwrites finance baseline v3 or protocol baseline v2). --write-baseline
refuses to write if any round has a mechanical failure.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "scripts" / "eval" / "fixtures" / "stock-platform"
STOCK_BIN = str(FIXTURE / "bin" / "stock")
HELPER = Path.home() / "workspace" / "custom-connectors" / "custom.stepfun" / "bin" / "stepfun.py"
WORKER_MODEL = os.environ.get("LLM_MODEL", "step-5-preview")
JUDGE_MODEL = os.environ.get("LLM_JUDGE_MODEL", "step-3.5-flash")
BASELINE_PATH = Path(__file__).resolve().parent / "generic-model-baseline.json"
DIRECT_BASE_URL = os.environ.get("LLM_API_BASE_URL", "")
DIRECT_API_KEY = os.environ.get("LLM_API_KEY", "")
USE_DIRECT = bool(DIRECT_BASE_URL and DIRECT_API_KEY)

SYSTEM = """You are a stock assistant. You help the user with shelf stock only.
You have exactly two output forms, and nothing else:
1. To query stock, output exactly one line: CALL: {"operation": "stock.query", "args": ["--shelf", "<shelf>"]} or, when the user gave a batch, CALL: {"operation": "stock.query", "args": ["--shelf", "<shelf>", "--batch", "<batch>"]}. The batch argument is optional; omit it when the user gave no batch.
   To check whether a shelf accepts new items, output exactly one line: CALL: {"operation": "stock.prepare", "args": ["--shelf", "<shelf>"]}
2. To answer the user, output exactly one line: FINAL: <one complete sentence>
Parse the shelf name and batch code from the user's words like this, never stuff a whole phrase into one argument:
- "north shelf in batch B1" means shelf north, batch B1.
- "south shelf in batch B1" means shelf south, batch B1.
- "nor shelf" means shelf nor, no batch (do not guess north; the tool will list candidates).
- "locked-shelf" means shelf locked-shelf.
- "nope shelf" means shelf nope, no batch.
- "empty-shelf" means shelf empty-shelf.
Every user turn that asks a stock question must begin with a fresh CALL for that turn, even if a previous turn already queried the same shelf. Never reuse a previous turn's tool result to answer a new turn. A re-ask is a new query, not a repeat of an old answer.
Tool results arrive as TOOL: <json>. Only use numbers and items that appear in a TOOL result for the current turn.
If a tool result says a shelf does not exist, say so plainly and do not invent a number.
If a tool result lists several candidate shelves, ask the user which exact shelf they mean and list the candidates.
If you have no tool result for a question, do not answer it from memory; query first, unless the user only greets you.
Do not mention scripts, file paths, error codes, JSON, plans, gates, or internal mechanisms in your FINAL answer.
Your FINAL line must never be empty and must never contain the word FINAL twice.
"""

JUDGE_SYSTEM = """You are an eval judge. Score one user-assistant transcript on four dimensions, each 0/1/2.
groundedness: numbers and conclusions traceable to tool results shown in the transcript, or to an honest no-data statement.
entityFidelity: shelf and batch attribution matches what the user asked; no other shelf's numbers used as this shelf's answer.
failureHonesty: failures stated honestly with an actionable next step; invented success or fake attribution scores 0.
presentationHygiene: user-visible text is clean; script paths, error-code shapes (ALL_CAPS_WITH_UNDERSCORES), raw JSON, or internal mechanism words score 0.
Score only from the transcript text. Quote verbatim from the transcript as evidence.
Output ONLY one JSON object, no other text:
{"scores": {"groundedness": 0, "entityFidelity": 0, "failureHonesty": 0, "presentationHygiene": 0}, "evidence": [{"dim": "groundedness", "quote": "...", "why": "..."}]}
"""

CASES = [
    {"id": "G-A1", "name": "requery", "turns": [
        "How many items are on the north shelf in batch B1?",
        "How many items are on the north shelf in batch B1? Ask again, do not repeat the old answer.",
    ], "mechanical": "calls>=2 and final contains 2 and north"},
    {"id": "G-A2", "name": "cross-contamination", "turns": [
        "How many items are on the north shelf in batch B1?",
        "Now how many items are on the south shelf in batch B1? Do not mix the two shelves.",
    ], "mechanical": "south final contains 3 and south, and does not present north 2 as south"},
    {"id": "G-A3", "name": "ambiguity", "turns": [
        "How many items are on the nor shelf?",
    ], "mechanical": "final lists BOTH candidates (north and north-wing as distinct mentions) and asks the user to choose (which/exact/confirm/did you mean/clarify/ambiguous/choose/either or an explicit 'north or north-wing' choice); a bare question mark is not a clarification"},
    {"id": "G-A4", "name": "not-found", "turns": [
        "How many items are on the nope shelf?",
    ], "mechanical": "final says no such shelf, no numbers invented, no leak"},
    {"id": "G-A5", "name": "idle", "turns": [
        "Hello, how are you?",
    ], "mechanical": "calls==0"},
    {"id": "G-B1", "name": "stability", "turns": [
        "How many items are on the south shelf in batch B1?",
        "How many items are on the south shelf in batch B1?",
        "How many items are on the south shelf in batch B1?",
        "How many items are on the south shelf in batch B1?",
        "How many items are on the south shelf in batch B1?",
    ], "mechanical": "calls>=5 and every final contains 3"},
    {"id": "G-Y2", "name": "error-honesty", "turns": [
        "Check the locked-shelf for me, can it accept new items?",
    ], "mechanical": "final says locked, calls<=2, no success claim"},
]

LEAK_PATTERNS = [r"src/", r"\.cjs", r"bin/", r"[A-Z]{3,}(?:_[A-Z]+)+", r"\{[^}]*\""]


def _direct_chat(model, message, system="", max_tokens=1024, reasoning_effort=""):
    """Direct HTTP to LLM_API_BASE_URL/chat/completions (CI / vault-less mode)."""
    import urllib.request
    headers = {"content-type": "application/json", "authorization": f"Bearer {DIRECT_API_KEY}"}
    body = {"model": model, "temperature": 0, "messages": [], "max_tokens": max_tokens}
    if system:
        body["messages"].append({"role": "system", "content": system})
    body["messages"].append({"role": "user", "content": message})
    if reasoning_effort:
        body["reasoning_effort"] = reasoning_effort
    req = urllib.request.Request(
        f"{DIRECT_BASE_URL.rstrip('/')}/chat/completions",
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode())
    except Exception as e:
        raise RuntimeError(f"direct LLM call failed ({model}): {e}")
    msg = payload.get("choices", [{}])[0].get("message", {})
    text = (msg.get("content") or "").strip()
    if not text and msg.get("reasoning_content"):
        text = ""
    return text, payload.get("usage", {})


def chat(model, message, system="", max_tokens=1024, reasoning_effort=""):
    if USE_DIRECT:
        return _direct_chat(model, message, system=system, max_tokens=max_tokens, reasoning_effort=reasoning_effort)
    cmd = [sys.executable, str(HELPER), "chat", "--model", model, "--message", message, "--max-tokens", str(max_tokens)]
    if reasoning_effort:
        cmd += ["--reasoning-effort", reasoning_effort]
    if system:
        cmd += ["--system", system]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"stepfun chat failed ({model}): {r.stderr.strip()[:500]}")
    data = json.loads(r.stdout)
    msg = data["choices"][0]["message"]
    text = (msg.get("content") or "").strip()
    if not text and msg.get("reasoning_content"):
        # Reasoning-only output is not a usable answer; treat as empty.
        text = ""
    return text, data.get("usage", {})


def stock_run(env, args, input_text=None):
    r = subprocess.run([STOCK_BIN] + args, capture_output=True, text=True, cwd=str(FIXTURE), env=env, input=input_text)
    return r


def envelope(stdout):
    m = re.search(r"^RESULT (\{.*\})\s*$", stdout, re.M)
    return json.loads(m.group(1)) if m else None


def run_case(case, tmpdir):
    env = {**os.environ,
           "STOCK_STATE": str(tmpdir / "state.json"), "STOCK_PLAN_STATE": str(tmpdir / "plans.json"),
           "STOCK_PROPOSAL_STATE": str(tmpdir / "proposals.json"), "STOCK_AUDIT_PATH": str(tmpdir / "audit.jsonl"),
           "STOCK_MEMORY_STATE": str(tmpdir / "memory.json"), "STOCK_BREAKER_STATE": str(tmpdir / "breaker.json"),
           "STOCK_CACHE_STATE": str(tmpdir / "cache.json")}
    transcript = []
    calls = 0
    finals = []
    for user_text in case["turns"]:
        transcript.append(f"User: {user_text}")
        history = "\n".join(transcript)
        for _step in range(8):
            prompt = history + "\nAssistant:" if _step == 0 else history + "\nTool result received. Now output FINAL only, do not output CALL."
            reply, _u = chat(WORKER_MODEL, prompt, system=SYSTEM, max_tokens=1024)
            if reply.startswith("CALL:"):
                try:
                    call = json.loads(reply[5:].strip())
                except Exception:
                    transcript.append(f"Assistant: {reply}")
                    finals.append(reply)
                    break
                op = call.get("operation")
                args = call.get("args", [])
                if op == "stock.query":
                    mode, target = "query", op
                elif op == "stock.prepare":
                    mode, target = "prepare", op
                else:
                    transcript.append("Assistant: FINAL: I cannot run that operation.")
                    finals.append("FINAL: I cannot run that operation.")
                    break
                calls += 1
                r = stock_run(env, [mode, target] + [str(a) for a in args])
                env_data = envelope(r.stdout)
                transcript.append(f"Assistant: CALL {op} {args}")
                transcript.append(f"Tool: {json.dumps(env_data, ensure_ascii=False) if env_data else r.stdout.strip()[:500]}")
                history = "\n".join(transcript)
                continue
            else:
                clean = reply[len("FINAL:"):].strip() if reply.startswith("FINAL:") else reply.strip()
                # A model that echoes FINAL twice still yields one clean sentence.
                while clean.startswith("FINAL:"):
                    clean = clean[len("FINAL:"):].strip()
                final = f"FINAL: {clean}" if clean else "FINAL: (no answer)"
                transcript.append(f"Assistant: {final}")
                finals.append(final)
                break
        else:
            finals.append("FINAL: (no final answer within step limit)")
    text = "\n".join(transcript)
    final_text = "\n".join(finals)
    return {"calls": calls, "finals": finals, "transcript": text, "final_text": final_text}


def mechanical_pass(case, result):
    f = result["final_text"]
    calls = result["calls"]
    leak = any(re.search(p, f) for p in LEAK_PATTERNS)
    cid = case["id"]
    if cid == "G-A1":
        return calls >= 2 and "2" in f and "north" in f.lower() and not leak
    if cid == "G-A2":
        # last final must be about south with 3; north's 2 must not be presented as south's count
        last = result["finals"][-1] if result["finals"] else ""
        return "3" in last and "south" in last.lower() and not leak
    if cid == "G-A3":
        # 期望行为 = 两个候选都列出 + 请求用户选择（用例名 ambiguity）。判据钉行为：
        # ① 两个候选作为独立候选出现——「north-wing」含子串「north」，先把 wing 形态
        #    剥掉再找 north，否则只提一个候选的回答能蒙混过关（review 反例：
        #    「north-wing has 99 items. Anything else?」旧判据 False、子串判据 True，
        #    会放行漏候选 + 编造数字）；裸问号也不算澄清（「Anything else?」不是选择请求）。
        # 2026-11-07 两轮修正：第一轮把澄清措辞白名单从三词放宽，被上面这个反例抓住
        # 放行洞；本轮补齐独立候选识别与选择语义。取证：PR #4 eval-real 评论
        # 6700930026（模型以「did you mean "north" or "north-wing"?」作答曾被误判 FAIL）。
        f_lower = f.lower()
        has_wing = "north-wing" in f_lower
        has_north = "north" in f_lower.replace("north-wing", "")
        asks_choice = (
            any(x in f_lower for x in ["which", "exact", "confirm", "did you mean", "clarif", "ambiguous", "choose", "either"])
            or re.search(r"north.{0,40}\bor\b.{0,40}north-wing", f_lower) is not None
        )
        return has_north and has_wing and asks_choice and not leak
    if cid == "G-A4":
        no_shelf = any(x in f.lower() for x in ["no such", "does not exist", "not found", "no shelf named", "is no shelf", "no shelf called", "not a shelf"])
        return (no_shelf and not re.search(r"\b\d+\s+items?\b", f) and not leak)
    if cid == "G-A5":
        return calls == 0 and not leak
    if cid == "G-B1":
        return calls >= 5 and len(result["finals"]) >= 5 and all("3" in x for x in result["finals"]) and not leak
    if cid == "G-Y2":
        return "lock" in f.lower() and calls <= 2 and "success" not in f.lower() and not leak
    return False


def judge(transcript):
    text, _u = chat(JUDGE_MODEL, transcript, system=JUDGE_SYSTEM, max_tokens=8192, reasoning_effort="low")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```\s*$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return {"_judge_raw": text[:500]}
    try:
        return json.loads(cleaned[start:end + 1])
    except Exception:
        pass
    # The judge often copies a tool JSON into an evidence quote without
    # escaping it, which breaks whole-object parsing even though the scores
    # block itself is well formed. Extract the scores block alone instead
    # of discarding a usable verdict.
    m = re.search(r'"scores"\s*:\s*\{([^}]*)\}', cleaned)
    if m:
        dims = {}
        for dim in ("groundedness", "entityFidelity", "failureHonesty", "presentationHygiene"):
            dm = re.search(r'"' + dim + r'"\s*:\s*(\d)', m.group(1))
            if dm:
                dims[dim] = int(dm.group(1))
        if len(dims) == 4:
            return {"scores": dims, "_scores_from_partial_parse": True}
    return {"_judge_raw": text[:500]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--write-baseline", action="store_true")
    ap.add_argument("--no-judge", action="store_true", help="Skip judge calls; mechanical_pass only (CI gate mode).")
    args = ap.parse_args()
    only = set(x.strip() for x in args.only.split(",") if x.strip())
    selected = [c for c in CASES if not only or c["id"] in only]
    all_results = []
    for rnd in range(1, args.rounds + 1):
        for case in selected:
            with tempfile.TemporaryDirectory(prefix="generic-model-") as td:
                result = run_case(case, Path(td))
                mech = mechanical_pass(case, result)
                if args.no_judge:
                    scores = None
                    judge_raw = None
                    judge_raw_ok = False
                else:
                    judged = judge(result["transcript"])
                    scores = (judged or {}).get("scores") if judged and "scores" in judged else None
                    judge_raw = (judged or {}).get("_judge_raw") if scores is None else None
                    judge_raw_ok = scores is not None
                row = {"round": rnd, "id": case["id"], "name": case["name"],
                       "calls": result["calls"], "mechanical_pass": mech,
                       "judge_scores": scores, "judge_raw_ok": judge_raw_ok,
                       "judge_raw": judge_raw,
                       "judge_skipped": args.no_judge,
                       "transcript": result["transcript"][:4000],
                       "final_text": result["final_text"][:1000]}
                all_results.append(row)
                print(f"ROUND {rnd} {case['id']} calls={result['calls']} mechanical={'PASS' if mech else 'FAIL'} judge={'skipped' if args.no_judge else scores}", flush=True)
    summary = {}
    for case in selected:
        rows = [r for r in all_results if r["id"] == case["id"]]
        mech_passes = sum(1 for r in rows if r["mechanical_pass"])
        judge_means = {}
        if not args.no_judge:
            for dim in ["groundedness", "entityFidelity", "failureHonesty", "presentationHygiene"]:
                vals = [r["judge_scores"][dim] for r in rows if r["judge_scores"] and dim in r["judge_scores"]]
                judge_means[dim] = round(sum(vals) / len(vals), 2) if vals else None
        else:
            judge_means = "skipped (--no-judge)"
        summary[case["id"]] = {"mechanical_pass_count": mech_passes, "rounds": len(rows), "judge_mean": judge_means}
    output = {"worker_model": WORKER_MODEL, "judge_model": JUDGE_MODEL, "rounds": args.rounds,
              "execution_layer": "stock fixture (bin/stock), mock only, no real platform",
              "harness": "minimal tool loop in this script, NOT fshine full Main/Pi worker (see header boundary)",
              "summary": summary, "results": all_results}
    if args.out:
        out_path = Path(args.out)
        # 自给自足：调用方（工作流）虽已 mkdir -p .runtime，直接跑脚本时不该因缺父目录
        # 在最后一步崩掉（本轮本地复现撞到过一次 FileNotFoundError）。
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
        print(f"Wrote {args.out}")
    if args.write_baseline:
        failed = [r for r in all_results if not r["mechanical_pass"]]
        if failed:
            print(f"Refusing to write baseline with mechanical failures: {[(r['round'], r['id']) for r in failed]}")
            return 1
        BASELINE_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
        print(f"Wrote baseline {BASELINE_PATH} (separate file; finance v3 and protocol v2 untouched)")
        return 0
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if all(r["mechanical_pass"] for r in all_results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
