"""Tests for nzsw.limits against a local HTTP server that throttles. Run: python3 backend/tests/test_limits.py"""
import os, sys, tempfile, threading, json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from nzsw import limits as L

STATE = {"n": 0, "mode": "ok"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        STATE["n"] += 1
        m = STATE["mode"]
        if m == "retry_after_twice" and STATE["n"] <= 2:
            self.send_response(429); self.send_header("Retry-After", "7"); self.end_headers(); self.wfile.write(b"slow down"); return
        if m == "always_429":
            self.send_response(429); self.end_headers(); return
        if m == "s3_slowdown" and STATE["n"] <= 1:
            self.send_response(503); self.end_headers(); self.wfile.write(b"<Code>SlowDown</Code>"); return
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")


def run():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}/"
    slept = []
    tmp = tempfile.mkdtemp()
    mk = lambda: L.Client(ledger=L.Ledger(os.path.join(tmp, f"ledger{len(slept)}{STATE['n']}.json")), sleep=slept.append, log=lambda *a: None)

    # 1. Retry-After honoured, then success; every attempt is counted
    STATE.update(n=0, mode="retry_after_twice"); slept.clear()
    c = mk(); r = c.request("statsnz_ade", "GET", url)
    assert r.status_code == 200 and STATE["n"] == 3, STATE
    assert [s for s in slept if s == 7.0] == [7.0, 7.0], slept
    assert c.ledger.used("statsnz_ade") == 3.0, c.ledger.used("statsnz_ade")
    print("ok  Retry-After honoured (2 x 7 s), 3 attempts counted")

    # 2. circuit breaker: repeated 429s pause the service
    STATE.update(n=0, mode="always_429"); slept.clear()
    c = mk()
    try:
        c.request("linz_wfs", "GET", url); raise AssertionError("expected ServicePaused")
    except L.ServicePaused as e:
        assert STATE["n"] == L.BREAKER_THRESHOLD, STATE
        print(f"ok  breaker opened after {STATE['n']} throttled responses: {e}")
    try:
        c.request("linz_wfs", "GET", url); raise AssertionError("expected paused")
    except L.ServicePaused:
        print("ok  service stays paused; no further requests sent")

    # 3. S3 SlowDown (503) -> exponential backoff, then success
    STATE.update(n=0, mode="s3_slowdown"); slept.clear()
    c = mk(); r = c.request("linz_imagery_s3", "GET", url)
    assert r.status_code == 200 and len(slept) >= 1 and 2.5 <= max(slept) <= 5.0, slept
    print(f"ok  503 SlowDown -> backoff {max(slept):.1f}s then success")

    # 4. budget refusal before sending (Open-Meteo weighted)
    STATE.update(n=0, mode="ok")
    c = mk()
    big = L.openmeteo_weight(7, 4, "2008-01-01", "2026-10-31")
    try:
        c.request("openmeteo", "GET", url, cost=big); raise AssertionError("expected refusal: one request > hourly budget")
    except L.QuotaExceeded as e:
        assert STATE["n"] == 0
        print(f"ok  refused before sending ({big:.0f} weighted calls): {e}")

    # 4b. hourly budget nearly used -> wait for the next hour, then send; day budget used -> refuse
    STATE.update(n=0, mode="ok"); slept.clear()
    c = mk(); c.ledger.add("openmeteo", 2900)
    c.request("openmeteo", "GET", url, cost=361)
    assert STATE["n"] == 1 and any(s > 60 for s in slept), slept
    print(f"ok  hourly budget short -> waited {max(slept) / 60:.0f} min, then sent")
    c2 = mk(); c2.ledger.add("openmeteo", 5900)
    try:
        c2.request("openmeteo", "GET", url, cost=361); raise AssertionError("expected day refusal")
    except L.QuotaExceeded as e:
        print(f"ok  daily budget short -> refused: {e}")

    # 5. pacing: one request at a time with the service's minimum interval
    STATE.update(n=0, mode="ok"); slept.clear()
    c = mk(); c.request("statsnz_ade", "GET", url); c.request("statsnz_ade", "GET", url)
    assert any(1.5 < s <= 2.0 for s in slept), slept
    print(f"ok  paced: waited {max(slept):.2f}s between ADE requests (min interval 2 s)")

    # 6. preflight: national / oversized runs rejected; a pilot-sized run fits
    p = L.preflight(n_tas=67, n_sa2=2352, n_suburbs=2000, n_climate_cells=300, climate_start="2013-01-01",
                    climate_end="2026-10-31", est_features=3_000_000, ledger=L.Ledger(os.path.join(tmp, "pf1.json")))
    assert not p["may_run"] and any("national" in x for x in p["problems"]), p["problems"]
    print(f"ok  national run rejected ({len(p['problems'])} problems)")
    p = L.preflight(n_tas=1, n_sa2=29, n_suburbs=7, n_climate_cells=3, climate_start="2013-01-01", climate_end="2026-10-31",
                    est_features=60_000, ledger=L.Ledger(os.path.join(tmp, "pf2.json")))
    assert p["may_run"], p["problems"]
    print("ok  Taupō-sized run fits: " + ", ".join(f"{k} {v['estimated_calls']:,}" for k, v in p["services"].items()))
    srv.shutdown()
    print("all limits tests passed")


if __name__ == "__main__":
    run()
