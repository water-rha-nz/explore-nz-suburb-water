import os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from nzsw.cli import Reporter


class FakeCon:
    def __init__(self): self.writes = []
    def execute(self, sql, args): self.writes.append(args)


def test_throttles_and_keeps_latest_lines():
    con, out = FakeCon(), []
    r = Reporter(con, 7, out.append, every=0.2)
    for i in range(30):
        r(f"line {i}")
    assert len(out) == 30                       # every line still goes to the worker log
    assert len(con.writes) == 1                 # but the database gets at most one write per interval
    time.sleep(0.25); r.progress(0.5, "half")
    detail, frac, run_id = con.writes[-1]
    assert run_id == 7 and frac == 0.5 and detail.endswith("half") and len(detail.split("\n")) == 12


def test_progress_is_clamped_and_needs_a_run():
    con = FakeCon(); r = Reporter(con, None, lambda m: None, every=0)
    r.progress(3, "x"); assert con.writes == [] and r.frac == 1.0
    r2 = Reporter(con, 1, lambda m: None, every=0); r2.progress(-1); assert con.writes[-1][1] == 0.0


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_"):
            _f()
    print("all reporter tests passed")
