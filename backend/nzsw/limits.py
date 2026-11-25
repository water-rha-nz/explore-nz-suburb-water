"""Usage limits for every external service (docs/SPEC.md section 20).

The app must run on the services' FREE keys/tiers, one region at a time. This module:
  * estimates the cost of a run before it starts (preflight) and refuses runs that don't fit
    the remaining daily budget or exceed the per-run region caps (no multi-region / national runs);
  * paces requests per service (minimum interval, no parallel requests per key);
  * counts every call in a persistent ledger (per service, per UTC day; Open-Meteo calls are
    weighted the way Open-Meteo counts them);
  * handles throttling: honours Retry-After on 429/503, otherwise exponential backoff with jitter,
    and opens a circuit breaker after repeated throttling so the service is paused (the job is
    parked as 'paused_quota' and resumes later; all steps are idempotent).

Budgets are deliberately below the published free limits, so a shared key or a second user
never pushes the project over.
"""
from __future__ import annotations
import json, math, os, random, threading, time, datetime as dt
from dataclasses import dataclass, field

# ------------------------------------------------------------------ service limits
# published: the provider's documented free-tier limit (None = not published; fair use)
# budget_day: what this app allows itself per UTC day (well below `published`)
# min_interval_s: pacing between requests (one request at a time per service)
SERVICES = {
    "openmeteo": dict(published="600/min, 5,000/h, 10,000/day (weighted)", budget_day=6000, budget_hour=3000, min_interval_s=1.0,
                      note="Weighted: a call counts n_locations x max(1, vars/10) x max(1, days/14)"),
    "linz_wfs": dict(published="none published; 3,000 features/request default; <=250,000 features/request advised",
                     budget_day=1500, budget_hour=None, min_interval_s=1.0, page_size=10000, max_features_run=400_000),
    "statsnz_datafinder": dict(published="none published (same platform as LINZ)", budget_day=300, budget_hour=None, min_interval_s=1.0, page_size=10000),
    "statsnz_ade": dict(published="none published; fair use, shared keys may be throttled", budget_day=400, budget_hour=None, min_interval_s=2.0),
    "linz_imagery_s3": dict(published="public AWS Open Data bucket, no key", budget_day=None, budget_hour=None, min_interval_s=0.0,
                            max_tiles_run=700, max_bytes_day=25 * 1024**3, max_parallel=4),
}

# ------------------------------------------------------------------ adjustable rates (download progress panel)
# Users with the editor role can raise a service's rate or budget while a download runs, but never above
# the ceiling: the published free-tier limit where one exists, otherwise a conservative fair-use maximum.
# The default is what the app uses when nobody has changed anything.
#   per_min: requests per minute (pacing); budget_day / budget_hour: weighted calls; parallel: concurrent reads
DEFAULTS = {
    "openmeteo": dict(per_min=60, budget_day=6000, budget_hour=3000),
    "linz_wfs": dict(per_min=60, budget_day=1500),
    "statsnz_datafinder": dict(per_min=60, budget_day=300),
    "statsnz_ade": dict(per_min=30, budget_day=400),
    "linz_imagery_s3": dict(parallel=4, bytes_day=25 * 1024**3),
}
CEILINGS = {
    "openmeteo": dict(per_min=600, budget_day=9500, budget_hour=4750),     # published: 600/min, 5,000/h, 10,000/day
    "linz_wfs": dict(per_min=240, budget_day=5000),                         # not published: conservative fair use
    "statsnz_datafinder": dict(per_min=240, budget_day=1000),               # not published (same platform as LINZ)
    "statsnz_ade": dict(per_min=120, budget_day=1500),                      # not published; shared keys get throttled
    "linz_imagery_s3": dict(parallel=8, bytes_day=60 * 1024**3),            # public bucket, no key
}
RATES_FILE = os.environ.get("NZSW_RATES", os.path.expanduser("~/.config/nzsw/rates.json"))
_rates_cache = {"mtime": None, "data": {}}


def _load_rates(path=None):
    path = path or RATES_FILE
    try:
        m = os.path.getmtime(path)
    except OSError:
        return {}
    if _rates_cache["mtime"] != (path, m):
        try:
            _rates_cache.update(mtime=(path, m), data=json.load(open(path)))
        except ValueError:
            return {}
    return _rates_cache["data"]


def effective(service, path=None):
    """Current settings for a service: defaults, overridden by the rates file, clamped to the ceilings."""
    out = dict(DEFAULTS.get(service, {}))
    for k, v in (_load_rates(path).get(service) or {}).items():
        if k in CEILINGS.get(service, {}) and isinstance(v, (int, float)) and v > 0:
            out[k] = min(v, CEILINGS[service][k])
    return out


