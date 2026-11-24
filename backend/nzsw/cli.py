"""nzsw worker CLI (docs/SPEC.md section 17).
  python -m nzsw.cli worker            claim and run queued jobs until none are runnable
  python -m nzsw.cli run <region> [--steps climate,census,publish]    run steps for one region directly
  python -m nzsw.cli enqueue <region> [--steps ...]                   queue a job (for cron: climate top-up)
One region per job; every external call goes through limits.Client; budgets live in api_usage."""
import time
import argparse, datetime as dt, json, sys, traceback
from . import limits as L
from .db import connect, DbLedger, sync_rates
from .steps import STEPS
from . import steps as _steps
from . import prepare
STEPS = {**STEPS, **prepare.STEPS}
PREPARE_STEPS = ["linz", "imagery_index", "imagery", "census", "publish_new", "climate"]

DEFAULT_STEPS = ["climate", "census", "publish"]


class Reporter:
    """Log function for a step that also reports to the app while the step runs: the latest lines, an optional progress
    fraction and a heartbeat, written to job_runs at most every few seconds."""
    def __init__(self, con, run_id, log, every=4.0):
        self.con, self.run_id, self.log, self.every, self.lines, self.frac, self.t = con, run_id, log, every, [], None, 0.0
    def __call__(self, msg):
        self.log(msg)
        self.lines = (self.lines + [f"{dt.datetime.now(dt.timezone.utc):%H:%M:%S} {msg}"])[-12:]
        self.flush()
    def progress(self, frac, msg=None):
        self.frac = None if frac is None else max(0.0, min(1.0, float(frac)))
        self(msg) if msg else self.flush()
    def flush(self, force=False):
        if not self.run_id or (not force and time.monotonic() - self.t < self.every):
            return
        self.t = time.monotonic()
        try:
            self.con.execute("update job_runs set detail=%s, progress=%s, updated_at=now() where id=%s", ("\n".join(self.lines), self.frac, self.run_id))
        except Exception:  # noqa: BLE001  (feedback must never break a run)
            pass


def run_steps(con, region, steps, job_id=None, log=print):
    sync_rates(con)
    # keys: the job creator's own keys (Vault) where set, else the project keys; budgets are counted per key owner
    _steps.USER_KEYS.clear()
    owners = {}
    SVC = {"linz": "linz_wfs", "statsnz_ade": "statsnz_ade", "statsnz_datafinder": "statsnz_datafinder", "openmeteo": "openmeteo"}
    if job_id:
        for name, service in SVC.items():
            r = con.execute("select key, owner from job_api_key(%s, %s)", (job_id, name)).fetchone()
            if r and r[0]:
                _steps.USER_KEYS[name] = r[0]; owners[service] = str(r[1])
    if owners:
        log(f"using the job creator's own keys for: {', '.join(sorted(owners))}")
    client = L.Client(ledger=DbLedger(con, owners), log=log)
    if con.execute("select count(*) from regions where id=%s", (region,)).fetchone()[0] != 1:
        raise ValueError(f"unknown region {region!r}")   # one region per run; no national/multi-region path exists
    results = {}
    done_before = set()
    if job_id:   # resuming a parked or requeued job: skip steps it already finished
        done_before = {r[0] for r in con.execute("select step from job_runs where job_id=%s and status='done'", (job_id,)).fetchall()}
    for s in steps:
        if s in done_before:
            log(f"[{region}] {s}: already done, skipped"); results[s] = dict(status="done", message="already done", seconds=0); continue
        if s not in STEPS:
            raise ValueError(f"unknown step {s!r} (available: {', '.join(STEPS)})")
        t0 = dt.datetime.now(dt.timezone.utc)
        run_id = con.execute("insert into job_runs (job_id, step, status) values (%s,%s,'running') returning id", (job_id, s)).fetchone()[0] if job_id else None
        rep = Reporter(con, run_id, log); prepare.NOTE = rep
        try:
            msg = STEPS[s](con, client, region, rep)
            status = "done"
        except (L.QuotaExceeded, L.ServicePaused) as e:
            msg, status = str(e), "paused_quota"
        except prepare.Continue as e:
            msg, status = str(e), "queued"
        except L.RunTooLarge as e:
            msg, status = str(e), "failed"
        except Exception as e:  # noqa: BLE001
            msg, status = f"{type(e).__name__}: {e}", "failed"
            log(traceback.format_exc(limit=3))
        prepare.NOTE = None
        if run_id:
            try:
                con.execute("update job_runs set status=%s, finished_at=now(), log=%s, detail=%s, progress=%s, updated_at=now() where id=%s",
                            (status, msg[:4000], "\n".join(rep.lines), 1.0 if status == "done" else rep.frac, run_id))
            except Exception:  # noqa: BLE001  (progress columns not there yet: record the result anyway)
                con.execute("update job_runs set status=%s, finished_at=now(), log=%s where id=%s", (status, msg[:4000], run_id))
        log(f"[{region}] {s}: {status}: {msg}")
        results[s] = dict(status=status, message=msg, seconds=round((dt.datetime.now(dt.timezone.utc) - t0).total_seconds(), 1))
        if status != "done":
            return status, results   # 'queued' = out of run time: the next run continues from here
    return "done", results


def worker(con, log=print, max_jobs=20):
    n = 0
    while n < max_jobs:
        row = con.execute("select id, type, region_id, params from claim_job()").fetchone()
        if not row or row[0] is None:
            log("no runnable jobs"); break
        jid, jtype, region, params = row
        steps = (params or {}).get("steps") or DEFAULT_STEPS
        log(f"job {jid} ({jtype}) region={region} steps={steps}")
        status, res = run_steps(con, region, steps, job_id=jid, log=log)
        when = None
        if status == "paused_quota":
            when = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=6)).isoformat()
        con.execute("update jobs set status=%s, not_before=%s, reason=%s, counts=%s, finished_at=case when %s in ('done','failed') then now() end where id=%s",
                    (status, when, json.dumps({k: v["status"] for k, v in res.items()}), json.dumps(res), status, jid))
        if status == "queued":
            log("run time used up; remaining work continues on the next scheduled run"); break
        n += 1
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(prog="nzsw")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("worker")
    for c in ("run", "enqueue"):
        p = sub.add_parser(c); p.add_argument("region"); p.add_argument("--steps", default=",".join(DEFAULT_STEPS))
    e = sub.add_parser("enqueue-published"); e.add_argument("--steps", default="climate,publish")
    a = ap.parse_args(argv)
    con = connect()
    if a.cmd == "worker":
        worker(con)
    elif a.cmd == "run":
        status, _ = run_steps(con, a.region, a.steps.split(","))
        sys.exit(0 if status == "done" else 2)
    elif a.cmd == "enqueue":
        jid = con.execute("insert into jobs (type, region_id, params, status) values ('refresh', %s, %s, 'queued') returning id",
                          (a.region, json.dumps({"steps": a.steps.split(",")}))).fetchone()[0]
        print(f"queued job {jid}")
    elif a.cmd == "enqueue-published":   # daily cron: one small job per published region, run one at a time
        for (rid,) in con.execute("select id from regions where status='published' order by id").fetchall():
            if not con.execute("select 1 from jobs where region_id=%s and status in ('queued','scheduled','running','paused_quota')", (rid,)).fetchone():
                con.execute("insert into jobs (type, region_id, params, status) values ('climate-topup', %s, %s, 'queued')",
                            (rid, json.dumps({"steps": a.steps.split(",")})))
                print(f"queued climate top-up for {rid}")


if __name__ == "__main__":
    main()
