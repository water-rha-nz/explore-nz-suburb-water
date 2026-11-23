"""Database access for the worker: connection, a Postgres-backed usage ledger (survives ephemeral runners),
and rate settings synced from app_settings.rates (set in the app's download panel)."""
import json, os, tempfile, datetime as dt
import psycopg
from . import limits as L


def connect(url=None):
    url = url or os.environ.get("SUPABASE_DB_URL") or open(os.path.expanduser("~/.config/supabase/worker_db_url")).read().strip()
    c = psycopg.connect(url, autocommit=True, connect_timeout=30)
    c.execute("set search_path = public, extensions")
    return c


class DbLedger:
    """Same interface as limits.Ledger, stored in the api_usage table (per service, UTC day/hour)."""

    def __init__(self, con):
        self.con = con

    @staticmethod
    def _buckets():
        now = dt.datetime.now(dt.timezone.utc)
        return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%dT%H")

    def used(self, service, period="day"):
        b = self._buckets()[0 if period == "day" else 1]
        r = self.con.execute("select cost from api_usage where service=%s and period=%s and bucket=%s", (service, period, b)).fetchone()
        return float(r[0]) if r else 0.0

    def add(self, service, cost, nbytes=0):
        day, hour = self._buckets()
        for period, b in (("day", day), ("hour", hour)):
            self.con.execute("""insert into api_usage (service, period, bucket, cost, bytes) values (%s,%s,%s,%s,%s)
                                on conflict (service, period, bucket) do update set cost = api_usage.cost + excluded.cost,
                                bytes = api_usage.bytes + excluded.bytes""", (service, period, b, cost, nbytes if period == "day" else 0))

    def bytes_today(self, service):
        r = self.con.execute("select bytes from api_usage where service=%s and period='day' and bucket=%s", (service, self._buckets()[0])).fetchone()
        return int(r[0]) if r else 0

    def remaining(self, service, period="day"):
        lim = L.effective(service).get("budget_" + period, L.SERVICES[service].get("budget_" + period))
        return None if lim is None else max(0.0, lim - self.used(service, period))


def sync_rates(con):
    """Write app_settings.rates to a private temp file that limits.effective() reads (clamped to ceilings there)."""
    r = con.execute("select value from app_settings where key='rates'").fetchone()
    path = os.path.join(tempfile.gettempdir(), "nzsw_rates.json")
    with open(path, "w") as f:
        json.dump(r[0] if r else {}, f)
    os.environ["NZSW_RATES"] = path
    L.RATES_FILE = path
    L._rates_cache["mtime"] = None
    return r[0] if r else {}
