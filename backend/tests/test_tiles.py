import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("NZSW_DEADLINE_S", "60")
from nzsw.prepare import tile_box


def test_first_tile_of_a_sheet_starts_at_the_sheet_corner():
    b = tile_box("AY30_1000_0101").bounds                    # sheet AY (row 6) 30: corner E 988000 + 30*24000, N 6234000 - 6*36000
    assert (round(b[0]), round(b[3])) == (988000 + 30 * 24000, 6234000 - 6 * 36000)
    assert round(b[2] - b[0]) == 480 and round(b[3] - b[1]) == 720


def test_tile_size_scales_and_index_moves_east_and_south():
    a, b = tile_box("BD37_5000_0101").bounds, tile_box("BD37_5000_0203").bounds
    assert round(a[2] - a[0]) == 2400 and round(a[3] - a[1]) == 3600
    assert round(b[0] - a[0]) == 2 * 2400 and round(a[3] - b[3]) == 3600   # column 3 is two tiles east, row 2 one tile south


def test_unknown_names_are_ignored():
    assert tile_box("collection") is None and tile_box("ZZ01_1000_0101") is None


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_"):
            _f()
    print("all tile tests passed")