def set_rate(service, path=None, reason="user", **values):
    """Change a service's rate/budget (from the download progress panel). Values above the ceiling are clamped.
    Returns the settings now in force."""
    path = path or RATES_FILE
    if service not in CEILINGS:
        raise KeyError(service)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = _load_rates(path).copy()
    cur = dict(data.get(service) or {})
    clamped = {}
    for k, v in values.items():
        if k not in CEILINGS[service]:
            raise KeyError(f"{service}: {k} is not adjustable (allowed: {', '.join(CEILINGS[service])})")
        cur[k] = min(float(v), CEILINGS[service][k])
        if float(v) > CEILINGS[service][k]:
            clamped[k] = CEILINGS[service][k]
    cur["changed_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    cur["reason"] = reason
    data[service] = cur
    tmp = path + ".tmp"
    json.dump(data, open(tmp, "w"), indent=1)
    os.replace(tmp, path)
    _rates_cache["mtime"] = None
    eff = effective(service, path)
    if clamped:
        eff["clamped_to_ceiling"] = clamped
    return eff


def min_interval(service, path=None):
    pm = effective(service, path).get("per_min")
    return 60.0 / pm if pm else 0.0


# per-run region caps: a run is one TA, or a subset of a TA's suburbs when the TA is too big
RUN_CAPS = dict(max_tas_per_run=1, max_sa2_per_run=80, max_suburbs_per_run=60,
                max_climate_cells_per_run=12, climate_backfill_start="2013-01-01")

RETRY_STATUSES = {429, 502, 503, 504}
MAX_RETRIES = 5
BACKOFF_BASE_S = 5.0
BACKOFF_CAP_S = 600.0
BREAKER_THRESHOLD = 3          # throttled responses within BREAKER_WINDOW_S -> pause the service
BREAKER_WINDOW_S = 900.0
BREAKER_PAUSE_S = 6 * 3600.0


class QuotaExceeded(RuntimeError):
    """The daily/hourly budget would be exceeded: stop and resume later (job -> paused_quota)."""


class RunTooLarge(ValueError):
    """The requested run is bigger than one region allows: split it by suburbs."""


class ServicePaused(RuntimeError):
    """Circuit breaker open after repeated throttling."""


# ------------------------------------------------------------------ cost models
def openmeteo_weight(n_locations: int, n_vars: int, start: str, end: str) -> float:
    """Open-Meteo's counting: >10 variables or >2 weeks per location count fractionally as more calls."""
    days = (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days + 1
    return n_locations * max(1.0, n_vars / 10) * max(1.0, days / 14)


def snap_cells(points, res=0.1):
    """Group points by (approximate) model grid cell without calling the API, so each cell is requested once."""
    cells = {}
    for i, (lat, lon) in enumerate(points):
        cells.setdefault((round(lat / res) * res, round(lon / res) * res), []).append(i)
    return cells


# ------------------------------------------------------------------ ledger
class Ledger:
    """Persistent per-day usage. Local: JSON file. In production the same interface writes the `api_usage` table."""

    def __init__(self, path=None):
        self.path = path or os.environ.get("NZSW_LEDGER", os.path.expanduser("~/.cache/nzsw/api_usage.json"))
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.lock = threading.Lock()

    def _load(self):
        try:
            return json.load(open(self.path))
        except (OSError, ValueError):
            return {}

    def used(self, service, period="day"):
        now = dt.datetime.now(dt.timezone.utc)
        key = now.strftime("%Y-%m-%d") if period == "day" else now.strftime("%Y-%m-%dT%H")
        return self._load().get(service, {}).get(period, {}).get(key, 0.0)

    def add(self, service, cost, nbytes=0):
        now = dt.datetime.now(dt.timezone.utc)
        with self.lock:
            d = self._load()
            s = d.setdefault(service, {})
            for period, key in (("day", now.strftime("%Y-%m-%d")), ("hour", now.strftime("%Y-%m-%dT%H"))):
                s.setdefault(period, {})
                s[period][key] = round(s[period].get(key, 0.0) + cost, 3)
            if nbytes:
                b = s.setdefault("bytes_day", {})
                b[now.strftime("%Y-%m-%d")] = b.get(now.strftime("%Y-%m-%d"), 0) + nbytes
            # keep 14 days
            for period in ("day", "hour", "bytes_day"):
                if period in s:
                    for k in sorted(s[period])[:-14 * (24 if period == "hour" else 1)]:
                        del s[period][k]
            tmp = self.path + ".tmp"
            json.dump(d, open(tmp, "w"), indent=1)
            os.replace(tmp, self.path)

    def bytes_today(self, service):
        return self._load().get(service, {}).get("bytes_day", {}).get(dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"), 0)

    def remaining(self, service, period="day"):
        lim = effective(service).get("budget_" + period, SERVICES[service].get("budget_" + period))
        return None if lim is None else max(0.0, lim - self.used(service, period))


# ------------------------------------------------------------------ guarded client
@dataclass
class Client:
    ledger: Ledger = field(default_factory=Ledger)
    sleep: callable = time.sleep
    log: callable = print
    _last: dict = field(default_factory=dict)
    _throttled: dict = field(default_factory=dict)
    _paused_until: dict = field(default_factory=dict)

    def check_budget(self, service, cost):
        """Day budget short -> QuotaExceeded (park the job until tomorrow).
        Hour budget short -> wait for the next hour (the run continues).
        A single request larger than the hourly budget can never fit -> QuotaExceeded (split it)."""
        hb = effective(service).get("budget_hour", SERVICES[service].get("budget_hour"))
        if hb is not None and cost > hb:
            raise QuotaExceeded(f"{service}: one request costs {cost:.1f}, more than the hourly budget {hb}: split it "
                                f"(fewer locations or a shorter period per request)")
        rem = self.ledger.remaining(service, "day")
        if rem is not None and cost > rem:
            raise QuotaExceeded(f"{service}: needs {cost:.1f}, {rem:.1f} left today "
                                f"(budget {effective(service).get('budget_day')}; published {SERVICES[service]['published']})")
        rem = self.ledger.remaining(service, "hour")
        if rem is not None and cost > rem:
            now = dt.datetime.now(dt.timezone.utc)
            wait = 3600 - (now.minute * 60 + now.second) + 5
            self.log(f"{service}: hourly budget used ({rem:.1f} left, need {cost:.1f}); waiting {wait / 60:.0f} min for the next hour")
            self.sleep(wait)

    def _pace(self, service):
        gap = min_interval(service)
        wait = self._last.get(service, 0) + gap - time.monotonic()
        if wait > 0:
            self.sleep(wait)
        self._last[service] = time.monotonic()

    def _note_throttle(self, service):
        # a raised rate that gets throttled is halved automatically (never below the default)
        eff = effective(service)
        if "per_min" in eff and eff["per_min"] > DEFAULTS[service]["per_min"]:
            new = max(DEFAULTS[service]["per_min"], eff["per_min"] / 2)
            set_rate(service, reason="auto: throttled", per_min=new)
            self.log(f"{service}: throttled at {eff['per_min']:.0f}/min; rate lowered to {new:.0f}/min")
        now = time.monotonic()
        hist = [t for t in self._throttled.get(service, []) if now - t < BREAKER_WINDOW_S] + [now]
        self._throttled[service] = hist
        if len(hist) >= BREAKER_THRESHOLD:
            self._paused_until[service] = now + BREAKER_PAUSE_S
            raise ServicePaused(f"{service}: throttled {len(hist)} times in {BREAKER_WINDOW_S / 60:.0f} min; paused for "
                                f"{BREAKER_PAUSE_S / 3600:.0f} h. The job is parked and resumes later.")

    def request(self, service, method, url, *, cost=1.0, session=None, redact=lambda s: s, **kw):
        """Budget check -> pace -> send -> retry/backoff on throttling -> record cost. Returns the response."""
        import requests
        if self._paused_until.get(service, 0) > time.monotonic():
            raise ServicePaused(f"{service}: paused after repeated throttling")
        self.check_budget(service, cost)
        http = session or requests
        timeout = kw.pop("timeout", 300)
        for attempt in range(MAX_RETRIES + 1):
            self._pace(service)
            try:
                r = http.request(method, url, timeout=timeout, **kw)
            except (requests.ConnectionError, requests.Timeout) as e:   # DNS blips, resets, timeouts: retry with backoff
                self.ledger.add(service, 1.0)
                if attempt == MAX_RETRIES:
                    raise
                delay = min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** attempt) * (0.5 + random.random() / 2)
                self.log(f"{service}: {type(e).__name__}, retry {attempt + 1}/{MAX_RETRIES} in {delay:.0f}s")
                self.sleep(delay)
                continue
            # count every attempt: providers count requests, not successes
            self.ledger.add(service, cost if attempt == 0 else 1.0, nbytes=len(r.content or b""))
            if r.status_code not in RETRY_STATUSES:
                return r
            if r.status_code == 429 or (r.status_code == 503 and "slow" in (r.text or "").lower()):
                self._note_throttle(service)
            ra = r.headers.get("Retry-After")
            if ra is not None:
                try:
                    delay = float(ra)
                except ValueError:
                    try:
                        delay = max(0.0, (dt.datetime.strptime(ra, "%a, %d %b %Y %H:%M:%S GMT").replace(tzinfo=dt.timezone.utc)
                                          - dt.datetime.now(dt.timezone.utc)).total_seconds())
                    except ValueError:
                        delay = BACKOFF_BASE_S
            else:
                delay = min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** attempt) * (0.5 + random.random() / 2)
            if r.status_code == 504:
                self.log(f"{service}: 504 timeout; reduce page size (count) for large layers")
            self.log(f"{service}: HTTP {r.status_code}, retry {attempt + 1}/{MAX_RETRIES} in {delay:.0f}s ({redact(url)[:80]})")
            if attempt == MAX_RETRIES:
                break
            self.sleep(delay)
        raise QuotaExceeded(f"{service}: still throttled after {MAX_RETRIES} retries ({redact(url)[:80]})")

    def imagery_allowance(self, n_tiles, est_bytes):
        lim = SERVICES["linz_imagery_s3"]
        if n_tiles > lim["max_tiles_run"]:
            raise RunTooLarge(f"{n_tiles} imagery tiles exceeds {lim['max_tiles_run']} per run: split the region by suburbs")
        cap = effective("linz_imagery_s3")["bytes_day"]
        if self.ledger.bytes_today("linz_imagery_s3") + est_bytes > cap:
            raise QuotaExceeded(f"imagery: {est_bytes / 1e9:.1f} GB would exceed {cap / 1e9:.0f} GB/day")


# ------------------------------------------------------------------ preflight
def preflight(*, n_tas, n_sa2, n_suburbs, n_climate_cells, climate_start, climate_end, est_features, n_tiles=None,
              ledger: Ledger | None = None, climate_vars=4):
    """Estimate a run's cost per service and check it against caps and remaining budgets.
    Returns a dict with per-service cost, remaining budget, and a list of problems (empty = may run)."""
    led = ledger or Ledger()
    caps = RUN_CAPS
    problems = []
    if n_tas > caps["max_tas_per_run"]:
        problems.append(f"{n_tas} TAs requested: runs are limited to one region (no multi-region or national runs)")
    if n_sa2 > caps["max_sa2_per_run"]:
        problems.append(f"{n_sa2} SA2s exceeds {caps['max_sa2_per_run']} per run: split by suburbs")
    if n_suburbs > caps["max_suburbs_per_run"]:
        problems.append(f"{n_suburbs} suburbs exceeds {caps['max_suburbs_per_run']} per run: split by suburbs")
    if n_climate_cells > caps["max_climate_cells_per_run"]:
        problems.append(f"{n_climate_cells} climate cells exceeds {caps['max_climate_cells_per_run']} per run")
    if est_features > SERVICES["linz_wfs"]["max_features_run"]:
        problems.append(f"~{est_features:,} LINZ features exceeds {SERVICES['linz_wfs']['max_features_run']:,} per run: split by suburbs")
    ps = SERVICES["linz_wfs"]["page_size"]
    cost = {
        "linz_wfs": 1 + 4 * max(1, math.ceil(est_features / 4 / ps)),          # suburbs + 4 paged layers
        "statsnz_datafinder": max(1, math.ceil(n_sa2 / 150)),
        "statsnz_ade": 4 * max(1, math.ceil(n_sa2 / 150)) + 4,                   # 4 tables (+ structure lookups)
        "openmeteo": round(openmeteo_weight(n_climate_cells, climate_vars, climate_start, climate_end), 1),
    }
    out = {}
    for s, c in cost.items():
        rem = led.remaining(s, "day")
        ok = rem is None or c <= rem
        if not ok:
            problems.append(f"{s}: estimated {c:,.0f} calls but {rem:,.0f} left today: schedule for tomorrow")
        out[s] = dict(estimated_calls=c, remaining_today=rem, budget_day=SERVICES[s]["budget_day"], fits=ok)
    if n_tiles is not None and n_tiles > SERVICES["linz_imagery_s3"]["max_tiles_run"]:
        problems.append(f"{n_tiles} imagery tiles exceeds {SERVICES['linz_imagery_s3']['max_tiles_run']} per run")
    return dict(services=out, problems=problems, may_run=not problems)
