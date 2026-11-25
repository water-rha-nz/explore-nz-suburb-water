import os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("NZSW_DEADLINE_S", "60")
from nzsw.prepare import _pool_x, _fit_logistic, _predict, _pr


def synth(n, seed):
    """Pools: high water index, blue-green, compact. Look-alikes (blue roofs, tarps): blue but low water index and very rectangular."""
    rng = np.random.default_rng(seed); X, y = [], []
    for i in range(n):
        pool = i % 2 == 0
        f = dict(ndwi=rng.normal(0.55 if pool else 0.2, 0.08), r=rng.normal(60 if pool else 90, 15), g=rng.normal(170 if pool else 140, 15),
                 b=rng.normal(190 if pool else 170, 15), n=rng.normal(50 if pool else 120, 20), solidity=rng.normal(0.9, 0.05), rectfill=rng.normal(0.7 if pool else 0.9, 0.08))
        X.append(_pool_x(f, rng.uniform(15, 60))); y.append(1 if pool else 0)
    return np.array(X), np.array(y)


def test_features_from_stored_json():
    assert len(_pool_x('{"ndwi": 0.5, "r": 51, "g": 102, "b": 153, "n": 0, "solidity": 0.9, "rectfill": 0.7}', 30)) == 10


def test_model_learns_and_beats_chance_on_held_back_data():
    X, y = synth(200, 1); Xt, yt = synth(80, 2)
    m = _fit_logistic(X, y.astype(float))
    p, r = _pr((_predict(m, Xt) >= 0.5).astype(int), yt)
    assert p > 0.9 and r > 0.9, (p, r)


def test_precision_recall_counts():
    p, r = _pr(np.array([1, 1, 0, 0]), np.array([1, 0, 1, 0]))
    assert p == 0.5 and r == 0.5


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_"):
            _f()
    print("all model tests passed")
