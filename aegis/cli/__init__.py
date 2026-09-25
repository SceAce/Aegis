"""CLI layer.

`main` is re-exported so the console script entry point (`aegis.cli:main`) keeps
working unchanged, and so `python -m aegis.cli` resolves to the package.
"""

from aegis.cli.main import main

__all__ = ["main"]
