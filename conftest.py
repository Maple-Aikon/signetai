import sys
from pathlib import Path

packages = Path(__file__).resolve().parent / "packages"
sys.path.insert(0, str(packages))
