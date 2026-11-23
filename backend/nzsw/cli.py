"""nzsw worker CLI (docs/SPEC.md section 17).
  python -m nzsw.cli worker            claim and run queued jobs until none are runnable
  python -m nzsw.cli run <region> [--steps climate,census,publish]    run steps for one region directly
  python -m nzsw.cli enqueue <region> [--steps ...]                   queue a job (for cron: climate top-up)
One region per job; every external call goes through limits.Client; budgets live in api_usage."""
import argparse, datetime as dt, json, sys, traceback
from . import limits as L
from .db import connect, DbLedger, sync_rates
from .steps import STEPS

DEFAULT_STEPS = ["climate", "census", "publish"]


def run_steps(con, region, steps, job_id=None, log=print):
    sync_rates(con)
    client = L.Client(ledger=DbLedger(con), log=log)
    if con.execute("select count(*) from regions where id=%s", (region,)).fetchone()[0] != 1:
        raise ValueError(f"unknown region {region!r}")   # one region per run; no national/multi-region path exists
    results = {}
    for s in steps:
        if s not in STEPS:
            raise ValueError(f"unknown step {s!r} (available: {', '.join(STEPS)})")
        t0 = dt.datetime.now(dt.timezone.utc)
        run_id = con.execute("insert into job_runs (job_id, step, status) values (%s,%s,'running') returning id", (job_id, s)).fetchone()[0] if job_id else None
        try:
            msg = STEPS[s](con, client, region, log)
            status = "done"
        except (L.QuotaExceeded, L.ServicePaused) as e:
            msg, status = str(e), "paused_quota"
        except L.RunTooLarge as e:
            msg, status = str(e), "failed"
        except Exception as e:  # noqa: BLE001
            msg, status = f"{type(e).__name__}: {e}", "failed"
            log(traceback.format_exc(limit=3))
        if run_id:
            con.execute("update job_runs set status=%s, finished_at=now(), log=%s where id=%s", (status, msg[:4000], run_id))
        log(f"[{region}] {s}: {status}: {msg}")
        results[s] = dict(status=status, message=msg, seconds=round((dt.datetime.now(dt.timezone.utc) - t0).total_seconds(), 1))
        if status != "done":
            return status, results
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
