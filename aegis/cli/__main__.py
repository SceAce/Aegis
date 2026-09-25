"""`python -m aegis.cli` entry point (the package replaced the old cli.py)."""

from aegis.cli.main import main

if __name__ == "__main__":
    raise SystemExit(main())
