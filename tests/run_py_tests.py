"""Runs tests/test_*.py with pytest when it is installed, else with a small runner that calls every
test_ function. The tests are written for pytest; the runner only exists so that `podcast test` needs
no extra package."""
from __future__ import annotations

import importlib.util
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run_plain() -> int:
    failed = total = 0
    for file in sorted(HERE.glob("test_*.py")):
        spec = importlib.util.spec_from_file_location(file.stem, file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name in [n for n in dir(module) if n.startswith("test_") and callable(getattr(module, n))]:
            total += 1
            try:
                getattr(module, name)()
                sys.stdout.write(f"ok   {file.name}::{name}\n")
            except Exception:  # a failing test must not stop the others
                failed += 1
                sys.stdout.write(f"FAIL {file.name}::{name}\n{traceback.format_exc()}\n")
    sys.stdout.write(f"python tests: {total - failed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    if importlib.util.find_spec("pytest"):
        import pytest
        sys.exit(pytest.main(["-q", str(HERE)]))
    sys.exit(run_plain())
