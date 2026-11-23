import datetime as dt
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from nzsw.steps import climate_ranges

D = dt.date


def test_empty_cell_fetches_whole_period():
    assert climate_ranges(None, None, "2013-01-01", "2026-11-21") == [("2013-01-01", "2026-11-21")]


def test_fills_gap_before_and_after_stored_data():
    assert climate_ranges(D(2020, 1, 1), D(2026, 11, 1), "2013-01-01", "2026-11-21") == [("2013-01-01", "2019-12-31"), ("2026-11-02", "2026-11-21")]


def test_nothing_when_covered_or_inside_stored_period():
    assert climate_ranges(D(2013, 1, 1), D(2026, 11, 21), "2013-01-01", "2026-11-21") == []
    assert climate_ranges(D(2013, 1, 1), D(2026, 11, 21), "2018-01-01", "2020-12-31") == []


def test_reversed_period_fetches_nothing():
    assert climate_ranges(None, None, "2026-01-01", "2025-01-01") == []


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_"):
            _f()
    print("all timeline tests passed")
